'use strict';

let ipcMain, dialog;

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

async function registerIPCHandlers(db, store, repoPath) {
  // Load Electron APIs via ESM import (CJS require hits the npm stub)
  ({ ipcMain, dialog } = await import('electron'));

  // Dynamic imports for all ESM modules
  const { getConfig, setConfig, getAllConfig } = await import('../db/workspace.js');
  const { initRepo, getHistory, revertCommit } = await import('../git/engine.js');
  const { indexFile, indexFolder }             = await import('../indexing/pipeline.js');
  // searchDocuments and queryWithContext are imported inside query:send handler
  const { runAllRules, runRulesForAll }        = await import('../rules/engine.js');
  const {
    getWiringChain, saveWiringRecord,
    getJBCrossmap, traceFromDCS,
  } = await import('../wiring/engine.js');
  const { createDocument, editDocument } = await import('../documents/author.js');

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
      const { searchDocuments }  = await import('../ai/vectorstore.js');
      const { queryWithContext } = await import('../ai/claude.js');

      // Vector search
      let vectorChunks = [];
      try {
        vectorChunks = await searchDocuments(store, userMessage, 5);
        console.log('[query] first vector chunk:', JSON.stringify(vectorChunks[0]));
      } catch (e) {
        console.warn('[query] vector search failed:', e.message);
      }

      // Keyword search against extracted_values
      const words = userMessage.toLowerCase()
        .split(/\s+/)
        .filter(w => w.length > 2);

      let keywordChunks = [];
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
            LIMIT 20
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

      const allChunks = [...keywordChunks, ...vectorChunks];
      console.log('[query] keyword chunks:', keywordChunks.length, '| vector chunks:', vectorChunks.length);

      return queryWithContext(db, userMessage, allChunks);
    } catch (err) {
      console.error('[query:send] error:', err.message);
      throw err;
    }
  });

  // ── Tags ──────────────────────────────────────────────────────────────────

  handle('tags:get', (area) => {
    let rows;
    if (area) {
      rows = db.prepare(
        "SELECT * FROM tags WHERE name LIKE ? ORDER BY name"
      ).all(`${area}%`);
    } else {
      rows = db.prepare('SELECT * FROM tags ORDER BY name').all();
    }

    return rows.map(tag => {
      const docCount = db.prepare(
        'SELECT COUNT(*) as c FROM documents WHERE tag_id = ?'
      ).get(tag.id)?.c ?? 0;

      const issueCount = db.prepare(`
        SELECT COUNT(*) as c FROM issues i
        JOIN documents d ON d.id = i.document_id
        WHERE d.tag_id = ? AND i.resolved = 0
      `).get(tag.id)?.c ?? 0;

      const errorCount = db.prepare(`
        SELECT COUNT(*) as c FROM issues i
        JOIN documents d ON d.id = i.document_id
        WHERE d.tag_id = ? AND i.severity = 'error' AND i.resolved = 0
      `).get(tag.id)?.c ?? 0;

      return { ...tag, docCount, issueCount, errorCount, coverage: Math.min(100, docCount * 20) };
    });
  });

  handle('tags:getOne', (tagId) =>
    db.prepare('SELECT * FROM tags WHERE name = ?').get(tagId) ?? null
  );

  handle('tags:create', (data) => {
    const { name, color } = data;
    const result = db.prepare(
      'INSERT OR IGNORE INTO tags (name, color) VALUES (?, ?) RETURNING id'
    ).get(name, color ?? null);
    return result ?? db.prepare('SELECT * FROM tags WHERE name = ?').get(name);
  });

  // ── Documents ────────────────────────────────────────────────────────────

  handle('docs:get', (tagId) => {
    const tag = db.prepare('SELECT id FROM tags WHERE name = ? OR id = ?').get(tagId, tagId);
    if (!tag) return [];
    return db.prepare(
      'SELECT * FROM documents WHERE tag_id = ? ORDER BY updated_at DESC'
    ).all(tag.id);
  });

  ipcMain.handle('docs:add', async (_event, { filePath, tagId }) => {
    try {
      console.log('[docs:add] starting for:', filePath);
      const { indexFile } = await import('../indexing/pipeline.js');
      const p        = require('path');
      const filename = p.basename(filePath);
      console.log('[docs:add] calling indexFile...');
      const result   = await indexFile(db, store, filePath, tagId || null, 'unknown', { filename, uploadedBy: 'engineer' });
      const { docId, chunksIndexed, ocrRequired } = result;
      console.log('[docs:add] done:', { docId, chunksIndexed, ocrRequired });
      return { ok: true, docId, chunksIndexed, ocrRequired };
    } catch (err) {
      console.error('[docs:add] error:', err.message);
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
