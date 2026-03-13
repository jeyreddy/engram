//
// src/server/routes.js — Express route equivalents of every ipcMain.handle() in ipc.cjs
//
// MAPPING RULE:
//   ipcMain.handle("ns:verb", handler) → router.METHOD("/api/ns/verb", ...)
//   Read-only handlers → GET;  write / side-effect handlers → POST.
//
// DATA FLOW:
//   All routes share the db / store / stdStore / repoPath references that
//   are injected by registerRoutes().  No global state is held here.
//
// FILE UPLOADS:
//   docs:add      — upload.array('files') via multer; temp files in os.tmpdir()
//   standards:add — upload.single('file') via multer
//
// PROGRESS EVENTS:
//   Electron used event.sender.send('index:progress', ...) for live updates.
//   In web mode the HTTP response IS the final result; the client polls
//   /api/docs/list every 10 s to pick up newly indexed files.
//

import { Router }                                from 'express';
import { upload }                                from './upload.js';
import { readdirSync, readFileSync, existsSync, mkdirSync, copyFileSync, unlinkSync } from 'fs';
import { exec } from 'child_process';
import { basename, extname, join }               from 'path';
import { createHash }                            from 'crypto';

import { getConfig, setConfig, getAllConfig }     from '../db/workspace.js';
import { indexFile, indexFolder }                from '../indexing/pipeline.js';
import {
  searchDocuments, deleteDocument,
  addStandard, searchStandards,
}                                                from '../ai/vectorstore.js';
import { queryWithContext }                      from '../ai/claude.js';
import { runAllRules, runRulesForAll }           from '../rules/engine.js';
import { initRepo, getHistory, revertCommit }    from '../git/engine.js';
import {
  getWiringChain, saveWiringRecord,
  getJBCrossmap, traceFromDCS,
}                                                from '../wiring/engine.js';
import {
  extractText, extractStructuredRows, chunkText,
  extractTagReferences, isValidTag,
}                                                from '../indexing/extractor.js';

// ── Helper: index a single standards file into stdStore ──────────────────────

async function indexStandardFile(db, stdStore, filePath, { title, category, scope, version, effectiveDate, description } = {}) {
  const filename = basename(filePath);
  const checksum = createHash('sha256').update(readFileSync(filePath)).digest('hex');

  const row = db.prepare(`
    INSERT INTO standards_documents(title, file_path, file_type, category, scope, version, effective_date, description, checksum, status, indexed_at)
    VALUES (?,?,?,?,?,?,?,?,?,'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  `).run(
    title || filename,
    filePath,
    extname(filePath).slice(1),
    category || 'General',
    scope    || 'company',
    version  || null,
    effectiveDate || null,
    description   || null,
    checksum,
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
  return { stdId, chunksIndexed };
}

// ── Route factory ────────────────────────────────────────────────────────────

export function registerRoutes(app, db, store, stdStore, repoPath) {
  const router = Router();

  // ── Schema migrations (run once at startup) ────────────────────────────────
  // Wrap every ALTER in try/catch — SQLite throws "duplicate column name" if
  // the column already exists, which we intentionally swallow.
  // This mirrors the strategy in ipc.cjs so both Electron and web modes stay
  // schema-compatible with databases created by either entry point.

  try { db.prepare("ALTER TABLE documents ADD COLUMN project_name  TEXT    DEFAULT 'Default'").run(); } catch (_) {}
  try { db.prepare("ALTER TABLE documents ADD COLUMN chunk_count   INTEGER DEFAULT 0").run();          } catch (_) {}
  try { db.prepare("ALTER TABLE documents ADD COLUMN display_name  TEXT").run();                       } catch (_) {}
  try { db.prepare("ALTER TABLE documents ADD COLUMN description   TEXT").run();                       } catch (_) {}

  try { db.prepare("ALTER TABLE tags ADD COLUMN tag_id          TEXT").run();                          } catch (_) {}
  try { db.prepare("ALTER TABLE tags ADD COLUMN description     TEXT").run();                          } catch (_) {}
  try { db.prepare("ALTER TABLE tags ADD COLUMN instrument_type TEXT").run();                          } catch (_) {}
  try { db.prepare("ALTER TABLE tags ADD COLUMN area            TEXT DEFAULT 'Default'").run();        } catch (_) {}
  try { db.prepare("ALTER TABLE tags ADD COLUMN make            TEXT").run();                          } catch (_) {}
  try { db.prepare("ALTER TABLE tags ADD COLUMN model           TEXT").run();                          } catch (_) {}
  try { db.prepare("ALTER TABLE tags ADD COLUMN status          TEXT DEFAULT 'active'").run();         } catch (_) {}
  try { db.prepare("ALTER TABLE tags ADD COLUMN notes           TEXT").run();                          } catch (_) {}
  try { db.prepare("ALTER TABLE tags ADD COLUMN updated_at      TEXT").run();                          } catch (_) {}
  try { db.prepare("UPDATE tags SET tag_id = name WHERE tag_id IS NULL").run();                        } catch (_) {}

  try {
    db.prepare(`CREATE TABLE IF NOT EXISTS standards_documents (
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
    )`).run();
  } catch (_) {}

  try {
    db.prepare(`CREATE TABLE IF NOT EXISTS standards_extracted (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      standard_id INTEGER NOT NULL,
      field_name TEXT,
      field_value TEXT,
      context TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY(standard_id) REFERENCES standards_documents(id)
    )`).run();
  } catch (_) {}

  try {
    db.prepare(`CREATE TABLE IF NOT EXISTS standards_registry (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      standard_number TEXT    NOT NULL,
      standard_name   TEXT,
      category        TEXT    DEFAULT 'General',
      notes           TEXT,
      active          INTEGER DEFAULT 1,
      created_at      TEXT    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )`).run();
  } catch (_) {}

  try {
    db.prepare(`CREATE TABLE IF NOT EXISTS document_projects (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL,
      project_name TEXT   NOT NULL,
      added_at    TEXT    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE(document_id, project_name)
    )`).run();
  } catch (_) {}

  // Strip timestamp prefixes from titles written by earlier multer-based uploads.
  // Pattern: exactly 13 digits followed by a hyphen at the start of the title,
  // e.g. "1710000000000-datasheet.pdf" → "datasheet.pdf".
  try {
    const docs = db.prepare('SELECT id, title FROM documents').all();
    for (const doc of docs) {
      if (!doc.title || typeof doc.title !== 'string') continue;
      const cleaned = doc.title.replace(/^\d{13}-/, '');
      if (cleaned !== doc.title) {
        db.prepare('UPDATE documents SET title = ? WHERE id = ?').run(cleaned, doc.id);
      }
    }
  } catch (_) {}

  // ── Workspace ──────────────────────────────────────────────────────────────

  router.get('/api/workspace/config', (_req, res) => {
    try { res.json(getAllConfig(db)); }
    catch (e) { res.json({ error: e.message }); }
  });

  router.get('/api/workspace/key/:key', (req, res) => {
    try { res.json(getConfig(db, req.params.key)); }
    catch (e) { res.json({ error: e.message }); }
  });

  router.post('/api/workspace/save', (req, res) => {
    try {
      for (const [key, value] of Object.entries(req.body)) {
        setConfig(db, key, String(value));
      }
      res.json({ ok: true });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  router.post('/api/workspace/setup', async (req, res) => {
    try {
      const config = req.body;

      // Support both camelCase (from SetupWizard) and snake_case (from ConfigPanel)
      const nameMap = {
        engineerName:  'engineer_name',
        engineerEmail: 'engineer_email',
        plantName:     'plant_name',
        area:          'area',
      };

      for (const [key, value] of Object.entries(config)) {
        if (key === 'source_paths') continue;
        const storeKey = nameMap[key] ?? key;
        setConfig(db, storeKey, String(value));
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
            const t = results.reduce(
              (acc, r) => {
                if (r.status === 'fulfilled') { acc.indexed += r.value.indexed ?? 0; acc.failed += r.value.failed ?? 0; }
                return acc;
              },
              { indexed: 0, failed: 0 },
            );
            setConfig(db, 'index_status', `done:${t.indexed}:${t.failed}`);
          })
          .catch(() => setConfig(db, 'index_status', 'error'));
      }

      res.json({ ok: true });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  // No-op in web mode — there's no Notepad to open
  router.post('/api/workspace/openConfig', (_req, res) => res.json({ ok: true }));
  router.post('/api/workspace/saveConfig',  (_req, res) => res.json({ ok: true }));

  // ── Indexing ───────────────────────────────────────────────────────────────

  router.post('/api/index/trigger', async (req, res) => {
    const { folderPath } = req.body;
    setConfig(db, 'index_status', 'indexing');
    try {
      const result = await indexFolder(db, store, folderPath, {});
      setConfig(db, 'index_status', `done:${result.indexed}:${result.failed}`);
      res.json(result);
    } catch (e) {
      setConfig(db, 'index_status', 'error');
      res.json({ ok: false, error: e.message });
    }
  });

  router.get('/api/index/status', (_req, res) => {
    res.json(getConfig(db, 'index_status') ?? 'idle');
  });

  router.post('/api/index/reindexAll', async (req, res) => {
    const raw   = getConfig(db, 'source_paths');
    const paths = raw ? JSON.parse(raw) : [];
    if (paths.length === 0) return res.json({ ok: true, message: 'No source paths configured.' });

    setConfig(db, 'index_status', 'indexing');
    Promise.allSettled(paths.map(p => indexFolder(db, store, p, {})))
      .then(results => {
        const t = results.reduce(
          (acc, r) => {
            if (r.status === 'fulfilled') { acc.indexed += r.value.indexed ?? 0; acc.failed += r.value.failed ?? 0; }
            return acc;
          },
          { indexed: 0, failed: 0 },
        );
        setConfig(db, 'index_status', `done:${t.indexed}:${t.failed}`);
      })
      .catch(() => setConfig(db, 'index_status', 'error'));

    res.json({ ok: true, paths });
  });

  router.post('/api/index/cleanup', async (_req, res) => {
    try {
      const docs = db.prepare('SELECT id, title, file_path FROM documents').all();
      let cleaned = 0;
      for (const doc of docs) {
        if (doc.file_path && !doc.file_path.startsWith('manual') && !existsSync(doc.file_path)) {
          try { await deleteDocument(store, doc.id); } catch (_) {}
          db.prepare('DELETE FROM extracted_values WHERE document_id = ?').run(doc.id);
          db.prepare('DELETE FROM issues       WHERE document_id = ?').run(doc.id);
          db.prepare('DELETE FROM documents    WHERE id = ?').run(doc.id);
          cleaned++;
        }
      }
      res.json({ ok: true, cleaned });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  // ── Query / AI ─────────────────────────────────────────────────────────────

  router.post('/api/query/send', async (req, res) => {
    try {
      const userMessage = req.body.message ?? '';

      function getQueryK(msg) {
        const m = msg.toLowerCase();
        const listKw = ['list all','show all','all tags','all instruments','all valves','complete list','full list','everything','how many','count','what are all','give me all'];
        return listKw.some(kw => m.includes(kw)) ? 20 : 5;
      }
      const k = getQueryK(userMessage);

      let keywordChunks = [];

      const isCompleteListQuery =
        userMessage.toLowerCase().includes('list all') ||
        userMessage.toLowerCase().includes('all tags') ||
        userMessage.toLowerCase().includes('show all tags') ||
        userMessage.toLowerCase().includes('complete list');

      if (isCompleteListQuery) {
        try {
          const allTagRows = db.prepare(`
            SELECT ev.field_value as tag_value, ev.field_name,
                   d.title as filename, d.id as doc_id
            FROM extracted_values ev
            JOIN documents d ON d.id = ev.document_id
            WHERE (ev.field_name LIKE '%tag%' OR ev.field_name LIKE '%Tag%' OR ev.field_name = 'Equipment Number')
              AND ev.field_value IS NOT NULL AND ev.field_value != '' AND ev.field_value != '-'
              AND length(ev.field_value) > 1
            ORDER BY d.title, ev.field_value
          `).all();

          if (allTagRows.length > 0) {
            const byDoc = {};
            for (const row of allTagRows) {
              if (!byDoc[row.filename]) byDoc[row.filename] = [];
              byDoc[row.filename].push(row.tag_value);
            }
            for (const [filename, tags] of Object.entries(byDoc)) {
              const uniqueTags = [...new Set(tags)]
                .filter(t => {
                  if (!t) return false;
                  const v = t.toString().trim();
                  if (v.endsWith('W') && /^\d/.test(v)) return false;
                  if (v.includes('W/ft')) return false;
                  if (/^\d{1,2}$/.test(v)) return false;
                  return true;
                })
                .sort();
              keywordChunks.unshift({
                metadata: { filename, doc_type: 'complete_tag_list', source: 'database_direct' },
                text: `Complete tag list from ${filename}:\n` + uniqueTags.join('\n'),
              });
            }
          }
        } catch (e) { console.error('[query] direct tag list error:', e.message); }
      }

      // Also inject a flat tag registry chunk for tag/instrument queries
      const isTagListQuery =
        userMessage.toLowerCase().includes('tag') ||
        userMessage.toLowerCase().includes('instrument');

      if (isTagListQuery) {
        try {
          const tagRows = db.prepare(`
            SELECT DISTINCT ev.field_value as tag_id, d.title as filename
            FROM extracted_values ev
            JOIN documents d ON d.id = ev.document_id
            WHERE ev.field_name = 'Tag' AND ev.field_value IS NOT NULL
            ORDER BY ev.field_value
            LIMIT 200
          `).all();

          if (tagRows.length > 0) {
            const tagList = tagRows.map(r => r.tag_id).join(', ');
            keywordChunks.unshift({
              metadata: { filename: 'Tag Registry (extracted)', doc_type: 'registry' },
              text: 'All tags found in documents: ' + tagList,
            });
          }
        } catch (e) { console.warn('[query] tag registry chunk failed:', e.message); }
      }

      let vectorChunks = [];
      try { vectorChunks = await searchDocuments(store, userMessage, k); }
      catch (e) { console.warn('[query] vector search failed:', e.message); }

      const words = userMessage.toLowerCase().split(/\s+/).filter(w => w.length > 2);
      if (words.length > 0) {
        const conditions = words.map(() => 'lower(ev.field_value) LIKE ?').join(' OR ');
        const params     = words.map(w => `%${w}%`);
        try {
          const rows = db.prepare(`
            SELECT DISTINCT d.title, d.file_type, d.revision, ev.field_name, ev.field_value, ev.page_ref
            FROM extracted_values ev
            JOIN documents d ON d.id = ev.document_id
            WHERE ${conditions}
            LIMIT ${k > 5 ? 50 : 20}
          `).all(...params);

          if (rows.length > 0) {
            const grouped = {};
            for (const row of rows) {
              if (!grouped[row.title]) grouped[row.title] = [];
              grouped[row.title].push(`${row.field_name}: ${row.field_value}`);
            }
            for (const [title, fields] of Object.entries(grouped)) {
              keywordChunks.push({ metadata: { filename: title, doc_type: 'extracted' }, text: fields.join('\n') });
            }
          }
        } catch (e) { console.error('[query] keyword search error:', e.message); }
      }

      let standardsChunks = [];
      if (stdStore) {
        try {
          const stdResults = await searchStandards(stdStore, userMessage, 5);
          standardsChunks = stdResults.map(r => ({
            metadata: { filename: r.metadata?.title ?? r.metadata?.filename ?? 'Standard', doc_type: 'STANDARD/POLICY', category: r.metadata?.category ?? null },
            text: r.metadata?.text ?? '',
          })).filter(c => c.text.length > 0);
        } catch (e) { console.warn('[query] standards search failed:', e.message); }
      }

      const allChunks = [...standardsChunks, ...keywordChunks, ...vectorChunks];

      let registryContext = '';
      try {
        const registryRows = db.prepare(`
          SELECT standard_number, standard_name, category, notes
          FROM standards_registry WHERE active = 1 ORDER BY category, standard_number
        `).all();
        if (registryRows.length > 0) {
          registryContext =
            'APPLICABLE STANDARDS & CODES:\n' +
            registryRows.map(r =>
              `- ${r.standard_number}` +
              (r.standard_name ? `: ${r.standard_name}` : '') +
              (r.notes ? ` (${r.notes})` : '')
            ).join('\n') +
            '\n\nWhen reviewing documents, check compliance against these standards. Use your knowledge of each standard to identify gaps or violations.\n';
        }
      } catch (e) { console.warn('[query] registry fetch failed:', e.message); }

      const answer = await queryWithContext(db, userMessage, allChunks, registryContext || undefined);
      res.json({ ok: true, response: String(answer) });
    } catch (e) {
      console.error('[query:send] error:', e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── Docs ───────────────────────────────────────────────────────────────────

  router.get('/api/docs/list', (_req, res) => {
    try {
      const docs = db.prepare(`
        SELECT d.id, d.title, d.file_type, d.revision, d.project_name,
               d.created_at, d.chunk_count, d.tag_id, d.display_name, d.description,
               d.file_path,
               COUNT(ev.id) as field_count
        FROM documents d
        LEFT JOIN extracted_values ev ON ev.document_id = d.id
        GROUP BY d.id
        ORDER BY d.created_at DESC
      `).all();
      const statusRow = db.prepare("SELECT value FROM workspace_config WHERE key = 'index_status'").get();
      res.json({ ok: true, docs, indexStatus: statusRow?.value ?? 'idle' });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  // Upload one or more files via multipart form data
  router.post('/api/docs/add', upload.array('files'), async (req, res) => {
    const projectName = getConfig(db, 'current_project') ?? 'Default';
    const tagId       = req.body.tagId ? Number(req.body.tagId) : null;
    const results     = [];

    // Ensure permanent uploads directory exists inside the workspace
    const uploadsDir = join(repoPath, 'uploads');
    mkdirSync(uploadsDir, { recursive: true });

    for (const file of (req.files ?? [])) {
      const originalName = String(file.originalname || basename(file.path));
      // Move from OS temp dir → workspace/uploads/<originalname>
      const destPath = join(uploadsDir, originalName);
      try { copyFileSync(file.path, destPath); } catch (_) {}
      try { unlinkSync(file.path); } catch (_) {}

      try {
        const result = await indexFile(db, store, destPath, tagId, 'unknown', {
          filename:   originalName,
          uploadedBy: 'engineer',
        });
        const { docId, chunksIndexed, ocrRequired } = result;
        // Ensure title and project are correct (indexFile uses basename which may differ)
        try { db.prepare('UPDATE documents SET title = ?, chunk_count = ?, project_name = ? WHERE id = ?').run(originalName, chunksIndexed, projectName, docId); } catch (_) {}

        // Auto-extract tag references
        try {
          const allValues  = db.prepare('SELECT field_value FROM extracted_values WHERE document_id = ?').all(docId);
          const allText    = allValues.map(v => v.field_value).join(' ');
          const tagNumbers = extractTagReferences(allText).filter(isValidTag);
          for (const tagNum of tagNumbers) {
            try {
              db.prepare(`INSERT OR IGNORE INTO tags(name, tag_id, instrument_type, area, status, created_at) VALUES (?,?,?,'Default','active',strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(tagNum, tagNum, tagNum.split('-')[0] || 'UNKNOWN');
            } catch (_) {}
          }
        } catch (e) { console.warn('[docs:add] auto-extract failed:', e.message); }

        results.push({ ok: true, filename: file.originalname, docId, chunksIndexed, ocrRequired });
      } catch (e) {
        results.push({ ok: false, filename: file.originalname, error: e.message });
      }
    }

    res.json({ ok: true, results });
  });

  router.post('/api/docs/open', (req, res) => {
    const { filePath } = req.body;
    if (!filePath) return res.json({ ok: false, error: 'filePath required' });
    if (!existsSync(filePath)) return res.json({ ok: false, error: 'File not found on server' });
    const cmd = process.platform === 'win32'
      ? `start "" "${filePath.replace(/"/g, '\\"')}"`
      : process.platform === 'darwin'
      ? `open "${filePath.replace(/"/g, '\\"')}"`
      : `xdg-open "${filePath.replace(/"/g, '\\"')}"`;
    exec(cmd, err => {
      if (err) res.json({ ok: false, error: err.message });
      else      res.json({ ok: true });
    });
  });

  router.post('/api/docs/delete', async (req, res) => {
    const { docId } = req.body;
    try {
      const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(docId);
      if (!doc) return res.json({ ok: false, error: 'Not found' });
      try { await deleteDocument(store, docId); } catch (_) {}
      db.prepare('DELETE FROM extracted_values WHERE document_id = ?').run(docId);
      db.prepare('DELETE FROM issues           WHERE document_id = ?').run(docId);
      db.prepare('DELETE FROM documents        WHERE id = ?').run(docId);
      res.json({ ok: true, filename: doc.title });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  router.post('/api/docs/rename', (req, res) => {
    const { docId, displayName, description } = req.body;
    try {
      db.prepare('UPDATE documents SET display_name = ?, description = ? WHERE id = ?').run(
        displayName || null, description || null, docId,
      );
      res.json({ ok: true });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  router.get('/api/docs/fields/:docId', (req, res) => {
    try {
      const fields = db.prepare('SELECT field_name, field_value FROM extracted_values WHERE document_id = ? LIMIT 10').all(Number(req.params.docId));
      res.json({ ok: true, fields });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  router.post('/api/docs/get', (req, res) => {
    const { tagId } = req.body;
    const tag = db.prepare('SELECT id FROM tags WHERE name = ? OR id = ?').get(tagId, tagId);
    if (!tag) return res.json([]);
    res.json(db.prepare('SELECT * FROM documents WHERE tag_id = ? ORDER BY updated_at DESC').all(tag.id));
  });

  router.post('/api/docs/addToProject', (req, res) => {
    const { docId, projectName } = req.body;
    try {
      db.prepare("UPDATE documents SET project_name = ? WHERE id = ?").run(projectName || 'Default', docId);
      res.json({ ok: true });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  router.post('/api/docs/removeFromProject', (req, res) => {
    const { docId } = req.body;
    try {
      db.prepare("UPDATE documents SET project_name = 'Default' WHERE id = ?").run(docId);
      res.json({ ok: true });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  // ── Projects ───────────────────────────────────────────────────────────────

  router.get('/api/projects/list', (_req, res) => {
    try {
      const rows    = db.prepare("SELECT DISTINCT project_name FROM documents WHERE project_name IS NOT NULL ORDER BY project_name").all();
      const fromDocs = rows.map(r => r.project_name).filter(Boolean);
      const savedRaw = getConfig(db, 'projects');
      const saved    = savedRaw ? JSON.parse(savedRaw) : ['Default'];
      const all      = [...new Set(['Default', ...saved, ...fromDocs])].sort(
        (a, b) => a === 'Default' ? -1 : b === 'Default' ? 1 : a.localeCompare(b),
      );
      res.json({ ok: true, projects: all });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  router.post('/api/projects/create', (req, res) => {
    const { name } = req.body;
    if (!name?.trim()) return res.json({ ok: false, error: 'Name required' });
    try {
      const savedRaw = getConfig(db, 'projects');
      const saved    = savedRaw ? JSON.parse(savedRaw) : ['Default'];
      if (!saved.includes(name)) { saved.push(name); setConfig(db, 'projects', JSON.stringify(saved)); }
      res.json({ ok: true });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  router.post('/api/projects/setCurrent', (req, res) => {
    try {
      setConfig(db, 'current_project', req.body.name ?? 'Default');
      res.json({ ok: true });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  router.get('/api/projects/getCurrent', (_req, res) => {
    res.json(getConfig(db, 'current_project') ?? 'Default');
  });

  // ── Tags ───────────────────────────────────────────────────────────────────

  router.get('/api/tags/list', (_req, res) => {
    try {
      const tags = db.prepare(`
        SELECT t.*, COUNT(DISTINCT d.id) as doc_count, COUNT(DISTINCT i.id) as issue_count
        FROM tags t
        LEFT JOIN documents d ON d.tag_id = t.id
        LEFT JOIN issues i ON i.document_id = d.id AND i.resolved = 0
        GROUP BY t.id ORDER BY t.tag_id, t.name
      `).all();
      res.json(tags.map(t => ({ ...t, docCount: t.doc_count, issueCount: t.issue_count, errorCount: 0, coverage: Math.min(100, (t.doc_count ?? 0) * 20) })));
    } catch (e) { res.json([]); }
  });

  router.post('/api/tags/get', (req, res) => {
    const { tagId } = req.body;
    try {
      const tag = db.prepare(`
        SELECT t.*, COUNT(DISTINCT d.id) as doc_count, COUNT(DISTINCT i.id) as issue_count
        FROM tags t
        LEFT JOIN documents d ON d.tag_id = t.id
        LEFT JOIN issues i ON i.document_id = d.id AND i.resolved = 0
        WHERE t.tag_id = ? OR t.name = ? GROUP BY t.id
      `).get(tagId, tagId);
      const docs = tag ? db.prepare('SELECT id, title, file_type, revision, created_at FROM documents WHERE tag_id = ? ORDER BY created_at DESC').all(tag.id) : [];
      res.json({ ok: true, tag, docs });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  router.post('/api/tags/create', (req, res) => {
    try {
      const data   = req.body;
      const result = db.prepare(`
        INSERT OR IGNORE INTO tags(name, tag_id, description, instrument_type, area, make, model, status, notes, created_at)
        VALUES (?,?,?,?,?,?,?,'active',?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      `).run(
        data.tag_id, data.tag_id, data.description || null,
        data.instrument_type || (data.tag_id || '').split('-')[0] || null,
        data.area || 'Default', data.make || null, data.model || null, data.notes || null,
      );
      res.json({ ok: true, id: result.lastInsertRowid });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  router.post('/api/tags/update', (req, res) => {
    try {
      const data = req.body;
      db.prepare(`
        UPDATE tags SET description=?, instrument_type=?, area=?, make=?, model=?, status=?, notes=?,
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE tag_id = ? OR name = ?
      `).run(
        data.description || null, data.instrument_type || null, data.area || null,
        data.make || null, data.model || null, data.status || 'active', data.notes || null,
        data.tag_id, data.tag_id,
      );
      res.json({ ok: true });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  router.post('/api/tags/delete', (req, res) => {
    const { tagId } = req.body;
    try {
      const tag = db.prepare('SELECT id FROM tags WHERE tag_id = ? OR name = ?').get(tagId, tagId);
      if (!tag) return res.json({ ok: false, error: 'Not found' });
      db.prepare('DELETE FROM issues WHERE document_id IN (SELECT id FROM documents WHERE tag_id = ?)').run(tag.id);
      db.prepare('UPDATE documents SET tag_id = NULL WHERE tag_id = ?').run(tag.id);
      db.prepare('DELETE FROM tags WHERE id = ?').run(tag.id);
      res.json({ ok: true });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  router.post('/api/tags/copy', (req, res) => {
    const { tagId, newTagId } = req.body;
    try {
      const src = db.prepare('SELECT * FROM tags WHERE tag_id = ? OR name = ?').get(tagId, tagId);
      if (!src) return res.json({ ok: false, error: 'Not found' });
      db.prepare(`
        INSERT OR IGNORE INTO tags(name, tag_id, description, instrument_type, area, make, model, status, notes, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      `).run(
        newTagId, newTagId, (src.description ? src.description + ' (copy)' : null),
        src.instrument_type, src.area, src.make, src.model, src.status, src.notes,
      );
      res.json({ ok: true });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  router.post('/api/tags/search', (req, res) => {
    const { query } = req.body;
    try {
      const q    = `%${query}%`;
      const tags = db.prepare(`
        SELECT t.*, COUNT(DISTINCT d.id) as doc_count, COUNT(DISTINCT i.id) as issue_count
        FROM tags t
        LEFT JOIN documents d ON d.tag_id = t.id
        LEFT JOIN issues i ON i.document_id = d.id AND i.resolved = 0
        WHERE t.tag_id LIKE ? OR t.name LIKE ? OR t.description LIKE ?
          OR t.instrument_type LIKE ? OR t.area LIKE ? OR t.notes LIKE ?
        GROUP BY t.id ORDER BY t.tag_id, t.name LIMIT 100
      `).all(q, q, q, q, q, q);
      res.json({ ok: true, tags });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  // ── Issues ─────────────────────────────────────────────────────────────────

  router.post('/api/issues/get', (req, res) => {
    const { tagId } = req.body;
    const tag = db.prepare('SELECT id FROM tags WHERE name = ? OR id = ?').get(tagId, tagId);
    if (!tag) return res.json([]);
    res.json(db.prepare(`
      SELECT i.* FROM issues i JOIN documents d ON d.id = i.document_id
      WHERE d.tag_id = ? AND i.resolved = 0 ORDER BY i.created_at DESC
    `).all(tag.id));
  });

  router.post('/api/issues/update', (req, res) => {
    const { id, classification, comment } = req.body;
    try {
      const categoryMap = { ERROR: 'error', WARNING: 'warning', QUERY: 'info', ACCEPTED: 'resolved' };
      const severity    = categoryMap[classification?.toUpperCase()] ?? 'info';
      const resolved    = classification?.toUpperCase() === 'ACCEPTED' ? 1 : 0;
      db.prepare(`
        UPDATE issues SET severity=?, resolved=?,
          resolved_at=CASE WHEN ?=1 THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE NULL END,
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?
      `).run(severity, resolved, resolved, id);
      if (comment) {
        db.prepare("INSERT INTO engineer_notes(document_id, author, note) SELECT document_id,'engineer',? FROM issues WHERE id=?").run(comment, id);
      }
      res.json({ ok: true });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  router.post('/api/issues/run', async (req, res) => {
    try {
      const { tagId } = req.body;
      const result = tagId ? await runAllRules(db, tagId) : await runRulesForAll(db);
      res.json(result);
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  // ── Git ────────────────────────────────────────────────────────────────────

  router.get('/api/git/history', async (_req, res) => {
    try { res.json(await getHistory(repoPath, null, 50)); }
    catch (e) { res.json([]); }
  });

  router.post('/api/git/revert', async (req, res) => {
    const { hash } = req.body;
    try {
      const authorName  = getConfig(db, 'engineer_name')  ?? 'ENGRAM';
      const authorEmail = getConfig(db, 'engineer_email') ?? 'engram@local';
      res.json(await revertCommit(repoPath, hash, authorName, authorEmail));
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  // ── Wiring ─────────────────────────────────────────────────────────────────

  router.post('/api/wiring/get', async (req, res) => {
    const { tagId } = req.body;
    try {
      const chain = await getWiringChain(db, tagId);
      if (!chain) return res.json([]);
      const rows = db.prepare(`
        SELECT wr.*, c.tag_number as cable_tag FROM wiring_records wr
        LEFT JOIN cables c ON c.id = wr.cable_id
        WHERE json_extract(wr.notes, '$.tag_id') = ? ORDER BY wr.created_at DESC
      `).all(String(tagId));
      res.json(rows);
    } catch (e) { res.json([]); }
  });

  router.post('/api/wiring/save', async (req, res) => {
    try { res.json(await saveWiringRecord(db, req.body)); }
    catch (e) { res.json({ ok: false, error: e.message }); }
  });

  router.post('/api/wiring/jb', async (req, res) => {
    try { res.json(await getJBCrossmap(db, req.body.jbRef)); }
    catch (e) { res.json({ ok: false, error: e.message }); }
  });

  router.post('/api/wiring/trace', async (req, res) => {
    try { res.json(await traceFromDCS(db, req.body.card, req.body.channel)); }
    catch (e) { res.json({ ok: false, error: e.message }); }
  });

  // ── Stage change ───────────────────────────────────────────────────────────

  router.post('/api/stage/change', (req, res) => {
    const { tagId, field, oldVal, newVal } = req.body;
    try {
      const raw    = getConfig(db, 'staged_changes');
      const staged = raw ? JSON.parse(raw) : [];
      staged.push({
        id: `chg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        tag_id: tagId, field_name: field, old_value: oldVal, new_value: newVal,
        staged_at: new Date().toISOString(), status: 'pending',
      });
      setConfig(db, 'staged_changes', JSON.stringify(staged));
      res.json({ ok: true });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  // ── Standards & Policy documents ───────────────────────────────────────────

  router.get('/api/standards/list', (_req, res) => {
    try {
      const standards = db.prepare('SELECT * FROM standards_documents ORDER BY category, title').all();
      res.json({ ok: true, standards });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  // Single file upload for a standard document
  router.post('/api/standards/add', upload.single('file'), async (req, res) => {
    try {
      const file = req.file;
      if (!file) return res.json({ ok: false, error: 'No file uploaded' });

      const { title, category, version, effectiveDate, description, scope } = req.body;

      // Pre-check extraction quality before committing to DB
      const { text: previewText } = await extractText(file.path);
      const charCount = (previewText || '').trim().length;

      if (charCount < 100) {
        return res.json({
          ok: false,
          error: `Extraction failed — only ${charCount} characters extracted from this file. It may be a scanned PDF with no text layer. OCR support coming soon.`,
          charCount,
        });
      }

      const result = await indexStandardFile(db, stdStore, file.path, {
        title, category, version, effectiveDate, description, scope,
      });
      res.json({ ok: true, ...result, charCount });
    } catch (e) {
      console.error('[standards:add] error:', e.message);
      res.json({ ok: false, error: e.message });
    }
  });

  router.post('/api/standards/delete', (req, res) => {
    const { stdId } = req.body;
    try {
      db.prepare('DELETE FROM standards_extracted  WHERE standard_id = ?').run(stdId);
      db.prepare('DELETE FROM standards_documents WHERE id = ?').run(stdId);
      res.json({ ok: true });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  router.get('/api/standards/categories', (_req, res) => {
    try {
      const cats = db.prepare('SELECT DISTINCT category FROM standards_documents ORDER BY category').all();
      res.json({ ok: true, categories: cats.map(c => c.category) });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  // Process all supported files in a server-side folder path
  router.post('/api/standards/addFolder', async (req, res) => {
    const { folderPath, category, scope } = req.body;
    if (!folderPath) return res.json({ ok: false, error: 'folderPath required' });
    try {
      const EXTS  = new Set(['.pdf', '.docx', '.doc', '.xlsx', '.xls', '.txt']);
      const files = readdirSync(folderPath).filter(f => EXTS.has(extname(f).toLowerCase()));
      const queued = files.length;

      // Fire-and-forget — client polls for updates
      (async () => {
        for (const file of files) {
          const filePath = join(folderPath, file);
          try { await indexStandardFile(db, stdStore, filePath, { category: category || 'General', scope: scope || 'company' }); }
          catch (e) { console.error('[standards:addFolder]', file, e.message); }
        }
      })().catch(console.error);

      res.json({ ok: true, queued });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  // ── Standards Registry ─────────────────────────────────────────────────────

  router.get('/api/registry/list', (_req, res) => {
    try {
      const rows = db.prepare('SELECT * FROM standards_registry WHERE active = 1 ORDER BY category, standard_number').all();
      res.json({ ok: true, standards: rows });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  router.post('/api/registry/save', (req, res) => {
    const items = Array.isArray(req.body) ? req.body : [];
    try {
      db.prepare('DELETE FROM standards_registry').run();
      const stmt = db.prepare('INSERT INTO standards_registry(standard_number, standard_name, category, notes, active) VALUES (?,?,?,?,1)');
      for (const item of items) {
        if (item.standard_number?.trim()) {
          stmt.run(
            item.standard_number.trim(),
            item.standard_name?.trim() || null,
            item.category?.trim()      || 'General',
            item.notes?.trim()         || null,
          );
        }
      }
      res.json({ ok: true, saved: items.length });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  app.use(router);
}
