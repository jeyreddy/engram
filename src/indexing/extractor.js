import { readFile } from 'fs/promises';
import { extname } from 'path';
import { createRequire } from 'module';

// CJS packages that don't ship a named ESM entrypoint
const require = createRequire(import.meta.url);

// pdfjs-dist (bundled inside pdf-parse) requires DOMMatrix which is a
// browser/worker API not available in Electron's main process. Polyfill it
// before requiring pdf-parse so the module evaluates without crashing.
if (typeof globalThis.DOMMatrix === 'undefined') {
  globalThis.DOMMatrix = class DOMMatrix {
    constructor(init) {
      this.a = 1; this.b = 0; this.c = 0; this.d = 1; this.e = 0; this.f = 0;
      this.m11 = 1; this.m12 = 0; this.m13 = 0; this.m14 = 0;
      this.m21 = 0; this.m22 = 1; this.m23 = 0; this.m24 = 0;
      this.m31 = 0; this.m32 = 0; this.m33 = 1; this.m34 = 0;
      this.m41 = 0; this.m42 = 0; this.m43 = 0; this.m44 = 1;
      this.is2D = true; this.isIdentity = true;
      if (Array.isArray(init)) {
        if (init.length === 6) {
          [this.a, this.b, this.c, this.d, this.e, this.f] = init;
          this.m11 = this.a; this.m12 = this.b;
          this.m21 = this.c; this.m22 = this.d;
          this.m41 = this.e; this.m42 = this.f;
        } else if (init.length === 16) {
          [this.m11, this.m12, this.m13, this.m14,
           this.m21, this.m22, this.m23, this.m24,
           this.m31, this.m32, this.m33, this.m34,
           this.m41, this.m42, this.m43, this.m44] = init;
        }
      }
    }
    multiply()       { return new DOMMatrix(); }
    inverse()        { return new DOMMatrix(); }
    translate(tx = 0, ty = 0) {
      const m = new DOMMatrix([this.a, this.b, this.c, this.d, this.e + tx, this.f + ty]);
      return m;
    }
    scale(sx = 1, sy = sx)   { return new DOMMatrix([this.a * sx, this.b, this.c, this.d * sy, this.e, this.f]); }
    rotate()         { return new DOMMatrix(); }
    transformPoint(pt = {}) { return { x: pt.x ?? 0, y: pt.y ?? 0, z: pt.z ?? 0, w: pt.w ?? 1 }; }
  };
}

const pdfParse = require('pdf-parse');
const mammoth  = require('mammoth');
const XLSX     = require('xlsx');

// ---------------------------------------------------------------------------
// Text extraction
// ---------------------------------------------------------------------------

const EXTRACTORS = {
  '.pdf':  extractPdf,
  '.docx': extractWord,
  '.doc':  extractWord,
  '.xlsx': extractExcel,
  '.xls':  extractExcel,
  '.txt':  extractPlain,
  '.md':   extractPlain,
};

async function extractPdf(filePath) {
  const buffer = await readFile(filePath);
  const result = await pdfParse(buffer);
  const text   = (result.text ?? '').trim();
  if (!text) {
    return { text: '', method: 'pdf', ocrRequired: true };
  }
  return { text, method: 'pdf', ocrRequired: false };
}

async function extractWord(filePath) {
  const result = await mammoth.extractRawText({ path: filePath });
  return { text: (result.value ?? '').trim(), method: 'word', ocrRequired: false };
}

function extractExcelText(filePath) {
  const workbook = XLSX.readFile(filePath);
  const lines = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const rows  = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      defval: null,   // null so we can distinguish truly empty from ''
      blankrows: true, // keep all rows so index positions stay stable
    });

    if (rows.length === 0) continue;

    lines.push(`=== Sheet: ${sheetName} ===`);

    // Find header row: best row within first 15 with the most non-empty cells
    let headerRowIndex = 0;
    let bestCount = 0;
    for (let i = 0; i < Math.min(15, rows.length); i++) {
      const count = rows[i].filter(c => c !== null && String(c).trim() !== '').length;
      if (count > bestCount) {
        bestCount = count;
        headerRowIndex = i;
      }
    }

    const headers = rows[headerRowIndex].map(h =>
      h !== null ? String(h).trim() : ''
    );

    let dataRows = 0;

    // Process ALL rows after the header — skip fully empty, keep sparse
    for (let i = headerRowIndex + 1; i < rows.length; i++) {
      const row = rows[i];
      // Skip row only if every cell is null/empty
      const hasData = row.some(c => c !== null && String(c).trim() !== '');
      if (!hasData) continue;

      const parts = [];
      for (let j = 0; j < headers.length; j++) {
        const field = headers[j];
        const val   = row[j];
        const valStr = val !== null && val !== undefined ? String(val).trim() : '';
        if (field && valStr !== '') {
          parts.push(`${field}: ${valStr}`);
        }
      }
      if (parts.length > 0) {
        lines.push(parts.join(' | '));
        dataRows++;
      }
    }

    console.log(`[extractor] Sheet "${sheetName}": ${dataRows} data rows found`);
    lines.push('');
  }

  let text = lines.join('\n');

  console.log('[extractor] Sample rows:', text.slice(0, 500));

  if (text.length > 500_000) {
    text = text.slice(0, 500_000) + '\n[TRUNCATED - file too large]';
  }

  return text;
}

async function extractExcel(filePath) {
  return { text: extractExcelText(filePath), method: 'excel', ocrRequired: false };
}

async function extractPlain(filePath) {
  const text = await readFile(filePath, 'utf8');
  return { text: text.trim(), method: 'text', ocrRequired: false };
}

/**
 * Extract text from a document file.
 *
 * @param {string} filePath
 * @returns {Promise<{ text: string, method: string, ocrRequired: boolean }>}
 *   method: "pdf" | "word" | "excel" | "text" | "ocr_stub"
 */
export async function extractText(filePath) {
  const ext = extname(filePath).toLowerCase();
  const fn  = EXTRACTORS[ext];

  if (!fn) {
    return { text: '', method: 'ocr_stub', ocrRequired: true };
  }

  return fn(filePath);
}

// ---------------------------------------------------------------------------
// Tag reference extraction
// ---------------------------------------------------------------------------

const TAG_RE = /\b[A-Z]{1,4}-[0-9]{3,5}\b/g;

/**
 * Returns true if `value` looks like a real instrument tag number.
 *
 * Rejects common false positives that appear in engineering documents:
 *   - Wattage/power values  (e.g. "15W", "3.5W/ft", "10W/m")
 *   - Bare 1–2 digit numbers
 *   - ISO date strings      (e.g. "2024-03")
 *   - Empty / too-short strings
 *
 * Used wherever extracted_values rows are auto-registered as tags, to keep
 * the tag registry clean.
 *
 * @param {string|number|null|undefined} value
 * @returns {boolean}
 */
export function isValidTag(value) {
  if (!value) return false;
  const v = value.toString().trim();
  if (v.endsWith('W') && /^\d/.test(v)) return false;  // wattage: "15W"
  if (v.includes('W/ft')) return false;                 // heat trace: "3W/ft"
  if (v.includes('W/m'))  return false;                 // heat trace: "10W/m"
  if (/^\d{1,2}$/.test(v)) return false;                // bare 1–2 digit number
  if (/^\d{4}-\d{2}/.test(v)) return false;             // ISO date: "2024-03-…"
  if (v.length < 2) return false;
  return true;
}

/**
 * Find all instrument/tag references in text.
 * Pattern: one–four uppercase letters, hyphen, three–five digits (e.g. FT-1001).
 *
 * @param {string} text
 * @returns {string[]}  Unique tag numbers, in order of first appearance.
 */
export function extractTagReferences(text) {
  const matches = text.match(TAG_RE) ?? [];
  return [...new Set(matches)];
}

// ---------------------------------------------------------------------------
// Key-value extraction
// ---------------------------------------------------------------------------

/**
 * Each entry: regex whose capture group 1 is the raw value.
 * Patterns are tried case-insensitively.
 */
const FIELD_PATTERNS = {
  range: /\b(?:range|measurement[\s_]range|span)\s*[:\=]\s*([^\n\r]{1,80})/i,

  alarm_high:
    /\b(?:alarm[\s_]?high|hi(?:gh)?[\s_]?alarm|hi[\s_]?sp(?:et)?|(?:^|\s)AH\s*[:\=])\s*([^\n\r]{1,60})/i,

  alarm_low:
    /\b(?:alarm[\s_]?low|lo(?:w)?[\s_]?alarm|lo[\s_]?sp(?:et)?|(?:^|\s)AL\s*[:\=])\s*([^\n\r]{1,60})/i,

  alarm_hh:
    /\b(?:alarm[\s_]?hh|hi[\s_]?hi|hihi|high[\s_]?high|hh[\s_]?alarm)\s*[:\=]\s*([^\n\r]{1,60})/i,

  alarm_ll:
    /\b(?:alarm[\s_]?ll|lo[\s_]?lo|lolo|low[\s_]?low|ll[\s_]?alarm)\s*[:\=]\s*([^\n\r]{1,60})/i,

  output_signal:
    /\b(?:output[\s_]?signal|output[\s_]?type|signal[\s_]?type|output)\s*[:\=]\s*([^\n\r]{1,80})/i,

  fail_position:
    /\b(?:fail[\s_]?(?:position|safe|mode)|(?:^|\s)FS\s*[:\=])\s*([^\n\r]{1,60})/i,

  revision:
    /\b(?:rev(?:ision)?\.?)\s*[:\=\.\s]\s*([A-Za-z0-9](?:[A-Za-z0-9\.\-]{0,9}))/i,

  calibration_date:
    /\b(?:cal(?:ibration)?[\s_]?date|next[\s_]?cal(?:ibration)?|last[\s_]?cal(?:ibration)?)\s*[:\=]\s*([^\n\r]{1,40})/i,
};

const CONTEXT_RADIUS = 60;

/**
 * Extract key instrument-datasheet fields from document text.
 *
 * @param {string} text
 * @param {string} [docType]  Optional document type hint (unused in v1, reserved).
 * @returns {Array<{ field_name: string, field_value: string, context: string }>}
 */
export function extractKeyValues(text, docType) { // eslint-disable-line no-unused-vars
  const results = [];

  for (const [field_name, pattern] of Object.entries(FIELD_PATTERNS)) {
    const match = pattern.exec(text);
    if (!match) continue;

    const field_value = match[1].trim();
    if (!field_value) continue;

    const matchStart = match.index;
    const matchEnd   = matchStart + match[0].length;
    const ctxStart   = Math.max(0, matchStart - CONTEXT_RADIUS);
    const ctxEnd     = Math.min(text.length, matchEnd + CONTEXT_RADIUS);
    const context    = text.slice(ctxStart, ctxEnd).replace(/\s+/g, ' ').trim();

    results.push({ field_name, field_value, context });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Text chunking
// ---------------------------------------------------------------------------

/**
 * Split text into overlapping fixed-size character chunks.
 * Chunk boundaries are nudged to the nearest whitespace where possible.
 *
 * @param {string} text
 * @param {number} [chunkSize=512]
 * @param {number} [overlap=50]
 * @returns {string[]}
 */
/**
 * Parse pipe-delimited "Field: Value | Field: Value" lines produced by
 * extractExcelText into individual field/value pairs.
 *
 * @param {string} text
 * @returns {{ fieldName: string, fieldValue: string }[]}
 */
export function extractStructuredRows(text) {
  const pairs = [];
  const lines = text.split('\n');
  for (const line of lines) {
    const parts = line.split(' | ');
    for (const part of parts) {
      const colonIdx = part.indexOf(':');
      if (colonIdx === -1) continue;
      const fieldName  = part.slice(0, colonIdx).trim();
      const fieldValue = part.slice(colonIdx + 1).trim();
      if (
        fieldName &&
        fieldValue &&
        fieldValue !== '-' &&
        fieldValue !== '' &&
        fieldName !== '===' &&
        !fieldName.startsWith('===')
      ) {
        pairs.push({ fieldName, fieldValue });
      }
    }
  }
  return pairs;
}

export function chunkText(text, chunkSize = 512, overlap = 50) {
  if (!text || text.length === 0) return [];

  const step    = chunkSize - overlap;
  const chunks  = [];
  let start     = 0;

  while (start < text.length) {
    let end = start + chunkSize;

    if (end < text.length) {
      // Try to break at a whitespace so we don't cut mid-word
      const boundary = text.lastIndexOf(' ', end);
      if (boundary > start + Math.floor(step / 2)) {
        end = boundary;
      }
    } else {
      end = text.length;
    }

    const chunk = text.slice(start, end).trim();
    if (chunk.length > 0) chunks.push(chunk);

    start += step;
  }

  return chunks;
}
