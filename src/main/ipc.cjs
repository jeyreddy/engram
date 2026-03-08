'use strict';
//
// src/main/ipc.cjs — Electron IPC handler registration
//
// ARCHITECTURE NOTE:
//   This file is CJS (.cjs) because Electron's main process entry point is CJS.
//   All backend modules are ESM (.js), so they must be loaded via dynamic
//   `await import(...)` — never `require()`.  The `handle()` wrapper exists to
//   add uniform error logging around every handler without repeating try/catch.
//
// QUERY PIPELINE (query:send handler):
//   Three data sources are merged, in priority order, before calling Claude:
//     1. standardsChunks  — semantic search against the separate vectra
//                           standards index (uploaded PDF/DOCX policy files)
//     2. keywordChunks    — SQL LIKE search against extracted_values for exact
//                           field matches; also a direct DB dump for list queries
//     3. vectorChunks     — semantic search against the main document vectra index
//   Standards are placed first so Claude treats them as highest-priority context.
//   On top of these chunks, `registryContext` is injected into the system prompt
//   as a list of applicable standard numbers from the standards_registry table.
//
// DATA SOURCES:
//   db        — sql.js database (SqlJsAdapter, better-sqlite3-compatible API)
//   store     — vectra LocalIndex for regular documents (vectorindex/)
//   stdStore  — vectra LocalIndex for standards/policy docs (vectorindex_standards/)
//

let ipcMain, dialog;

// Thin wrapper: strips the Electron `_event` arg, forwards the rest to `fn`,
// and logs any uncaught error before rethrowing (so the renderer gets a proper
// rejection rather than a silent failure).
function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      console.error(`[IPC] ${channel}:`, err);
      throw err;
    }
  });
}

// registerIPCHandlers is async because `await import('electron')` must resolve
// before we can call ipcMain.handle().  All ESM backend modules are imported
// here once at startup so subsequent handler calls don't pay import cost.
async function registerIPCHandlers(db, store, repoPath, stdStore) {
  // Electron APIs: use ESM import, not require() — require('electron') returns
  // the npm stub package, not the real Electron internals.
  ({ ipcMain, dialog } = await import('electron'));

  // All backend modules are ESM; import them once here so every handler below
  // can call them synchronously (except query:send which re-imports to keep
  // the cold-start path lazy).
  const { getConfig, setConfig, getAllConfig } = await import('../db/workspace.js');
  const { initRepo, getHistory, revertCommit } = await import('../git/engine.js');
  const { indexFile, indexFolder }             = await import('../indexing/pipeline.js');
  // searchDocuments / queryWithContext are imported lazily inside query:send
  // so the AI SDK is not loaded unless a query is actually made.
  const { runAllRules, runRulesForAll }        = await import('../rules/engine.js');
  const {
    getWiringChain, saveWiringRecord,
    getJBCrossmap, traceFromDCS,
  } = await import('../wiring/engine.js');
  const { createDocument, editDocument } = await import('../documents/author.js');

  // ── Schema migrations ──────────────────────────────────────────────────────
  // Strategy: wrap every ALTER TABLE in try/catch so the app starts cleanly
  // on both fresh databases and existing databases that already have the column.
  // SQLite throws "duplicate column name" if you ALTER to add an existing column,
  // which we intentionally swallow.  CREATE TABLE IF NOT EXISTS is idempotent.

  // documents: extra columns added after initial schema was deployed
  try { db.exec('ALTER TABLE documents ADD COLUMN chunk_count INTEGER DEFAULT 0'); } catch (_) {}
  try { db.exec("ALTER TABLE documents ADD COLUMN project_name TEXT DEFAULT 'Default'"); } catch (_) {}
  try { db.exec('ALTER TABLE documents ADD COLUMN display_name TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE documents ADD COLUMN description  TEXT'); } catch (_) {}

  // tags: extended into a full instrument tag registry
  // tag_id stores the human-readable ID (e.g. "FT-101"); name is the same value
  // for legacy rows — tag_id was added later when the registry feature landed.
  try { db.exec('ALTER TABLE tags ADD COLUMN tag_id TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE tags ADD COLUMN description TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE tags ADD COLUMN instrument_type TEXT'); } catch (_) {}
  try { db.exec("ALTER TABLE tags ADD COLUMN area TEXT DEFAULT 'Default'"); } catch (_) {}
  try { db.exec('ALTER TABLE tags ADD COLUMN make TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE tags ADD COLUMN model TEXT'); } catch (_) {}
  try { db.exec("ALTER TABLE tags ADD COLUMN status TEXT DEFAULT 'active'"); } catch (_) {}
  try { db.exec('ALTER TABLE tags ADD COLUMN notes TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE tags ADD COLUMN updated_at TEXT'); } catch (_) {}
  // Backfill tag_id for rows created before the column existed
  try { db.exec('UPDATE tags SET tag_id = name WHERE tag_id IS NULL'); } catch (_) {}

  // standards_documents: stores uploaded policy/standard PDF files that are
  // indexed into the separate stdStore vectra index and searched at query time.
  // This is DIFFERENT from standards_registry, which is just a notepad of
  // standard numbers used to inject context into the Claude system prompt.
  try { db.exec(`CREATE TABLE IF NOT EXISTS standards_documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    file_path TEXT,
    file_type TEXT,
    category TEXT DEFAULT 'General',
    scope TEXT DEFAULT 'company',
    version TEXT,
    effective_date TEXT,
    description TEXT,
    checksum TEXT,
    chunk_count INTEGER DEFAULT 0,
    indexed_at TEXT,
    status TEXT DEFAULT 'active',
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`); } catch (_) {}
  try { db.exec(`CREATE TABLE IF NOT EXISTS standards_extracted (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    standard_id INTEGER NOT NULL,
    field_name TEXT,
    field_value TEXT,
    context TEXT,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    FOREIGN KEY(standard_id) REFERENCES standards_documents(id)
  )`); } catch (_) {}

  // ── Workspace ─────────────────────────────────────────────────────────────

  handle('workspace:get',    () => getAllConfig(db));
  handle('workspace:getkey', (key) => getConfig(db, key));

  handle('workspace:save', (config) => {
    for (const [key, value] of Object.entries(config)) {
      setConfig(db, key, String(value));
    }
    return { ok: true };
  });

  handle('workspace:setup', async (config) => {
    // Fill in env var defaults for any keys not supplied by the caller
    const envDefaults = {
      engineer_name:  process.env.ENGRAM_ENGINEER_NAME,
      engineer_email: process.env.ENGRAM_ENGINEER_EMAIL,
      plant_name:     process.env.ENGRAM_PLANT_NAME,
      area:           process.env.ENGRAM_AREA,
      api_key:        process.env.ENGRAM_API_KEY,
    };
    for (const [key, val] of Object.entries(envDefaults)) {
      if (val && !config[key]) config = { ...config, [key]: val };
    }

    for (const [key, value] of Object.entries(config)) {
      if (key !== 'source_paths') {
        setConfig(db, key, String(value));
      }
    }

    if (Array.isArray(config.source_paths) && config.source_paths.length > 0) {
      setConfig(db, 'source_paths', JSON.stringify(config.source_paths));
    }

    setConfig(db, 'workspace_initialised', '1');

    await initRepo(repoPath, db);

    const paths = Array.isArray(config.source_paths) ? config.source_paths : [];
    if (paths.length > 0) {
      setConfig(db, 'index_status', 'indexing');
      Promise.allSettled(paths.map(p => indexFolder(db, store, p, {})))
        .then(results => {
          const totals = results.reduce(
            (acc, r) => {
              if (r.status === 'fulfilled') {
                acc.indexed  += r.value.indexed  ?? 0;
                acc.failed   += r.value.failed   ?? 0;
              }
              return acc;
            },
            { indexed: 0, failed: 0 }
          );
          setConfig(db, 'index_status', `done:${totals.indexed}:${totals.failed}`);
        })
        .catch(() => setConfig(db, 'index_status', 'error'));
    }

    return { ok: true };
  });

  // ── Indexing ──────────────────────────────────────────────────────────────

  handle('index:trigger', async (folderPath) => {
    setConfig(db, 'index_status', 'indexing');
    try {
      const result = await indexFolder(db, store, folderPath, {});
      setConfig(db, 'index_status', `done:${result.indexed}:${result.failed}`);
      return result;
    } catch (err) {
      setConfig(db, 'index_status', 'error');
      throw err;
    }
  });

  handle('index:status', () => getConfig(db, 'index_status') ?? 'idle');

  // ── Query / AI ────────────────────────────────────────────────────────────

  ipcMain.handle('query:send', async (_event, userMessage) => {
    try {
      // Lazy-load AI modules — keeps startup fast when no query has been made yet.
      const { searchDocuments }  = await import('../ai/vectorstore.js');
      const { queryWithContext } = await import('../ai/claude.js');

      // k controls how many vector results to retrieve.
      // "List all" style queries need more context chunks than focused questions,
      // so we bump k from the default 5 up to 20.
      function getQueryK(msg) {
        const m = msg.toLowerCase();
        const listKeywords = [
          'list all', 'show all', 'all tags', 'all instruments', 'all valves',
          'complete list', 'full list', 'everything', 'how many', 'count',
          'what are all', 'give me all',
        ];
        return listKeywords.some(kw => m.includes(kw)) ? 20 : 5;
      }
      const k = getQueryK(userMessage);

      let keywordChunks = [];

      // For "list all tags / instruments" queries, vector search is insufficient
      // because it returns semantically similar chunks, not exhaustive data.
      // We bypass it and query extracted_values directly so no tags are missed.
      const isCompleteListQuery =
        userMessage.toLowerCase().includes('list all') ||
        userMessage.toLowerCase().includes('all tags') ||
        userMessage.toLowerCase().includes('show all tags') ||
        userMessage.toLowerCase().includes('complete list');

      if (isCompleteListQuery) {
        try {
          const allTagRows = db.prepare(`
            SELECT
              ev.field_value as tag_value,
              ev.field_name,
              d.title as filename,
              d.id    as doc_id
            FROM extracted_values ev
            JOIN documents d ON d.id = ev.document_id
            WHERE (
              ev.field_name LIKE '%tag%' OR
              ev.field_name LIKE '%Tag%' OR
              ev.field_name = 'Equipment Number'
            )
            AND ev.field_value IS NOT NULL
            AND ev.field_value != ''
            AND ev.field_value != '-'
            AND length(ev.field_value) > 1
            ORDER BY d.title, ev.field_value
          `).all();

          if (allTagRows.length > 0) {
            const { isValidTag } = await import('../indexing/extractor.js');
            const byDoc = {};
            for (const row of allTagRows) {
              if (!isValidTag(row.tag_value)) continue;
              if (!byDoc[row.filename]) byDoc[row.filename] = [];
              byDoc[row.filename].push(row.tag_value);
            }
            for (const [filename, tags] of Object.entries(byDoc)) {
              const uniqueTags = [...new Set(tags)].sort();
              keywordChunks.unshift({
                metadata: { filename, doc_type: 'complete_tag_list', source: 'database_direct' },
                text: `Complete tag list from ${filename}:\n` + uniqueTags.join('\n'),
              });
            }
            console.log('[query] direct DB tag list:', allTagRows.length, 'tag references found');
          }
        } catch (e) {
          console.error('[query] direct tag list error:', e.message);
        }
      }

      // Vector search against the main document index.
      // Returns semantically similar chunks ranked by cosine similarity.
      let vectorChunks = [];
      try {
        vectorChunks = await searchDocuments(store, userMessage, k);
        console.log('[query] first vector chunk:', JSON.stringify(vectorChunks[0]));
      } catch (e) {
        console.warn('[query] vector search failed:', e.message);
      }

      // Keyword search against extracted_values (SQL LIKE).
      // Complements vector search: catches exact field names/values that may not
      // rank highly by embedding similarity (e.g. tag numbers, serial numbers).
      const words = userMessage.toLowerCase()
        .split(/\s+/)
        .filter(w => w.length > 2);
      if (words.length > 0) {
        const conditions = words.map(() => 'lower(ev.field_value) LIKE ?').join(' OR ');
        const params     = words.map(w => `%${w}%`);

        try {
          const rows = db.prepare(`
            SELECT DISTINCT
              d.title, d.file_type, d.revision,
              ev.field_name, ev.field_value, ev.page_ref
            FROM extracted_values ev
            JOIN documents d ON d.id = ev.document_id
            WHERE ${conditions}
            LIMIT ${k > 5 ? 50 : 20}
          `).all(...params);

          if (rows.length > 0) {
            const grouped = {};
            for (const row of rows) {
              const key = row.title;
              if (!grouped[key]) grouped[key] = [];
              grouped[key].push(`${row.field_name}: ${row.field_value}`);
            }
            for (const [title, fields] of Object.entries(grouped)) {
              keywordChunks.push({
                metadata: { filename: title, doc_type: 'extracted' },
                text: fields.join('\n'),
              });
            }
          }
        } catch (e) {
          console.error('[query] keyword search error:', e.message);
        }
      }

      // Document list context
      let docChunks = [];
      try {
        const docs = db.prepare('SELECT title, file_type, revision FROM documents LIMIT 10').all();
        for (const doc of docs) {
          docChunks.push({
            metadata: { filename: doc.title, doc_type: doc.file_type, revision: doc.revision },
            text: `Document available: ${doc.title} | Type: ${doc.file_type} | Revision: ${doc.revision}`,
          });
        }
      } catch (e) { /* non-fatal */ }

      // Standards search — searches the separate vectra index of uploaded
      // policy/standard files (stdStore at vectorindex_standards/).
      // Placed FIRST in allChunks so Claude treats them as highest-priority
      // context and checks conformance before answering from document data.
      let standardsChunks = [];
      if (stdStore) {
        try {
          const { searchStandards } = await import('../ai/vectorstore.js');
          const stdResults = await searchStandards(stdStore, userMessage, 5);
          standardsChunks = stdResults.map(r => ({
            metadata: {
              filename:    r.metadata?.title  ?? r.metadata?.filename ?? 'Standard',
              doc_type:    'STANDARD/POLICY',
              source_type: 'STANDARD/POLICY',
              category:    r.metadata?.category ?? null,
            },
            text: r.metadata?.text ?? '',
          })).filter(c => c.text.length > 0);
          console.log('[query] standards chunks:', standardsChunks.length);
        } catch (e) {
          console.warn('[query] standards search failed:', e.message);
        }
      }

      // Merge all context: standards > keyword/DB > vector.
      // Claude receives them in this order inside the user message block.
      const allChunks = [...standardsChunks, ...keywordChunks, ...vectorChunks];
      console.log('[query] std:', standardsChunks.length, '| keyword:', keywordChunks.length, '| vector:', vectorChunks.length);

      // Registry context: inject the standards_registry notepad as a system-prompt
      // addendum.  Unlike standardsChunks (content from uploaded files), this is
      // just a list of standard numbers/names that Claude knows from its training.
      // It tells Claude which standards apply to this plant so it can flag
      // non-conformances using its built-in knowledge of each standard.
      let registryContext = '';
      try {
        const registryRows = db.prepare(`
          SELECT standard_number, standard_name, category, notes
          FROM standards_registry
          WHERE active = 1
          ORDER BY category, standard_number
        `).all();
        if (registryRows.length > 0) {
          registryContext =
            'APPLICABLE STANDARDS & CODES:\n' +
            registryRows.map(r =>
              `- ${r.standard_number}` +
              (r.standard_name ? `: ${r.standard_name}` : '') +
              (r.notes ? ` (${r.notes})` : '')
            ).join('\n') +
            '\n\nWhen reviewing documents, check compliance against these standards. ' +
            'Use your knowledge of each standard to identify gaps or violations.\n';
        }
      } catch (e) { console.warn('[query] registry fetch failed:', e.message); }

      // systemExtra (registryContext) is appended to the Claude system prompt
      // in claude.js → queryWithContext().  Pass undefined if no registry rows
      // to avoid adding a blank section to the prompt.
      return queryWithContext(db, userMessage, allChunks, registryContext || undefined);
    } catch (err) {
      console.error('[query:send] error:', err.message);
      throw err;
    }
  });

  // ── Docs: workspace-wide list ─────────────────────────────────────────────

  ipcMain.handle('docs:list', async () => {
    try {
      const docs = db.prepare(`
        SELECT
          d.id, d.title, d.file_type, d.revision, d.project_name,
          d.created_at, d.chunk_count, d.tag_id,
          d.display_name, d.description,
          COUNT(ev.id) as field_count
        FROM documents d
        LEFT JOIN extracted_values ev ON ev.document_id = d.id
        GROUP BY d.id
        ORDER BY d.created_at DESC
      `).all();
      const statusRow = db.prepare("SELECT value FROM workspace_config WHERE key = 'index_status'").get();
      return { ok: true, docs, indexStatus: statusRow?.value ?? 'idle' };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  handle('docs:delete', async (docId) => {
    try {
      const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(docId);
      if (!doc) return { ok: false, error: 'Not found' };
      try {
        const { deleteDocument } = await import('../ai/vectorstore.js');
        await deleteDocument(store, docId);
      } catch (e) { console.log('[delete] vector cleanup:', e.message); }
      db.prepare('DELETE FROM extracted_values WHERE document_id = ?').run(docId);
      db.prepare('DELETE FROM issues WHERE document_id = ?').run(docId);
      db.prepare('DELETE FROM documents WHERE id = ?').run(docId);
      console.log('[delete] cleaned up doc:', doc.title);
      return { ok: true, filename: doc.title };
    } catch (e) {
      console.error('[delete] error:', e.message);
      return { ok: false, error: e.message };
    }
  });

  handle('docs:rename', (docId, displayName, description) => {
    db.prepare(
      'UPDATE documents SET display_name = ?, description = ? WHERE id = ?'
    ).run(displayName || null, description || null, docId);
    return { ok: true };
  });

  handle('docs:getFields', (docId) => {
    try {
      const fields = db.prepare(
        'SELECT field_name, field_value FROM extracted_values WHERE document_id = ? LIMIT 10'
      ).all(docId);
      return { ok: true, fields };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ── Projects ───────────────────────────────────────────────────────────────

  handle('projects:list', () => {
    try {
      const rows = db.prepare(
        "SELECT DISTINCT project_name FROM documents WHERE project_name IS NOT NULL ORDER BY project_name"
      ).all();
      const fromDocs = rows.map(r => r.project_name).filter(Boolean);
      const savedRaw = getConfig(db, 'projects');
      const saved = savedRaw ? JSON.parse(savedRaw) : ['Default'];
      const all = [...new Set(['Default', ...saved, ...fromDocs])].sort(
        (a, b) => a === 'Default' ? -1 : b === 'Default' ? 1 : a.localeCompare(b)
      );
      return { ok: true, projects: all };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  handle('projects:create', (name) => {
    if (!name?.trim()) return { ok: false, error: 'Name required' };
    const savedRaw = getConfig(db, 'projects');
    const saved = savedRaw ? JSON.parse(savedRaw) : ['Default'];
    if (!saved.includes(name)) {
      saved.push(name);
      setConfig(db, 'projects', JSON.stringify(saved));
    }
    return { ok: true };
  });

  handle('projects:setCurrent', (name) => {
    setConfig(db, 'current_project', name ?? 'Default');
    return { ok: true };
  });

  handle('projects:getCurrent', () => getConfig(db, 'current_project') ?? 'Default');

  // ── Tags ──────────────────────────────────────────────────────────────────

  handle('tags:list', () => {
    const tags = db.prepare(`
      SELECT t.*,
        COUNT(DISTINCT d.id) as doc_count,
        COUNT(DISTINCT i.id) as issue_count
      FROM tags t
      LEFT JOIN documents d ON d.tag_id = t.id
      LEFT JOIN issues i ON i.document_id = d.id AND i.resolved = 0
      GROUP BY t.id
      ORDER BY t.tag_id, t.name
    `).all();
    return tags.map(t => ({
      ...t,
      docCount:   t.doc_count,
      issueCount: t.issue_count,
      errorCount: 0,
      coverage:   Math.min(100, (t.doc_count ?? 0) * 20),
    }));
  });

  handle('tags:get', (tagId) => {
    const tag = db.prepare(`
      SELECT t.*,
        COUNT(DISTINCT d.id) as doc_count,
        COUNT(DISTINCT i.id) as issue_count
      FROM tags t
      LEFT JOIN documents d ON d.tag_id = t.id
      LEFT JOIN issues i ON i.document_id = d.id AND i.resolved = 0
      WHERE t.tag_id = ? OR t.name = ?
      GROUP BY t.id
    `).get(tagId, tagId);
    const docs = tag ? db.prepare(
      'SELECT id, title, file_type, revision, created_at FROM documents WHERE tag_id = ? ORDER BY created_at DESC'
    ).all(tag.id) : [];
    return { ok: true, tag, docs };
  });

  handle('tags:getOne', (tagId) =>
    db.prepare('SELECT * FROM tags WHERE name = ? OR tag_id = ?').get(tagId, tagId) ?? null
  );

  handle('tags:create', (data) => {
    try {
      const result = db.prepare(`
        INSERT OR IGNORE INTO tags(name, tag_id, description, instrument_type, area, make, model, status, notes, created_at)
        VALUES (?,?,?,?,?,?,?,'active',?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      `).run(
        data.tag_id, data.tag_id, data.description || null,
        data.instrument_type || (data.tag_id || '').split('-')[0] || null,
        data.area || 'Default', data.make || null, data.model || null,
        data.notes || null
      );
      return { ok: true, id: result.lastInsertRowid };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  handle('tags:update', (data) => {
    try {
      db.prepare(`
        UPDATE tags SET
          description = ?, instrument_type = ?, area = ?,
          make = ?, model = ?, status = ?, notes = ?,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE tag_id = ? OR name = ?
      `).run(
        data.description || null, data.instrument_type || null,
        data.area || null, data.make || null, data.model || null,
        data.status || 'active', data.notes || null,
        data.tag_id, data.tag_id
      );
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  handle('tags:delete', (tagId) => {
    try {
      const tag = db.prepare('SELECT id FROM tags WHERE tag_id = ? OR name = ?').get(tagId, tagId);
      if (!tag) return { ok: false, error: 'Not found' };
      db.prepare('DELETE FROM issues WHERE document_id IN (SELECT id FROM documents WHERE tag_id = ?)').run(tag.id);
      db.prepare('UPDATE documents SET tag_id = NULL WHERE tag_id = ?').run(tag.id);
      db.prepare('DELETE FROM tags WHERE id = ?').run(tag.id);
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  handle('tags:copy', (tagId, newTagId) => {
    try {
      const src = db.prepare('SELECT * FROM tags WHERE tag_id = ? OR name = ?').get(tagId, tagId);
      if (!src) return { ok: false, error: 'Not found' };
      db.prepare(`
        INSERT OR IGNORE INTO tags(name, tag_id, description, instrument_type, area, make, model, status, notes, created_at)
        VALUES (?,?,?,?,?,?,?,?,?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      `).run(
        newTagId, newTagId, (src.description ? src.description + ' (copy)' : null),
        src.instrument_type, src.area, src.make, src.model, src.status, src.notes
      );
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  handle('tags:search', (query) => {
    try {
      const q = '%' + query + '%';
      const tags = db.prepare(`
        SELECT t.*,
          COUNT(DISTINCT d.id) as doc_count,
          COUNT(DISTINCT i.id) as issue_count
        FROM tags t
        LEFT JOIN documents d ON d.tag_id = t.id
        LEFT JOIN issues i ON i.document_id = d.id AND i.resolved = 0
        WHERE t.tag_id LIKE ? OR t.name LIKE ? OR t.description LIKE ?
          OR t.instrument_type LIKE ? OR t.area LIKE ? OR t.notes LIKE ?
        GROUP BY t.id
        ORDER BY t.tag_id, t.name
        LIMIT 100
      `).all(q, q, q, q, q, q);
      return { ok: true, tags };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  // ── Documents ────────────────────────────────────────────────────────────

  handle('docs:get', (tagId) => {
    const tag = db.prepare('SELECT id FROM tags WHERE name = ? OR id = ?').get(tagId, tagId);
    if (!tag) return [];
    return db.prepare(
      'SELECT * FROM documents WHERE tag_id = ? ORDER BY updated_at DESC'
    ).all(tag.id);
  });

  ipcMain.handle('docs:add', async (event, { filePath, tagId }) => {
    const filename = require('path').basename(filePath || '');
    const projectName = getConfig(db, 'current_project') ?? 'Default';
    try {
      console.log('[docs:add] starting for:', filePath, 'project:', projectName);
      const { indexFile } = await import('../indexing/pipeline.js');
      event.sender.send('index:progress', { filename, status: 'indexing' });
      console.log('[docs:add] calling indexFile...');
      const result = await indexFile(db, store, filePath, tagId || null, 'unknown', { filename, uploadedBy: 'engineer' });
      const { docId, chunksIndexed, ocrRequired } = result;
      try { db.prepare('UPDATE documents SET chunk_count = ?, project_name = ? WHERE id = ?').run(chunksIndexed, projectName, docId); } catch (_) {}

      // Auto-extract and register tag references
      try {
        const { extractTagReferences, isValidTag } = await import('../indexing/extractor.js');
        const allValues = db.prepare('SELECT field_value FROM extracted_values WHERE document_id = ?').all(docId);
        const allText = allValues.map(v => v.field_value).join(' ');
        const tagNumbers = extractTagReferences(allText).filter(isValidTag);
        for (const tagNum of tagNumbers) {
          try {
            db.prepare(`
              INSERT OR IGNORE INTO tags(name, tag_id, instrument_type, area, status, created_at)
              VALUES (?, ?, ?, 'Default', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
            `).run(tagNum, tagNum, tagNum.split('-')[0] || 'UNKNOWN');
          } catch (_) {}
        }
        console.log(`[tags] found ${tagNumbers.length} tags in ${filename}`);
      } catch (e) { console.warn('[tags] auto-extract failed:', e.message); }

      console.log('[docs:add] done:', { docId, chunksIndexed, ocrRequired });
      event.sender.send('index:progress', { filename, status: 'done', chunksIndexed, docId });
      return { ok: true, docId, chunksIndexed, ocrRequired };
    } catch (err) {
      console.error('[docs:add] error:', err.message);
      event.sender.send('index:progress', { filename, status: 'failed', error: err.message });
      return { ok: false, error: err.message };
    }
  });

  handle('docs:create', async (data) => {
    const { tagId, docType, fields, authorName } = data;
    return createDocument(db, repoPath, tagId, docType, fields, authorName);
  });

  handle('docs:edit', async (data) => {
    const { docId, fieldChanges, reason, authorName } = data;
    return editDocument(db, repoPath, docId, fieldChanges, reason, authorName);
  });

  // ── Issues ────────────────────────────────────────────────────────────────

  handle('issues:get', (tagId) => {
    const tag = db.prepare('SELECT id FROM tags WHERE name = ? OR id = ?').get(tagId, tagId);
    if (!tag) return [];
    return db.prepare(`
      SELECT i.* FROM issues i
      JOIN documents d ON d.id = i.document_id
      WHERE d.tag_id = ? AND i.resolved = 0
      ORDER BY i.created_at DESC
    `).all(tag.id);
  });

  handle('issues:update', (data) => {
    const { id, classification, comment } = data;
    const categoryMap = {
      ERROR: 'error', WARNING: 'warning', QUERY: 'info', ACCEPTED: 'resolved',
    };
    const severity = categoryMap[classification?.toUpperCase()] ?? 'info';
    const resolved = classification?.toUpperCase() === 'ACCEPTED' ? 1 : 0;

    db.prepare(`
      UPDATE issues SET
        severity    = ?,
        resolved    = ?,
        resolved_at = CASE WHEN ? = 1 THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE NULL END,
        updated_at  = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).run(severity, resolved, resolved, id);

    if (comment) {
      db.prepare(
        "INSERT INTO engineer_notes (document_id, author, note) SELECT document_id, 'engineer', ? FROM issues WHERE id = ?"
      ).run(comment, id);
    }

    return { ok: true };
  });

  handle('issues:run', async (tagId) => {
    if (tagId) return runAllRules(db, tagId);
    return runRulesForAll(db);
  });

  // ── Git ───────────────────────────────────────────────────────────────────

  handle('git:history', async () => {
    return getHistory(repoPath, null, 50);
  });

  handle('git:revert', async (hash) => {
    const authorName  = getConfig(db, 'engineer_name')  ?? 'ENGRAM';
    const authorEmail = getConfig(db, 'engineer_email') ?? 'engram@local';
    return revertCommit(repoPath, hash, authorName, authorEmail);
  });

  // ── Wiring ────────────────────────────────────────────────────────────────

  handle('wiring:get', async (tagId) => {
    const chain = await getWiringChain(db, tagId);
    if (!chain) return [];
    const rows = db.prepare(`
      SELECT wr.*, c.tag_number as cable_tag
      FROM wiring_records wr
      LEFT JOIN cables c ON c.id = wr.cable_id
      WHERE json_extract(wr.notes, '$.tag_id') = ?
      ORDER BY wr.created_at DESC
    `).all(String(tagId));
    return rows;
  });

  handle('wiring:save', async (session) => saveWiringRecord(db, session));

  handle('wiring:jb', async (jbRef) => getJBCrossmap(db, jbRef));

  handle('wiring:trace', async (data) => {
    const { card, channel } = data;
    return traceFromDCS(db, card, channel);
  });

  // ── Stage change ──────────────────────────────────────────────────────────

  handle('stage:change', (data) => {
    const { tagId, field, oldVal, newVal } = data;
    const raw    = getConfig(db, 'staged_changes');
    const staged = raw ? JSON.parse(raw) : [];
    staged.push({
      id:         `chg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      tag_id:     tagId,
      field_name: field,
      old_value:  oldVal,
      new_value:  newVal,
      staged_at:  new Date().toISOString(),
      status:     'pending',
    });
    setConfig(db, 'staged_changes', JSON.stringify(staged));
    return { ok: true };
  });

  // ── Add documents via file dialog ─────────────────────────────────────────

  handle('docs:addFromDialog', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Documents', extensions: ['pdf', 'docx', 'doc', 'xlsx', 'xls', 'txt'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) return { indexed: 0, failed: 0 };
    const results = await Promise.allSettled(
      result.filePaths.map(fp => indexFile(db, store, fp, null, null, {}))
    );
    const indexed = results.filter(r => r.status === 'fulfilled').length;
    const failed  = results.filter(r => r.status === 'rejected').length;
    return { indexed, failed };
  });

  // ── Re-index all source paths ─────────────────────────────────────────────

  handle('index:reindexAll', async () => {
    const raw   = getConfig(db, 'source_paths');
    const paths = raw ? JSON.parse(raw) : [];
    if (paths.length === 0) return { ok: true, message: 'No source paths configured.' };
    setConfig(db, 'index_status', 'indexing');
    Promise.allSettled(paths.map(p => indexFolder(db, store, p, {})))
      .then(results => {
        const totals = results.reduce(
          (acc, r) => {
            if (r.status === 'fulfilled') {
              acc.indexed += r.value.indexed ?? 0;
              acc.failed  += r.value.failed  ?? 0;
            }
            return acc;
          },
          { indexed: 0, failed: 0 }
        );
        setConfig(db, 'index_status', `done:${totals.indexed}:${totals.failed}`);
      })
      .catch(() => setConfig(db, 'index_status', 'error'));
    return { ok: true, paths };
  });

  // ── Standards & Policy documents ──────────────────────────────────────────
  // These handlers manage uploaded PDF/DOCX/Excel files that are treated as
  // authoritative reference material (IEC standards, company procedures, etc.).
  // Files are extracted, chunked, and stored in stdStore (a separate vectra
  // index at vectorindex_standards/) so they don't pollute the main document
  // index.  Key-value pairs from structured documents go into standards_extracted.
  // NOTE: This is distinct from the standards_registry table, which just stores
  // a notepad list of standard numbers used to prime the Claude system prompt.

  ipcMain.handle('standards:list', () => {
    try {
      const standards = db.prepare('SELECT * FROM standards_documents ORDER BY category, title').all();
      return { ok: true, standards };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('standards:add', async (_event, { filePath, title, category, version, effectiveDate, description, scope }) => {
    try {
      const path   = require('path');
      const fs     = require('fs');
      const crypto = require('crypto');
      const { extractText, extractStructuredRows, chunkText } = await import('../indexing/extractor.js');
      const { addStandard } = await import('../ai/vectorstore.js');

      const filename = path.basename(filePath);
      const checksum = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');

      const row = db.prepare(`
        INSERT INTO standards_documents(title, file_path, file_type, category, scope, version, effective_date, description, checksum, status, indexed_at)
        VALUES (?,?,?,?,?,?,?,?,?,'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      `).run(
        title || filename,
        filePath,
        path.extname(filePath).slice(1),
        category || 'General',
        scope || 'company',
        version || null,
        effectiveDate || null,
        description || null,
        checksum
      );
      const stdId = row.lastInsertRowid;

      const { text } = await extractText(filePath);
      const chunks   = chunkText(text, 512, 50);
      const pairs    = extractStructuredRows(text);

      for (const pair of pairs) {
        try {
          db.prepare('INSERT INTO standards_extracted(standard_id, field_name, field_value) VALUES (?,?,?)').run(stdId, pair.fieldName, pair.fieldValue);
        } catch (_) {}
      }

      let chunksIndexed = 0;
      for (let i = 0; i < chunks.length; i++) {
        if (stdStore) {
          await addStandard(stdStore, `${stdId}-${i}`, chunks[i], {
            standard_id: stdId, title: title || filename,
            category: category || 'General', chunk_index: i, filename,
          });
        }
        chunksIndexed++;
      }

      db.prepare('UPDATE standards_documents SET chunk_count = ? WHERE id = ?').run(chunksIndexed, stdId);
      console.log(`[standards] indexed ${chunksIndexed} chunks for ${filename}`);
      return { ok: true, stdId, chunksIndexed };
    } catch (e) {
      console.error('[standards:add] error:', e.message);
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('standards:delete', (_event, stdId) => {
    try {
      db.prepare('DELETE FROM standards_extracted WHERE standard_id = ?').run(stdId);
      db.prepare('DELETE FROM standards_documents WHERE id = ?').run(stdId);
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('standards:categories', () => {
    try {
      const cats = db.prepare('SELECT DISTINCT category FROM standards_documents ORDER BY category').all();
      return { ok: true, categories: cats.map(c => c.category) };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('standards:addFolder', async (_event, { folderPath, category, scope }) => {
    try {
      const fs   = require('fs');
      const path = require('path');
      const EXTS = new Set(['.pdf', '.docx', '.doc', '.xlsx', '.xls', '.txt']);
      const files = fs.readdirSync(folderPath)
        .filter(f => EXTS.has(path.extname(f).toLowerCase()));

      let queued = 0;
      for (const file of files) {
        const filePath = path.join(folderPath, file);
        // Fire-and-forget each file through the same handler
        ipcMain.emit('standards:add', null, null, { filePath, category: category || 'General', scope: scope || 'company' });
        queued++;
      }
      return { ok: true, queued };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  // ── Standards Registry (notepad of standard numbers for AI context) ──────

  ipcMain.handle('registry:list', () => {
    try {
      const rows = db.prepare(`
        SELECT * FROM standards_registry
        WHERE active = 1
        ORDER BY category, standard_number
      `).all();
      return { ok: true, standards: rows };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('registry:save', (_event, items) => {
    try {
      db.prepare('DELETE FROM standards_registry').run();
      const stmt = db.prepare(`
        INSERT INTO standards_registry(standard_number, standard_name, category, notes, active)
        VALUES (?,?,?,?,1)
      `);
      for (const item of (items ?? [])) {
        if (item.standard_number?.trim()) {
          stmt.run(
            item.standard_number.trim(),
            item.standard_name?.trim() || null,
            item.category?.trim()      || 'General',
            item.notes?.trim()         || null
          );
        }
      }
      return { ok: true, saved: items.length };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  // ── Index cleanup (remove orphaned records for deleted files) ─────────────

  handle('index:cleanup', async () => {
    try {
      const fs   = require('fs');
      const docs = db.prepare('SELECT id, title, file_path FROM documents').all();
      let cleaned = 0;
      for (const doc of docs) {
        if (doc.file_path && !doc.file_path.startsWith('manual')) {
          if (!fs.existsSync(doc.file_path)) {
            try {
              const { deleteDocument } = await import('../ai/vectorstore.js');
              await deleteDocument(store, doc.id);
            } catch (_) {}
            db.prepare('DELETE FROM extracted_values WHERE document_id = ?').run(doc.id);
            db.prepare('DELETE FROM issues WHERE document_id = ?').run(doc.id);
            db.prepare('DELETE FROM documents WHERE id = ?').run(doc.id);
            cleaned++;
            console.log('[cleanup] removed orphan:', doc.title);
          }
        }
      }
      return { ok: true, cleaned };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ── Workspace config file ──────────────────────────────────────────────────

  ipcMain.handle('workspace:openConfigFile', () => {
    require('child_process').exec('notepad C:\\engram\\workspace.config.json');
    return { ok: true };
  });

  ipcMain.handle('workspace:saveConfigFile', async () => {
    try {
      const { saveWorkspaceConfig } = await import('./workspace-config.js');
      await saveWorkspaceConfig(db);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ── File dialogs (called from UI buttons) ─────────────────────────────────

  ipcMain.handle('dialog:openFolder', async () => {
    const { dialog: d } = require('electron');
    const result = await d.showOpenDialog({ properties: ['openDirectory'] });
    if (result.canceled) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('dialog:openFiles', async () => {
    const { dialog: d } = require('electron');
    const result = await d.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Documents', extensions: ['pdf', 'docx', 'doc', 'xlsx', 'xls', 'txt'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (result.canceled) return [];
    return result.filePaths;
  });
}

module.exports = { registerIPCHandlers };
