//
// src/db/schema.js — Database initialisation and sql.js compatibility adapter
//
// WHY sql.js INSTEAD OF better-sqlite3:
//   better-sqlite3 is a native Node.js addon that must be compiled for the exact
//   Node.js ABI bundled in Electron.  Prebuilt binaries often don't exist for the
//   latest Electron versions, and electron-rebuild adds build-tool complexity.
//   sql.js is a pure WebAssembly port of SQLite that works in any JS environment
//   without compilation.  The downside is that the entire database lives in memory
//   and must be serialised to disk explicitly — handled by _save() / _afterWrite().
//
// ADAPTER PATTERN:
//   SqlJsAdapter wraps a sql.js Database and exposes the better-sqlite3 API
//   (db.prepare(sql).run/get/all, db.exec(sql), db.transaction(fn)) so every
//   downstream module (workspace.js, rules/engine.js, ipc.cjs) can be written
//   once against the stable better-sqlite3 interface.
//
// PERSISTENCE:
//   sql.js databases are in-memory; SqlJsAdapter calls _save() (db.export() →
//   writeFileSync) after every write that is not inside an explicit transaction.
//   Transactions batch multiple writes into a single _save() call at COMMIT.
//

import { createRequire } from 'module';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';

const require = createRequire(import.meta.url);
const initSqlJs = require('sql.js');

// ---------------------------------------------------------------------------
// SqlJsAdapter — better-sqlite3-compatible surface over sql.js
//
// Key design decisions:
//   • toBindParams() handles both positional (run(a, b)) and named ({$k: v})
//     parameter styles to match better-sqlite3's flexible bind API.
//   • _afterWrite() only persists when not inside a transaction (this._inTx)
//     so a transaction with 1000 INSERTs writes to disk once, not 1000 times.
//   • get() calls _afterWrite() for INSERT…RETURNING statements because sql.js
//     treats RETURNING as a read operation internally, but the row was written.
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
// Schema DDL
//
// DESIGN NOTES:
//   • All timestamps are ISO-8601 strings (strftime '%Y-%m-%dT%H:%M:%fZ').
//     sql.js has no native date type; string comparison works correctly for
//     ISO-8601 with fixed-width components.
//   • Foreign keys are ON (PRAGMA foreign_keys = ON) so CASCADE deletes work.
//   • WAL journal mode gives better concurrent read performance.
//   • Columns added after the initial schema are applied via ALTER TABLE in
//     ipc.cjs (wrapped in try/catch), NOT here.  Adding them here with
//     CREATE TABLE IF NOT EXISTS is safe on a fresh DB; the ALTERs handle
//     existing databases.
// ---------------------------------------------------------------------------

const DDL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- tags: instrument loop / equipment tag registry (e.g. FT-101, XV-202).
-- Each tag is the central entity; documents and issues hang off it.
-- tag_id is the human-readable identifier (same as name for legacy rows;
-- added as a separate column when the full registry feature was built).
-- Extra columns (tag_id, description, instrument_type, …) are added via
-- ALTER TABLE migrations in ipc.cjs at startup.
CREATE TABLE IF NOT EXISTS tags (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL UNIQUE,
  color       TEXT,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- documents: every indexed file (PDF, DOCX, XLSX, etc.).
-- file_path is the on-disk path and must be unique — it is the re-index key.
-- checksum (SHA-256) is used to skip files that haven't changed since last index.
-- tag_id links a document to an instrument tag (nullable — workspace-wide docs
-- have no tag).
-- Extra columns (chunk_count, project_name, display_name, description) are
-- added via ALTER TABLE in ipc.cjs.
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

-- extracted_values: individual field/value pairs parsed from documents.
-- Populated by two mechanisms:
--   1. extractKeyValues() — regex patterns for known doc types (datasheet, loop card…)
--   2. extractStructuredRows() — pipe-delimited "Field: Value | Field: Value" lines
--      found in Excel exports.
-- These rows are the primary source for the keyword SQL search in query:send and
-- for the "list all tags" direct-DB query path.
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

-- issues: integrity problems detected by the rules engine (rules/engine.js).
-- severity: 'error' | 'warning' | 'info'.
-- resolved = 0 means open; engineers classify via the ISSUES tab.
-- description stores JSON { title, detail } for structured display.
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

-- cables / cable_cores / wiring_records: wiring continuity data.
-- Populated from hook-up drawings and termination schedules.
-- Used by the WIRING tab and traceFromDCS / getJBCrossmap queries.
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
  notes         TEXT,   -- JSON blob, may contain { tag_id } for filtering
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- engineer_notes: free-text notes attached to a document, written by engineers
-- when classifying issues or reviewing documents.
CREATE TABLE IF NOT EXISTS engineer_notes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id   INTEGER REFERENCES documents(id) ON DELETE CASCADE,
  author        TEXT,
  note          TEXT    NOT NULL,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- workspace_config: generic key-value store for all app configuration.
-- Keys include: claude_api_key, engineer_name, engineer_email, plant_name,
-- area, source_paths (JSON array), projects (JSON array), current_project,
-- workspace_initialised, index_status, staged_changes (JSON array), ocr_queue.
CREATE TABLE IF NOT EXISTS workspace_config (
  key         TEXT PRIMARY KEY,
  value       TEXT,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- standards: legacy table, kept for schema compatibility.
-- NOT used for the active standards feature — see standards_documents below.
CREATE TABLE IF NOT EXISTS standards (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL UNIQUE,
  description   TEXT,
  version       TEXT,
  document_id   INTEGER REFERENCES documents(id) ON DELETE SET NULL,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- standards_registry: user-maintained notepad of applicable standard numbers.
-- These are NOT uploaded files — just a list of standard IDs (e.g. ISA-5.1,
-- IEC 61511) that the engineer wants Claude to apply to every review.
-- At query time, active rows are serialised into the Claude system prompt so
-- Claude can flag non-conformances using its built-in training knowledge.
-- The UI for this is the RegistryNotepad component in the STANDARDS tab.
CREATE TABLE IF NOT EXISTS standards_registry (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  standard_number TEXT    NOT NULL,
  standard_name   TEXT,
  category        TEXT    DEFAULT 'General',
  notes           TEXT,
  active          INTEGER DEFAULT 1,
  created_at      TEXT    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
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
