const TIMESTAMP = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

/**
 * Read a single config value by key.
 * Returns the value string, or undefined if the key does not exist.
 */
export function getConfig(db, key) {
  const row = db.prepare('SELECT value FROM workspace_config WHERE key = ?').get(key);
  return row?.value;
}

/**
 * Upsert a config entry. Value is stored as text (JSON-stringify complex values
 * before passing if needed).
 */
export function setConfig(db, key, value) {
  db.prepare(`
    INSERT INTO workspace_config (key, value, updated_at)
    VALUES (?, ?, ${TIMESTAMP})
    ON CONFLICT(key) DO UPDATE SET
      value      = excluded.value,
      updated_at = ${TIMESTAMP}
  `).run(key, value);
}

/**
 * Return all config entries as a plain object { key: value, ... }.
 */
export function getAllConfig(db) {
  const rows = db.prepare('SELECT key, value FROM workspace_config').all();
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

/**
 * Seed the workspace with an initial config map.
 * Existing keys are left untouched (INSERT OR IGNORE).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Record<string, string>} config  - flat key/value map
 */
export function initWorkspace(db, config) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO workspace_config (key, value, updated_at)
    VALUES (?, ?, ${TIMESTAMP})
  `);

  const insertMany = db.transaction((entries) => {
    for (const [key, value] of entries) {
      insert.run(key, value);
    }
  });

  insertMany(Object.entries(config));
}
