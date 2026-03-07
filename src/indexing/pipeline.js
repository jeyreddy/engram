import { createHash } from 'crypto';
import { createReadStream } from 'fs';
import { readdir } from 'fs/promises';
import { extname, basename, join } from 'path';

import { getConfig, setConfig } from '../db/workspace.js';
import { addDocument, deleteDocument } from '../ai/vectorstore.js';
import { extractText, extractKeyValues, chunkText } from './extractor.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const SUPPORTED_EXTENSIONS = new Set([
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.txt', '.md',
]);

/**
 * Recursively collect all file paths under a directory.
 *
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function walkDir(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files   = [];

  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkDir(full));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }

  return files;
}

const INSERT_DOCUMENT = `
  INSERT INTO documents (title, file_path, file_type, tag_id, checksum, revision, status)
  VALUES (?, ?, ?, ?, ?, ?, 'active')
  ON CONFLICT(file_path) DO UPDATE SET
    title      = excluded.title,
    tag_id     = excluded.tag_id,
    checksum   = excluded.checksum,
    revision   = excluded.revision,
    file_type  = excluded.file_type,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  RETURNING id
`;

const INSERT_KV = `
  INSERT INTO extracted_values (document_id, field_name, field_value)
  VALUES (?, ?, ?)
`;

/**
 * Append a file path to the "ocr_queue" workspace_config entry (JSON array).
 * De-duplicates automatically.
 */
function enqueueOcr(db, filePath) {
  const raw   = getConfig(db, 'ocr_queue');
  const queue = raw ? JSON.parse(raw) : [];
  if (!queue.includes(filePath)) {
    queue.push(filePath);
    setConfig(db, 'ocr_queue', JSON.stringify(queue));
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute the SHA-256 checksum of a file.
 *
 * @param {string} filePath
 * @returns {Promise<string>}  Lowercase hex digest.
 */
export function computeChecksum(filePath) {
  return new Promise((resolve, reject) => {
    const hash   = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data',  chunk => hash.update(chunk));
    stream.on('end',   ()    => resolve(hash.digest('hex')));
    stream.on('error', err   => reject(err));
  });
}

/**
 * Index a single file: extract text, embed chunks, persist to SQLite + vectra.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {import('vectra').LocalIndex}       store
 * @param {string}  filePath
 * @param {number|null} tagId
 * @param {string|null} docType
 * @param {{
 *   area?:       string,
 *   discipline?: string,
 *   revision?:   string,
 * }} [metadata]
 * @returns {Promise<{ docId: number, chunksIndexed: number, ocrRequired: boolean }>}
 */
export async function indexFile(db, store, filePath, tagId, docType, metadata = {}) {
  console.log('[pipeline] indexFile called for:', filePath);
  // 1. Checksum
  const checksum = await computeChecksum(filePath);

  // 2. Extract text
  const { text, ocrRequired } = await extractText(filePath);

  // 3. Parse field values
  const keyValues = extractKeyValues(text, docType);

  // 4. Derive revision (prefer extracted, fall back to caller-supplied)
  const revEntry = keyValues.find(kv => kv.field_name === 'revision');
  const revision = revEntry?.field_value ?? metadata.revision ?? null;

  // 5. Upsert document row, get back its id
  const title    = basename(filePath);
  const fileType = extname(filePath).slice(1).toLowerCase() || 'unknown';

  const row = db.prepare(INSERT_DOCUMENT)
    .get(title, filePath, fileType, tagId ?? null, checksum, revision);

  const docId = row.id;

  // 6. Replace extracted key-value rows (CASCADE keeps orphans clean on delete,
  //    but we need to refresh them on re-index too).
  db.prepare('DELETE FROM extracted_values WHERE document_id = ?').run(docId);

  if (keyValues.length > 0) {
    const insertKV  = db.prepare(INSERT_KV);
    const insertAll = db.transaction(rows => {
      for (const kv of rows) insertKV.run(docId, kv.field_name, kv.field_value);
    });
    insertAll(keyValues);
  }

  // 7. OCR queue
  if (ocrRequired) {
    enqueueOcr(db, filePath);
    console.warn(`[pipeline] OCR required — queued: ${filePath}`);
  }

  // 8. Remove stale vectors, then embed and store each chunk
  await deleteDocument(store, docId);

  let chunksIndexed = 0;

  if (text.length > 0) {
    const chunks = chunkText(text);

    for (let i = 0; i < chunks.length; i++) {
      await addDocument(store, docId, chunks[i], {
        text:        chunks[i],
        tag_id:      tagId      ?? null,
        doc_type:    docType    ?? null,
        filename:    basename(filePath),
        revision,
        area:        metadata.area       ?? null,
        discipline:  metadata.discipline ?? null,
        chunk_index: i,
      });
      chunksIndexed++;
    }
  }

  console.log('[pipeline] returning:', JSON.stringify({ docId, chunksIndexed, ocrRequired }));
  return { docId, chunksIndexed, ocrRequired };
}

/**
 * Index all supported files in a folder tree, skipping unchanged files.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {import('vectra').LocalIndex}       store
 * @param {string} folderPath
 * @param {{
 *   tagId?:      number,
 *   docType?:    string,
 *   metadata?:   { area?: string, discipline?: string, revision?: string },
 * }} [options]
 * @returns {Promise<{ indexed: number, skipped: number, failed: number, ocrQueued: number }>}
 */
export async function indexFolder(db, store, folderPath, options = {}) {
  const { tagId = null, docType = null, metadata = {} } = options;

  const result = { indexed: 0, skipped: 0, failed: 0, ocrQueued: 0 };

  const allFiles = await walkDir(folderPath);

  // Prepare a fast checksum lookup from the DB
  const storedRows = db.prepare('SELECT file_path, checksum FROM documents').all();
  const storedMap  = new Map(storedRows.map(r => [r.file_path, r.checksum]));

  for (const filePath of allFiles) {
    const ext = extname(filePath).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) continue;

    let checksum;
    try {
      checksum = await computeChecksum(filePath);
    } catch (err) {
      console.error(`[pipeline] Cannot read ${filePath}: ${err.message}`);
      result.failed++;
      continue;
    }

    // Skip if checksum unchanged
    if (storedMap.get(filePath) === checksum) {
      result.skipped++;
      continue;
    }

    try {
      const { ocrRequired } = await indexFile(db, store, filePath, tagId, docType, metadata);
      result.indexed++;
      if (ocrRequired) result.ocrQueued++;
    } catch (err) {
      console.error(`[pipeline] Failed to index ${filePath}: ${err.message}`);
      result.failed++;
    }
  }

  return result;
}
