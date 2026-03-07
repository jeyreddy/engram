import { createRequire } from 'module';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';

const require = createRequire(import.meta.url);
const initSqlJs = require('sql.js');

// ---------------------------------------------------------------------------
// Adapter — presents a better-sqlite3-compatible surface over sql.js so that
// every downstream caller (workspace.js, rules/engine.js, ipc.js, etc.)
// works without modification.
// ---------------------------------------------------------------------------

/**
 * Convert better-sqlite3-style spread arguments into the array that
 * sql.js stmt.bind() expects.
 *   run(a, b, c)    → [a, b, c]
 *   run({k: v})     → {$k: v}   (named — adds $ prefix)
 *   run()           → null      (no bind call made)
 */
function toBindParams(args) {
  if (args.length === 0) return null;

  // Single plain-object argument → named params (add $ prefix if absent)
  if (
    args.length === 1 &&
    args[0] !== null &&
    typeof args[0] === 'object' &&
    !Array.isArray(args[0])
  ) {
    const named = {};
    for (const [k, v] of Object.entries(args[0])) {
      named[k.startsWith('$') ? k : `$${k}`] = v ?? null;
    }
    return named;
  }

  // Positional — flatten one level (handles both spread and single-array)
  return args.map(v => v ?? null);
}

class SqlJsAdapter {
  constructor(sqlDb, savePath) {
    this._db    = sqlDb;
    this._path  = savePath;
    this._inTx  = false;
  }

  /** Persist the in-memory database to disk. */
  _save() {
    const data = this._db.export();
    writeFileSync(this._path, Buffer.from(data));
  }

  /** Save only when we are not inside an explicit transaction. */
  _afterWrite() {
    if (!this._inTx) this._save();
  }

  /**
   * Execute one or more SQL statements with no parameters (DDL, pragmas).
   * Mirrors better-sqlite3 db.exec().
   */
  exec(sql) {
    this._db.exec(sql);
    this._afterWrite();
    return this;
  }

  /**
   * Prepare a statement and return an object with run / get / all methods
   * that match the better-sqlite3 prepared-statement API.
   */
  prepare(sql) {
    const self = this;

    return {
      /**
       * Execute a write statement (INSERT / UPDATE / DELETE).
       * Returns { changes } like better-sqlite3.
       */
      run(...args) {
        const params = toBindParams(args);
        if (params !== null) {
          self._db.run(sql, params);
        } else {
          self._db.run(sql);
        }
        self._afterWrite();
        return { changes: self._db.getRowsModified() };
      },

      /**
       * Execute and return the first result row, or undefined.
       * Works for SELECT and for INSERT … RETURNING.
       */
      get(...args) {
        const stmt   = self._db.prepare(sql);
        const params = toBindParams(args);
        if (params !== null) stmt.bind(params);

        let row = undefined;
        if (stmt.step()) {
          row = stmt.getAsObject();
        }
        stmt.free();

        // If the SQL is a write with RETURNING, persist the change.
        if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) {
          self._afterWrite();
        }

        return row;
      },

      /**
       * Execute and return all result rows as an array.
       * Works for SELECT.
       */
      all(...args) {
        const stmt   = self._db.prepare(sql);
        const params = toBindParams(args);
        if (params !== null) stmt.bind(params);

        const rows = [];
        while (stmt.step()) {
          rows.push(stmt.getAsObject());
        }
        stmt.free();
        return rows;
      },
    };
  }

  /**
   * Wrap a function in a BEGIN / COMMIT transaction, matching the
   * better-sqlite3 db.transaction(fn) → callable pattern.
   */
  transaction(fn) {
    return (...args) => {
      this._db.run('BEGIN');
      this._inTx = true;
      try {
        const result = fn(...args);
        this._db.run('COMMIT');
        this._inTx = false;
        this._save();
        return result;
      } catch (err) {
        this._db.run('ROLLBACK');
        this._inTx = false;
        throw err;
      }
    };
  }
}

// ---------------------------------------------------------------------------
// Schema DDL — unchanged from original
// ---------------------------------------------------------------------------

const DDL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tags (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL UNIQUE,
  color       TEXT,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS documents (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  title         TEXT    NOT NULL,
  file_path     TEXT    NOT NULL UNIQUE,
  file_type     TEXT    NOT NULL,
  tag_id        INTEGER REFERENCES tags(id) ON DELETE SET NULL,
  checksum      TEXT,
  revision      TEXT,
  status        TEXT    NOT NULL DEFAULT 'active',
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS extracted_values (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id   INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  field_name    TEXT    NOT NULL,
  field_value   TEXT,
  unit          TEXT,
  confidence    REAL,
  page_ref      TEXT,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS issues (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id   INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  severity      TEXT    NOT NULL DEFAULT 'info',
  category      TEXT,
  description   TEXT    NOT NULL,
  resolved      INTEGER NOT NULL DEFAULT 0,
  resolved_at   TEXT,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS cables (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tag_number    TEXT    NOT NULL UNIQUE,
  description   TEXT,
  cable_type    TEXT,
  from_location TEXT,
  to_location   TEXT,
  document_id   INTEGER REFERENCES documents(id) ON DELETE SET NULL,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS cable_cores (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  cable_id      INTEGER NOT NULL REFERENCES cables(id) ON DELETE CASCADE,
  core_number   TEXT    NOT NULL,
  signal_name   TEXT,
  from_terminal TEXT,
  to_terminal   TEXT,
  wire_color    TEXT,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS wiring_records (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id   INTEGER REFERENCES documents(id) ON DELETE SET NULL,
  cable_id      INTEGER REFERENCES cables(id) ON DELETE SET NULL,
  core_id       INTEGER REFERENCES cable_cores(id) ON DELETE SET NULL,
  signal_name   TEXT,
  from_terminal TEXT,
  to_terminal   TEXT,
  notes         TEXT,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS engineer_notes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id   INTEGER REFERENCES documents(id) ON DELETE CASCADE,
  author        TEXT,
  note          TEXT    NOT NULL,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS workspace_config (
  key         TEXT PRIMARY KEY,
  value       TEXT,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS standards (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL UNIQUE,
  description   TEXT,
  version       TEXT,
  document_id   INTEGER REFERENCES documents(id) ON DELETE SET NULL,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
`;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialise (or open) the sql.js database at dbPath.
 * Returns a SqlJsAdapter instance whose API matches better-sqlite3.
 *
 * @param {string} dbPath  Absolute path to the .db file.
 * @returns {Promise<SqlJsAdapter>}
 */
export async function initDB(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });

  const SQL = await initSqlJs();

  // Load existing file or start with an empty database
  const fileData = existsSync(dbPath) ? readFileSync(dbPath) : null;
  const sqlDb    = new SQL.Database(fileData ?? undefined);

  const db = new SqlJsAdapter(sqlDb, dbPath);

  // Apply DDL (CREATE IF NOT EXISTS — safe to re-run on existing databases)
  db.exec(DDL);

  return db;
}
