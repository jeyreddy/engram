import { createRequire } from 'module';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'path';
import { getConfig } from '../db/workspace.js';
import { commitChange } from '../git/engine.js';

const require = createRequire(import.meta.url);
const PDFDocument = require('pdfkit');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Increment a revision string: R0→R1, R1→R2, etc. */
function nextRevision(current = 'R0') {
  const m = /^R(\d+)$/i.exec(current.trim());
  if (!m) return 'R1';
  return `R${parseInt(m[1], 10) + 1}`;
}

/** Look up the integer tag row by tag name. Returns null if not found. */
function getTagRow(db, tagId) {
  return db.prepare('SELECT id, name FROM tags WHERE name = ?').get(tagId) ?? null;
}

/**
 * Build the filesystem path for a document PDF.
 * [workspacePath]/instrumentation/[area]/[tagId]/documents/[docType]_[tagId]_[rev].pdf
 */
function buildFilePath(workspacePath, area, tagId, docType, revision) {
  const safeName = docType.replace(/[^a-zA-Z0-9_-]/g, '_');
  const filename  = `${safeName}_${tagId}_${revision}.pdf`;
  return join(workspacePath, 'instrumentation', area, tagId, 'documents', filename);
}

/**
 * Render a structured ENGRAM PDF into a Buffer.
 *
 * @param {{
 *   tagId:       string,
 *   docType:     string,
 *   revision:    string,
 *   fields:      Record<string,string>,
 *   authorName:  string,
 *   revStamp?:   string,
 *   plantName?:  string,
 * }} opts
 * @returns {Promise<Buffer>}
 */
function renderPDF(opts) {
  const { tagId, docType, revision, fields, authorName, revStamp, plantName } = opts;
  const dateStr = new Date().toISOString().slice(0, 10);

  return new Promise((resolve, reject) => {
    const doc    = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks = [];
    doc.on('data',  c  => chunks.push(c));
    doc.on('end',   ()  => resolve(Buffer.concat(chunks)));
    doc.on('error', err => reject(err));

    // ── Header ──────────────────────────────────────────────────────────────
    doc
      .fontSize(20).font('Helvetica-Bold').fillColor('#0c3554')
      .text('ENGRAM', 50, 50)
      .fontSize(8).font('Helvetica').fillColor('#64748b')
      .text('Plant Document Integrity', 50, 74);

    if (plantName) {
      doc.text(plantName, { align: 'right' });
    }

    doc.moveTo(50, 90).lineTo(545, 90).strokeColor('#0d2035').stroke();

    // ── Meta block ──────────────────────────────────────────────────────────
    doc.fontSize(11).font('Helvetica-Bold').fillColor('#e2e8f0').text(docType, 50, 106);
    doc.moveDown(0.3);

    const meta = [
      ['Tag ID',   tagId],
      ['Revision', revision],
      ['Date',     dateStr],
      ['Author',   authorName],
    ];

    doc.fontSize(9).font('Helvetica').fillColor('#94a3b8');
    for (const [k, v] of meta) {
      doc.text(`${k}:  ${v}`, 50, doc.y);
    }

    doc.moveDown(1);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#0d2035').stroke();
    doc.moveDown(0.8);

    // ── Fields table ────────────────────────────────────────────────────────
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#38bdf8').text('FIELD VALUES', 50, doc.y);
    doc.moveDown(0.4);

    const COL_KEY = 50;
    const COL_VAL = 220;
    const ROW_H   = 18;

    let row = 0;
    for (const [field, value] of Object.entries(fields)) {
      const y    = doc.y;
      const bg   = row % 2 === 0 ? '#020810' : '#030e1a';
      doc
        .rect(50, y - 2, 495, ROW_H).fillColor(bg).fill()
        .fontSize(9).font('Helvetica').fillColor('#94a3b8')
        .text(String(field), COL_KEY, y, { width: 160, ellipsis: true })
        .fillColor('#e2e8f0')
        .text(String(value ?? '—'), COL_VAL, y, { width: 325, ellipsis: true });
      doc.y = y + ROW_H;
      row++;
    }

    doc.moveDown(1.5);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#0d2035').stroke();

    // ── Footer ──────────────────────────────────────────────────────────────
    const footer = revStamp
      ?? `Created by ENGRAM — ${authorName} — ${dateStr}`;

    doc
      .fontSize(7).font('Helvetica').fillColor('#1e3a5f')
      .text(footer, 50, doc.page.height - 60, {
        width: 495, align: 'center',
      });

    doc.end();
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a revision stamp string for PDF footers.
 *
 * @param {number|string} docId
 * @param {string}        revision
 * @param {string}        authorName
 * @param {string}        reason
 * @returns {string}
 */
export function generateRevisionStamp(docId, revision, authorName, reason) {
  const dateStr = new Date().toISOString().slice(0, 10);
  return `Rev ${revision} — ${authorName} — ${dateStr} — ${reason}`;
}

/**
 * Create a new document PDF, register it in SQLite, and git-commit it.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} repoPath
 * @param {string} tagId          Tag name, e.g. "FT-1001"
 * @param {string} docType        e.g. "datasheet", "loop_diagram"
 * @param {Record<string,string>} fields
 * @param {string} authorName
 * @returns {Promise<{ docId: number, filePath: string, commitHash: string }>}
 */
export async function createDocument(db, repoPath, tagId, docType, fields, authorName) {
  const workspacePath = getConfig(db, 'workspace_path') ?? repoPath;
  const area          = getConfig(db, 'area')           ?? 'general';
  const plantName     = getConfig(db, 'plant_name')     ?? '';
  const authorEmail   = getConfig(db, 'engineer_email') ?? 'engram@local';

  const tagRow = getTagRow(db, tagId);
  const revision = 'R0';
  const filePath = buildFilePath(workspacePath, area, tagId, docType, revision);

  // Render and write PDF
  const pdfBuf = await renderPDF({ tagId, docType, revision, fields, authorName, plantName });
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, pdfBuf);

  // Register in documents table
  const title = `${docType} — ${tagId}`;
  const row = db.prepare(`
    INSERT INTO documents (title, file_path, file_type, tag_id, revision, status)
    VALUES (?, ?, ?, ?, ?, 'active')
    RETURNING id
  `).get(title, filePath, docType, tagRow?.id ?? null, revision);

  const docId = row.id;

  // Store extracted_values from fields
  const insertKV = db.prepare(`
    INSERT INTO extracted_values (document_id, field_name, field_value, confidence)
    VALUES (?, ?, ?, 1.0)
  `);
  const insertAll = db.transaction(flds => {
    for (const [k, v] of Object.entries(flds)) {
      insertKV.run(docId, k, String(v ?? ''));
    }
  });
  insertAll(fields);

  // Git commit
  const { commitHash } = await commitChange(repoPath, null, {
    tagId,
    action:      'CREATE',
    fieldName:   docType,
    newValue:    revision,
    source:      title,
    authorName,
    authorEmail,
  });

  return { docId, filePath, commitHash };
}

/**
 * Edit an existing document: increment revision, regenerate PDF, update SQLite,
 * git-commit, and resolve any open issues matching the changed fields.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} repoPath
 * @param {number} docId
 * @param {Record<string,string>} fieldChanges
 * @param {string} reason
 * @param {string} authorName
 * @returns {Promise<{ docId: number, newRevision: string, filePath: string, commitHash: string }>}
 */
export async function editDocument(db, repoPath, docId, fieldChanges, reason, authorName) {
  // Load current document record
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(docId);
  if (!doc) throw new Error(`Document ${docId} not found`);

  const workspacePath = getConfig(db, 'workspace_path') ?? repoPath;
  const area          = getConfig(db, 'area')           ?? 'general';
  const plantName     = getConfig(db, 'plant_name')     ?? '';
  const authorEmail   = getConfig(db, 'engineer_email') ?? 'engram@local';

  // Derive tag name
  const tagRow     = doc.tag_id
    ? db.prepare('SELECT name FROM tags WHERE id = ?').get(doc.tag_id)
    : null;
  const tagId      = tagRow?.name ?? 'UNKNOWN';
  const newRevision = nextRevision(doc.revision);

  // Load existing field values and merge changes
  const existing = db.prepare(
    'SELECT field_name, field_value FROM extracted_values WHERE document_id = ?'
  ).all(docId);
  const allFields = Object.fromEntries(existing.map(r => [r.field_name, r.field_value]));
  Object.assign(allFields, fieldChanges);

  const revStamp = generateRevisionStamp(docId, newRevision, authorName, reason);
  const newFilePath = buildFilePath(workspacePath, area, tagId, doc.file_type, newRevision);

  // Render and write new PDF
  const pdfBuf = await renderPDF({
    tagId, docType: doc.file_type,
    revision: newRevision, fields: allFields,
    authorName, revStamp, plantName,
  });
  await mkdir(dirname(newFilePath), { recursive: true });
  await writeFile(newFilePath, pdfBuf);

  // Update documents table
  db.prepare(`
    UPDATE documents
    SET file_path = ?, revision = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).run(newFilePath, newRevision, docId);

  // Upsert extracted_values for changed fields
  const upsertKV = db.prepare(`
    INSERT INTO extracted_values (document_id, field_name, field_value, confidence)
    VALUES (?, ?, ?, 1.0)
    ON CONFLICT DO UPDATE SET
      field_value = excluded.field_value,
      confidence  = 1.0
  `);
  db.transaction(changes => {
    for (const [k, v] of Object.entries(changes)) {
      upsertKV.run(docId, k, String(v ?? ''));
    }
  })(fieldChanges);

  // Resolve open issues that match any of the changed fields
  if (Object.keys(fieldChanges).length > 0) {
    const openIssues = db.prepare(
      "SELECT id, description FROM issues WHERE document_id = ? AND resolved = 0"
    ).all(docId);

    const resolveIssue = db.prepare(`
      UPDATE issues SET resolved = 1, resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `);

    for (const issue of openIssues) {
      let desc = {};
      try { desc = JSON.parse(issue.description); } catch { /* plain text */ }
      if (desc.field_name && fieldChanges[desc.field_name] !== undefined) {
        resolveIssue.run(issue.id);
      }
    }
  }

  // Git commit
  const changedFieldNames = Object.keys(fieldChanges);
  const firstField = changedFieldNames[0];
  const { commitHash } = await commitChange(repoPath, null, {
    tagId,
    action:    'EDIT',
    fieldName: firstField ?? doc.file_type,
    oldValue:  doc.revision,
    newValue:  newRevision,
    source:    doc.title,
    note:      reason,
    authorName,
    authorEmail,
  });

  return { docId, newRevision, filePath: newFilePath, commitHash };
}
