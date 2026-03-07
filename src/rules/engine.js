import { getConfig } from '../db/workspace.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Fields whose conflicts are promoted to ERROR severity. */
const CRITICAL_FIELDS = new Set([
  'alarm_high', 'alarm_low', 'alarm_hh', 'alarm_ll', 'fail_position',
]);

/** Fallback completeness map (mirrors mcp/server.js DEFAULT_INSTRUMENT_CONFIG). */
const DEFAULT_INSTRUMENT_CONFIG = {
  FT:  ['datasheet', 'loop_diagram', 'calibration_record', 'hook_up'],
  PT:  ['datasheet', 'loop_diagram', 'calibration_record'],
  TT:  ['datasheet', 'loop_diagram', 'calibration_record'],
  AT:  ['datasheet', 'loop_diagram', 'calibration_record'],
  LT:  ['datasheet', 'loop_diagram', 'calibration_record', 'hook_up'],
  FCV: ['datasheet', 'loop_diagram', 'hook_up', 'valve_datasheet'],
  PCV: ['datasheet', 'loop_diagram', 'hook_up', 'valve_datasheet'],
  ON:  ['datasheet', 'loop_diagram'],
  ZS:  ['datasheet', 'loop_diagram', 'hook_up'],
  HS:  ['datasheet', 'loop_diagram', 'hook_up'],
  YC:  ['datasheet', 'loop_diagram'],
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function loadInstrumentConfig(db) {
  const raw = getConfig(db, 'instrumentation_config');
  if (raw) { try { return JSON.parse(raw); } catch { /* fall through */ } }
  return DEFAULT_INSTRUMENT_CONFIG;
}

function instrumentTypeFromTagName(name = '') {
  return (name.split('-')[0] ?? '').toUpperCase().trim();
}

/**
 * Try to parse a date string in common engineering document formats.
 * Returns a Date or null.
 */
function parseDate(str) {
  if (!str || typeof str !== 'string') return null;
  str = str.trim();

  // ISO 8601 / standard JS Date parse
  const iso = new Date(str);
  if (!isNaN(iso)) return iso;

  // DD/MM/YYYY or DD-MM-YYYY
  const dmy = /^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})$/.exec(str);
  if (dmy) {
    const d = new Date(+dmy[3], +dmy[2] - 1, +dmy[1]);
    if (!isNaN(d)) return d;
  }

  // Month name: "15 Jan 2024" or "Jan 15, 2024"
  const mon = /(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})/.exec(str)
           || /([A-Za-z]{3,9})\s+(\d{1,2})[,\s]+(\d{4})/.exec(str);
  if (mon) {
    const attempt = new Date(str);
    if (!isNaN(attempt)) return attempt;
  }

  return null;
}

/**
 * Parse an interval string into months (default 12).
 * Accepts: "12 months", "6 mo", "1 year", "24", "2 years", etc.
 */
function parseIntervalMonths(str) {
  if (!str) return 12;
  const m = /(\d+)\s*(year|yr|y|month|mo|m)/i.exec(String(str).trim());
  if (m) {
    const n    = parseInt(m[1], 10);
    const unit = m[2].toLowerCase();
    return unit.startsWith('y') ? n * 12 : n;
  }
  const bare = parseInt(str, 10);
  return isNaN(bare) ? 12 : bare;
}

// ---------------------------------------------------------------------------
// Deduplication key construction
// ---------------------------------------------------------------------------

/**
 * Build the JSON description payload stored in issues.description.
 * The structured JSON allows both UI display and dedup queries via json_extract().
 */
function buildDescription(title, detail, tagId, fieldName, valueA, valueB, docBId) {
  return JSON.stringify({
    title,
    detail,
    tag_id:     tagId    ?? null,
    field_name: fieldName ?? null,
    value_a:    valueA   ?? null,
    value_b:    valueB   ?? null,
    doc_b_id:   docBId   ?? null,
  });
}

// ---------------------------------------------------------------------------
// createIssue — exported helper
// ---------------------------------------------------------------------------

/**
 * Insert an issue into the issues table, skipping if an identical open issue
 * already exists (same docA, type, field_name, resolved=0).
 *
 * NOTE: `document_id NOT NULL` in the schema means issues without a document
 * anchor (e.g. RULE 7 — tag with zero documents) cannot be persisted.
 * In that case `{ created: false, issueId: null }` is returned and callers
 * should track the detection independently.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number}      tagId
 * @param {string}      type       Rule type code (e.g. 'VALUE_CONFLICT')
 * @param {string}      severity   'info' | 'warning' | 'error' | 'critical'
 * @param {string}      title      Short human-readable title
 * @param {string}      detail     Longer description
 * @param {number|null} [docAId]   Primary document ID (required by schema)
 * @param {number|null} [docBId]   Secondary document ID
 * @param {string|null} [fieldName]
 * @param {string|null} [valueA]
 * @param {string|null} [valueB]
 * @returns {{ created: boolean, issueId: number|null }}
 */
export function createIssue(
  db, tagId, type, severity, title, detail,
  docAId = null, docBId = null, fieldName = null, valueA = null, valueB = null
) {
  // Schema requires document_id NOT NULL — cannot persist without a document.
  if (docAId == null) {
    return { created: false, issueId: null };
  }

  // Dedup: skip if an open issue with the same type + docA + field already exists.
  const existing = db.prepare(`
    SELECT id FROM issues
    WHERE document_id = ?
      AND category    = ?
      AND resolved    = 0
      AND (
        json_extract(description, '$.field_name') IS ?
      )
    LIMIT 1
  `).get(docAId, type, fieldName);

  if (existing) {
    return { created: false, issueId: existing.id };
  }

  const description = buildDescription(title, detail, tagId, fieldName, valueA, valueB, docBId);

  const result = db.prepare(`
    INSERT INTO issues (document_id, severity, category, description)
    VALUES (?, ?, ?, ?)
  `).run(docAId, severity, type, description);

  return { created: true, issueId: result.lastInsertRowid };
}

// ---------------------------------------------------------------------------
// Rule implementations  (private)
// ---------------------------------------------------------------------------

/**
 * RULE 1 — VALUE_CONFLICT
 * Multiple documents disagree on the same field value for this tag.
 */
function ruleValueConflict(db, tagId, stats) {
  // Get all (field_name, field_value, doc_id) pairs for this tag
  const values = db.prepare(`
    SELECT ev.field_name, ev.field_value, d.id AS doc_id, d.title AS doc_title
    FROM   extracted_values ev
    JOIN   documents d ON d.id = ev.document_id
    WHERE  d.tag_id = ?
      AND  ev.field_value IS NOT NULL
      AND  ev.field_value != ''
  `).all(tagId);

  // Group by field_name
  const byField = new Map();
  for (const row of values) {
    const list = byField.get(row.field_name) ?? [];
    list.push(row);
    byField.set(row.field_name, list);
  }

  for (const [fieldName, rows] of byField) {
    // Collect distinct values
    const distinctValues = [...new Set(rows.map(r => String(r.field_value).trim()))];
    if (distinctValues.length < 2) continue;  // all agree

    const severity = CRITICAL_FIELDS.has(fieldName) ? 'error' : 'warning';

    // Emit one issue per conflicting pair (docA vs docB)
    // Use the first doc as anchor, flag conflict with second
    const docA = rows[0];
    const docB = rows.find(r => String(r.field_value).trim() !== String(docA.field_value).trim());

    const title  = `VALUE_CONFLICT: ${fieldName} differs across documents`;
    const detail = `"${docA.doc_title}" has ${fieldName}=${docA.field_value}; ` +
                   `"${docB.doc_title}" has ${fieldName}=${docB.field_value}`;

    const { created } = createIssue(
      db, tagId, 'VALUE_CONFLICT', severity, title, detail,
      docA.doc_id, docB.doc_id, fieldName,
      String(docA.field_value), String(docB.field_value)
    );

    stats.total++;
    if (created) stats.created++; else stats.skipped++;
  }
}

/**
 * RULE 2 — MISSING_DOCUMENT
 * Required document types absent from the documents table for this tag.
 */
function ruleMissingDocument(db, tagId, stats) {
  const tag = db.prepare('SELECT name FROM tags WHERE id = ?').get(tagId);
  if (!tag) return;

  const instrType = instrumentTypeFromTagName(tag.name);
  const config    = loadInstrumentConfig(db);
  const required  = config[instrType] ?? [];
  if (required.length === 0) return;

  const existing = new Set(
    db.prepare('SELECT DISTINCT file_type FROM documents WHERE tag_id = ?')
      .all(tagId).map(r => r.file_type)
  );

  // Anchor missing-doc issues to any existing document (first one found)
  const anchorDoc = db.prepare(
    'SELECT id FROM documents WHERE tag_id = ? ORDER BY id LIMIT 1'
  ).get(tagId);

  for (const docType of required) {
    if (existing.has(docType)) continue;

    stats.total++;
    if (!anchorDoc) { stats.skipped++; continue; }  // RULE 7 covers this case

    const title  = `MISSING_DOCUMENT: ${docType} not found for ${tag.name}`;
    const detail = `Required document type "${docType}" is missing for instrument ${tag.name} (${instrType}).`;

    const { created } = createIssue(
      db, tagId, 'MISSING_DOCUMENT', 'warning', title, detail,
      anchorDoc.id, null, docType
    );
    if (created) stats.created++; else stats.skipped++;
  }
}

/**
 * RULE 3 — OUTDATED_REVISION
 * Same doc_type appears more than once for this tag with differing revisions.
 */
function ruleOutdatedRevision(db, tagId, stats) {
  // Find doc_types with multiple documents
  const dupeTypes = db.prepare(`
    SELECT file_type, COUNT(*) AS cnt
    FROM   documents
    WHERE  tag_id = ? AND revision IS NOT NULL AND revision != ''
    GROUP  BY file_type
    HAVING cnt > 1
  `).all(tagId);

  for (const { file_type } of dupeTypes) {
    const docs = db.prepare(`
      SELECT id, title, revision
      FROM   documents
      WHERE  tag_id = ? AND file_type = ?
      ORDER  BY id
    `).all(tagId, file_type);

    const distinctRevs = [...new Set(docs.map(d => d.revision?.trim().toLowerCase()).filter(Boolean))];
    if (distinctRevs.length < 2) continue;  // all same revision

    const newest = docs[docs.length - 1];
    const older  = docs.slice(0, -1);

    for (const old of older) {
      if (old.revision?.trim().toLowerCase() === newest.revision?.trim().toLowerCase()) continue;

      const title  = `OUTDATED_REVISION: ${file_type} revision mismatch for ${
        db.prepare('SELECT name FROM tags WHERE id = ?').get(tagId)?.name ?? tagId
      }`;
      const detail = `"${old.title}" is Rev ${old.revision} but "${newest.title}" is Rev ${newest.revision}.`;

      const { created } = createIssue(
        db, tagId, 'OUTDATED_REVISION', 'warning', title, detail,
        old.id, newest.id, file_type, old.revision, newest.revision
      );

      stats.total++;
      if (created) stats.created++; else stats.skipped++;
    }
  }
}

/**
 * RULE 4 — UNTRACEABLE_VALUE
 * An extracted value from a DCS Config document has no corroborating source
 * in any other document for the same tag.
 */
function ruleUntraceableValue(db, tagId, stats) {
  // Find DCS-type documents (file_type contains 'dcs')
  const dcsDocs = db.prepare(`
    SELECT id, title FROM documents
    WHERE  tag_id = ? AND LOWER(file_type) LIKE '%dcs%'
  `).all(tagId);

  if (dcsDocs.length === 0) return;

  const corrobCheck = db.prepare(`
    SELECT COUNT(*) AS cnt
    FROM   extracted_values ev
    JOIN   documents d ON d.id = ev.document_id
    WHERE  d.tag_id = ?
      AND  d.id     != ?
      AND  ev.field_name = ?
  `);

  for (const dcsDoc of dcsDocs) {
    const dcsValues = db.prepare(`
      SELECT field_name, field_value FROM extracted_values
      WHERE  document_id = ?
    `).all(dcsDoc.id);

    for (const { field_name, field_value } of dcsValues) {
      const { cnt } = corrobCheck.get(tagId, dcsDoc.id, field_name);
      if (cnt > 0) continue;  // corroborated

      const tag   = db.prepare('SELECT name FROM tags WHERE id = ?').get(tagId);
      const title = `UNTRACEABLE_VALUE: ${field_name} in DCS config has no source`;
      const detail = `Field "${field_name}" (value: ${field_value}) from DCS document ` +
                     `"${dcsDoc.title}" is not present in any other document for ${tag?.name ?? tagId}.`;

      const { created } = createIssue(
        db, tagId, 'UNTRACEABLE_VALUE', 'warning', title, detail,
        dcsDoc.id, null, field_name, field_value, null
      );

      stats.total++;
      if (created) stats.created++; else stats.skipped++;
    }
  }
}

/**
 * RULE 5 — WIRING_INCOMPLETE
 * Wiring records for this tag have null/empty required fields.
 * Maps to available schema columns: signal_name, from_terminal, to_terminal.
 */
function ruleWiringIncomplete(db, tagId, stats) {
  const records = db.prepare(`
    SELECT wr.id, wr.document_id, wr.signal_name,
           wr.from_terminal, wr.to_terminal, wr.notes
    FROM   wiring_records wr
    LEFT JOIN documents d ON d.id = wr.document_id
    WHERE  d.tag_id = ?
  `).all(tagId);

  if (records.length === 0) return;

  const REQUIRED_COLS = [
    ['signal_name',    'signal name'],
    ['from_terminal',  'from-terminal reference'],
    ['to_terminal',    'to-terminal reference'],
  ];

  for (const rec of records) {
    if (rec.document_id == null) continue;  // cannot anchor without a document

    for (const [col, label] of REQUIRED_COLS) {
      const val = rec[col];
      if (val != null && String(val).trim() !== '') continue;

      const title  = `WIRING_INCOMPLETE: missing ${label} on wiring record #${rec.id}`;
      const detail = `Wiring record #${rec.id} is missing a ${label}. Full chain traceability requires all terminal references to be populated.`;

      const { created } = createIssue(
        db, tagId, 'WIRING_INCOMPLETE', 'warning', title, detail,
        rec.document_id, null, col
      );

      stats.total++;
      if (created) stats.created++; else stats.skipped++;
    }
  }
}

/**
 * RULE 6 — CALIB_OVERDUE
 * calibration_date + calibration_interval < today.
 */
function ruleCalibOverdue(db, tagId, stats) {
  // Find calibration record documents for this tag
  const calibDocs = db.prepare(`
    SELECT id, title FROM documents
    WHERE  tag_id = ? AND LOWER(file_type) LIKE '%calibrat%'
  `).all(tagId);

  if (calibDocs.length === 0) return;

  // Calibration interval from work procedure (default 12 months)
  const intervalRow = db.prepare(`
    SELECT ev.field_value
    FROM   extracted_values ev
    JOIN   documents d ON d.id = ev.document_id
    WHERE  d.tag_id = ?
      AND  LOWER(d.file_type) LIKE '%procedure%'
      AND  LOWER(ev.field_name) LIKE '%interval%'
    LIMIT  1
  `).get(tagId);

  const intervalMonths = parseIntervalMonths(intervalRow?.field_value);
  const today          = new Date();

  for (const calibDoc of calibDocs) {
    const dateRow = db.prepare(`
      SELECT field_value
      FROM   extracted_values
      WHERE  document_id = ?
        AND  LOWER(field_name) LIKE '%calibrat%date%'
      LIMIT  1
    `).get(calibDoc.id);

    if (!dateRow?.field_value) continue;

    const calibDate = parseDate(dateRow.field_value);
    if (!calibDate) continue;

    // Next calibration due date
    const due = new Date(calibDate);
    due.setMonth(due.getMonth() + intervalMonths);

    if (due >= today) continue;  // still valid

    const overdueDays = Math.floor((today - due) / 86_400_000);
    const tag   = db.prepare('SELECT name FROM tags WHERE id = ?').get(tagId);
    const title = `CALIB_OVERDUE: calibration overdue for ${tag?.name ?? tagId}`;
    const detail = `Calibration date ${dateRow.field_value} + ${intervalMonths}-month interval ` +
                   `= due ${due.toISOString().slice(0, 10)}, which is ${overdueDays} day(s) ago.`;

    const { created } = createIssue(
      db, tagId, 'CALIB_OVERDUE', 'error', title, detail,
      calibDoc.id, null, 'calibration_date', dateRow.field_value, due.toISOString().slice(0, 10)
    );

    stats.total++;
    if (created) stats.created++; else stats.skipped++;
  }
}

/**
 * RULE 7 — NO_SOURCE_DOCUMENT
 * Tag exists but has zero documents.
 * Cannot be persisted (no document to anchor to); counted in stats only.
 */
function ruleNoSourceDocument(db, tagId, stats) {
  const count = db.prepare(
    'SELECT COUNT(*) AS cnt FROM documents WHERE tag_id = ?'
  ).get(tagId);

  if (count.cnt > 0) return;

  // Cannot insert issue — document_id NOT NULL constraint.
  // Record the detection in stats so callers are informed.
  console.warn(`[rules] NO_SOURCE_DOCUMENT: tag ${tagId} has no documents (cannot persist issue)`);
  stats.total++;
  stats.skipped++;   // counted as skipped (not stored)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run all seven rules for a single tag.
 * New issues are written to the issues table; open duplicates are skipped.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} tagId
 * @returns {{ created: number, skipped: number, total: number }}
 */
export function runAllRules(db, tagId) {
  const stats = { created: 0, skipped: 0, total: 0 };

  try { ruleValueConflict    (db, tagId, stats); } catch (e) { console.error(`[rules] R1 tag ${tagId}:`, e.message); }
  try { ruleMissingDocument  (db, tagId, stats); } catch (e) { console.error(`[rules] R2 tag ${tagId}:`, e.message); }
  try { ruleOutdatedRevision (db, tagId, stats); } catch (e) { console.error(`[rules] R3 tag ${tagId}:`, e.message); }
  try { ruleUntraceableValue (db, tagId, stats); } catch (e) { console.error(`[rules] R4 tag ${tagId}:`, e.message); }
  try { ruleWiringIncomplete (db, tagId, stats); } catch (e) { console.error(`[rules] R5 tag ${tagId}:`, e.message); }
  try { ruleCalibOverdue     (db, tagId, stats); } catch (e) { console.error(`[rules] R6 tag ${tagId}:`, e.message); }
  try { ruleNoSourceDocument (db, tagId, stats); } catch (e) { console.error(`[rules] R7 tag ${tagId}:`, e.message); }

  return stats;
}

/**
 * Run all rules across every tag in the database.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {{ tags: number, created: number, skipped: number }}
 */
export function runRulesForAll(db) {
  const tags = db.prepare('SELECT id FROM tags').all();
  const totals = { tags: tags.length, created: 0, skipped: 0 };

  for (const { id } of tags) {
    const result = runAllRules(db, id);
    totals.created += result.created;
    totals.skipped += result.skipped;
  }

  return totals;
}
