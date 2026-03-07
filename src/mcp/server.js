import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { searchDocuments } from '../ai/vectorstore.js';
import { getConfig, setConfig } from '../db/workspace.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wrap a plain JS value into the MCP CallToolResult text content format. */
function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

/** Extract the instrument-type prefix from a tag name (e.g. "FT-1001" → "FT"). */
function instrumentTypeFromTagName(name = '') {
  return (name.split('-')[0] ?? '').toUpperCase();
}

// Required document types per instrument class.
// Loaded from workspace_config key "instrumentation_config" if present;
// this built-in default is used as a fallback.
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

function loadInstrumentConfig(db) {
  const raw = getConfig(db, 'instrumentation_config');
  if (raw) {
    try { return JSON.parse(raw); } catch { /* fall through */ }
  }
  return DEFAULT_INSTRUMENT_CONFIG;
}

// ---------------------------------------------------------------------------
// Tool implementations (pure functions — easy to test independently)
// ---------------------------------------------------------------------------

async function toolSearchDocuments({ tag_id, query, doc_type }, db, store) {
  const raw = await searchDocuments(store, query, 10);

  // Filter by tag_id; optionally also by doc_type
  const filtered = raw.filter(r => {
    const m = r.metadata ?? {};
    if (String(m.tag_id) !== String(tag_id)) return false;
    if (doc_type && m.doc_type !== doc_type) return false;
    return true;
  }).slice(0, 5);

  const results = filtered.map(r => ({
    chunk_id:    r.id,
    score:       Math.round(r.score * 1000) / 1000,
    filename:    r.metadata?.filename ?? null,
    doc_type:    r.metadata?.doc_type ?? null,
    revision:    r.metadata?.revision ?? null,
    chunk_index: r.metadata?.chunk_index ?? 0,
    citation:    [r.metadata?.filename, r.metadata?.doc_type, r.metadata?.revision]
                   .filter(Boolean).join(' | '),
  }));

  return ok({ query, tag_id, results });
}

function toolGetDocumentValues({ tag_id, field_name }, db) {
  let sql = `
    SELECT ev.field_name, ev.field_value, ev.unit, ev.confidence,
           d.file_type AS doc_type, d.title AS filename, d.revision
    FROM   extracted_values ev
    JOIN   documents d ON d.id = ev.document_id
    WHERE  d.tag_id = ?
  `;
  const params = [tag_id];

  if (field_name) {
    sql += ' AND ev.field_name = ?';
    params.push(field_name);
  }

  const rows = db.prepare(sql).all(...params);
  return ok({ tag_id, field_name: field_name ?? null, values: rows });
}

function toolCompareField({ tag_id, field_name }, db) {
  const rows = db.prepare(`
    SELECT ev.field_value, d.title AS filename, d.file_type AS doc_type, d.revision
    FROM   extracted_values ev
    JOIN   documents d ON d.id = ev.document_id
    WHERE  d.tag_id = ? AND ev.field_name = ?
    ORDER  BY ev.field_value
  `).all(tag_id, field_name);

  // Group by value
  const groups = {};
  for (const row of rows) {
    const key = String(row.field_value ?? '').trim();
    if (!groups[key]) groups[key] = [];
    groups[key].push({ filename: row.filename, doc_type: row.doc_type, revision: row.revision });
  }

  const values = Object.entries(groups).map(([value, docs]) => ({ value, docs }));
  const conflict = values.length > 1;

  return ok({ tag_id, field_name, conflict, values });
}

function toolListGaps({ tag_id }, db) {
  const tag = db.prepare('SELECT id, name FROM tags WHERE id = ?').get(tag_id);
  if (!tag) return ok({ tag_id, error: `Tag ${tag_id} not found`, missing: [] });

  const instrType = instrumentTypeFromTagName(tag.name);
  const config    = loadInstrumentConfig(db);
  const required  = config[instrType] ?? [];

  const existing = db.prepare(`
    SELECT DISTINCT file_type FROM documents WHERE tag_id = ?
  `).all(tag_id).map(r => r.file_type);

  const existingSet = new Set(existing);
  const missing     = required.filter(t => !existingSet.has(t));

  return ok({
    tag_id,
    tag_name:        tag.name,
    instrument_type: instrType,
    required,
    existing,
    missing,
    complete: missing.length === 0,
  });
}

function toolListIssues({ tag_id, severity }, db) {
  const parts  = ['SELECT i.*, d.title AS filename, d.tag_id FROM issues i JOIN documents d ON d.id = i.document_id WHERE 1=1'];
  const params = [];

  if (tag_id != null) { parts.push('AND d.tag_id = ?');    params.push(tag_id); }
  if (severity)       { parts.push('AND i.severity = ?');  params.push(severity); }

  parts.push('ORDER BY i.created_at DESC');
  const rows = db.prepare(parts.join(' ')).all(...params);
  return ok({ filters: { tag_id: tag_id ?? null, severity: severity ?? null }, issues: rows });
}

function toolGetWiringChain({ tag_id }, db) {
  // Wiring records for all documents belonging to this tag
  const rows = db.prepare(`
    SELECT wr.id, wr.signal_name, wr.from_terminal, wr.to_terminal, wr.notes,
           c.tag_number AS cable_tag, c.from_location, c.to_location, c.cable_type,
           cc.core_number, cc.wire_color,
           d.title AS document
    FROM   wiring_records wr
    LEFT JOIN cables      c  ON c.id  = wr.cable_id
    LEFT JOIN cable_cores cc ON cc.id = wr.core_id
    LEFT JOIN documents   d  ON d.id  = wr.document_id
    WHERE  d.tag_id = ?
    ORDER  BY wr.id
  `).all(tag_id);

  return ok({ tag_id, chain: rows });
}

function toolGetJbCrossmap({ jb_ref }, db) {
  const like = `%${jb_ref}%`;
  const rows = db.prepare(`
    SELECT wr.id, wr.signal_name, wr.from_terminal, wr.to_terminal, wr.notes,
           c.tag_number AS cable_tag, c.from_location, c.to_location,
           d.title AS document, d.tag_id
    FROM   wiring_records wr
    LEFT JOIN cables    c ON c.id = wr.cable_id
    LEFT JOIN documents d ON d.id = wr.document_id
    WHERE  wr.from_terminal LIKE ?
       OR  wr.to_terminal   LIKE ?
       OR  wr.notes         LIKE ?
    ORDER  BY wr.id
  `).all(like, like, like);

  return ok({ jb_ref, terminations: rows });
}

function toolStageChange({ doc_id, field_name, old_value, new_value, reason }, db) {
  const raw    = getConfig(db, 'staged_changes');
  const staged = raw ? JSON.parse(raw) : [];

  const change = {
    id:         `chg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    doc_id,
    field_name,
    old_value,
    new_value,
    reason,
    staged_at:  new Date().toISOString(),
    status:     'pending',
  };

  staged.push(change);
  setConfig(db, 'staged_changes', JSON.stringify(staged));

  return ok({ staged: true, change });
}

function toolAddNote({ tag_id, note_text, note_type }, db) {
  // Find any document for this tag to anchor the note; null is allowed
  const doc = db.prepare('SELECT id FROM documents WHERE tag_id = ? LIMIT 1').get(tag_id);

  const result = db.prepare(`
    INSERT INTO engineer_notes (document_id, note, author)
    VALUES (?, ?, ?)
  `).run(doc?.id ?? null, `[${note_type ?? 'general'}] ${note_text}`, null);

  return ok({ tag_id, note_id: result.lastInsertRowid });
}

function toolGetHistory({ tag_id }, db) {
  const notes = db.prepare(`
    SELECT 'note' AS type, n.id, n.note AS content, n.author,
           n.created_at, d.title AS document
    FROM   engineer_notes n
    LEFT JOIN documents d ON d.id = n.document_id
    WHERE  d.tag_id = ?
  `).all(tag_id);

  const issues = db.prepare(`
    SELECT 'issue' AS type, i.id, i.description AS content, i.severity AS author,
           i.created_at, d.title AS document
    FROM   issues i
    JOIN   documents d ON d.id = i.document_id
    WHERE  d.tag_id = ?
  `).all(tag_id);

  const history = [...notes, ...issues]
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1)); // newest first

  return ok({ tag_id, history });
}

function toolTriggerReindex({ folder_path }, db) {
  const raw   = getConfig(db, 'reindex_queue');
  const queue = raw ? JSON.parse(raw) : [];

  const job = {
    id:         `reindex-${Date.now()}`,
    folder_path: folder_path ?? null,
    queued_at:  new Date().toISOString(),
    status:     'queued',
  };

  queue.push(job);
  setConfig(db, 'reindex_queue', JSON.stringify(queue));

  return ok({ queued: true, job });
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

/**
 * Create and configure the ENGRAM MCP server with all tools registered.
 *
 * The returned McpServer is not yet connected to a transport.
 * Call `server.connect(transport)` from the caller with the appropriate
 * transport (e.g. InMemoryTransport for in-process use, StdioServerTransport
 * for external MCP clients).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {import('vectra').LocalIndex}       store
 * @returns {McpServer}
 */
export function startMCPServer(db, store) {
  const server = new McpServer({
    name:    'engram',
    version: '1.0.0',
  });

  // ── search_documents ────────────────────────────────────────────────────
  server.tool(
    'search_documents',
    'Semantic search across indexed plant documents for a specific tag. ' +
    'Returns top-5 matching chunks with source citations.',
    {
      tag_id:   z.union([z.string(), z.number()]).describe('Tag ID to search within'),
      query:    z.string().describe('Natural language search query'),
      doc_type: z.string().optional().describe('Filter by document type (e.g. datasheet, loop_diagram)'),
    },
    (args) => toolSearchDocuments(args, db, store),
  );

  // ── get_document_values ─────────────────────────────────────────────────
  server.tool(
    'get_document_values',
    'Retrieve extracted instrument field values for a tag, optionally filtered by field name.',
    {
      tag_id:     z.union([z.string(), z.number()]).describe('Tag ID'),
      field_name: z.string().optional().describe(
        'Specific field to retrieve (e.g. range, alarm_high, revision)'
      ),
    },
    (args) => toolGetDocumentValues(args, db),
  );

  // ── compare_field ────────────────────────────────────────────────────────
  server.tool(
    'compare_field',
    'Compare a specific field value across all documents for a tag. ' +
    'Identifies agreement and conflicts between sources.',
    {
      tag_id:     z.union([z.string(), z.number()]).describe('Tag ID'),
      field_name: z.string().describe('Field name to compare (e.g. range, alarm_high)'),
    },
    (args) => toolCompareField(args, db),
  );

  // ── list_gaps ────────────────────────────────────────────────────────────
  server.tool(
    'list_gaps',
    'Check which required document types are missing for a tag based on its instrument class.',
    {
      tag_id: z.union([z.string(), z.number()]).describe('Tag ID'),
    },
    (args) => toolListGaps(args, db),
  );

  // ── list_issues ──────────────────────────────────────────────────────────
  server.tool(
    'list_issues',
    'List integrity issues, optionally filtered by tag and/or severity.',
    {
      tag_id:   z.union([z.string(), z.number()]).optional().describe('Filter by tag ID'),
      severity: z.enum(['info', 'warning', 'error', 'critical']).optional()
                 .describe('Filter by severity level'),
    },
    (args) => toolListIssues(args, db),
  );

  // ── get_wiring_chain ─────────────────────────────────────────────────────
  server.tool(
    'get_wiring_chain',
    'Retrieve the full wiring chain for a tag from field instrument to DCS card.',
    {
      tag_id: z.union([z.string(), z.number()]).describe('Tag ID'),
    },
    (args) => toolGetWiringChain(args, db),
  );

  // ── get_jb_crossmap ──────────────────────────────────────────────────────
  server.tool(
    'get_jb_crossmap',
    'Get all tags and signals terminating in a given junction box reference.',
    {
      jb_ref: z.string().describe('Junction box reference (e.g. JB-101, TB-A3)'),
    },
    (args) => toolGetJbCrossmap(args, db),
  );

  // ── stage_change ─────────────────────────────────────────────────────────
  server.tool(
    'stage_change',
    'Propose a value change on a document field. Stores the change as pending for engineer review.',
    {
      doc_id:     z.union([z.string(), z.number()]).describe('Document ID'),
      field_name: z.string().describe('Field being changed'),
      old_value:  z.string().describe('Current (existing) value'),
      new_value:  z.string().describe('Proposed new value'),
      reason:     z.string().describe('Justification for the change'),
    },
    (args) => toolStageChange(args, db),
  );

  // ── add_note ─────────────────────────────────────────────────────────────
  server.tool(
    'add_note',
    'Add an engineer note to a tag.',
    {
      tag_id:    z.union([z.string(), z.number()]).describe('Tag ID'),
      note_text: z.string().describe('Note content'),
      note_type: z.string().optional().describe(
        'Note category (e.g. observation, action, query). Defaults to "general".'
      ),
    },
    (args) => toolAddNote(args, db),
  );

  // ── get_history ──────────────────────────────────────────────────────────
  server.tool(
    'get_history',
    'Retrieve the chronological history of notes and issues for a tag.',
    {
      tag_id: z.union([z.string(), z.number()]).describe('Tag ID'),
    },
    (args) => toolGetHistory(args, db),
  );

  // ── trigger_reindex ──────────────────────────────────────────────────────
  server.tool(
    'trigger_reindex',
    'Queue a reindex job for a folder (or the default workspace if omitted).',
    {
      folder_path: z.string().optional().describe(
        'Absolute path to folder to reindex. Omit to reindex the default workspace.'
      ),
    },
    (args) => toolTriggerReindex(args, db),
  );

  return server;
}
