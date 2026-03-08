'use strict';
//
// src/main/index.cjs — Electron main-process entry point
//
// WHY .cjs:
//   package.json has "type": "module" (ESM root), so Node.js would treat a
//   plain .js file as ESM.  Electron's main-process entry must be CJS because
//   it calls require('electron') at the top level.  The .cjs extension forces
//   CJS loading regardless of the root "type" setting.
//
// STARTUP ORDER (important — do not reorder):
//   1. initDB        — creates/migrates the sqlite database
//   1a. loadWorkspaceConfig — syncs workspace.config.json into the DB
//   2. API key sync  — writes ANTHROPIC_API_KEY env var to DB so it survives
//                      DB deletion/recreation between dev sessions
//   3. initVectorStore / initStandardsStore — creates vectra indexes on disk
//   4. initRepo      — initialises the isomorphic-git repo for change tracking
//   5. registerIPCHandlers — MUST happen before createWindow() so the renderer
//                      never calls an IPC channel that isn't registered yet
//   6. startMCPServer — starts the MCP (Model Context Protocol) server
//   7. createWindow  — loads the Vite dev server (localhost:5173 in dev)
//   8. runRulesForAll — fires in the background via setImmediate so it doesn't
//                      block window paint
//
// PATHS:
//   workspacePath = %APPDATA%\engram\engram-workspace  (Electron userData)
//   dbPath        = workspacePath/engram.db
//   indexPath     = workspacePath/vectorindex          (main vectra index)
//   stdStore path = workspacePath/vectorindex_standards (auto-derived in vectorstore.js)
//

const path = require('path');
const { app, BrowserWindow } = require('electron');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    backgroundColor: '#020810',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,   // renderer cannot access Node.js directly
      nodeIntegration: false,   // enforced by contextIsolation
      sandbox: false,           // needed so preload can use require('electron')
    },
    title: 'ENGRAM',
  });
  // In dev, Vite serves the renderer at localhost:5173.
  // In production this would be a file:// URL to the built dist/index.html.
  mainWindow.loadURL('http://localhost:5173');
  mainWindow.webContents.openDevTools();
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(async () => {
  try {
    // All backend modules are ESM; dynamic import() is required from CJS.
    // ipc.cjs is CJS so it can be require()'d directly.
    const { initDB }               = await import('../db/schema.js');
    const { getConfig, setConfig } = await import('../db/workspace.js');
    const { initVectorStore, initStandardsStore } = await import('../ai/vectorstore.js');
    const { initRepo }             = await import('../git/engine.js');
    const { registerIPCHandlers }  = require('./ipc.cjs');
    const { startMCPServer }       = await import('../mcp/server.js');
    const { runRulesForAll }       = await import('../rules/engine.js');

    const workspacePath = path.join(app.getPath('userData'), 'engram-workspace');
    const dbPath        = path.join(workspacePath, 'engram.db');
    const indexPath     = path.join(workspacePath, 'vectorindex');

    // 1. Init DB — applies the full DDL (CREATE TABLE IF NOT EXISTS + migrations)
    const db = await initDB(dbPath);

    // 1a. Sync workspace.config.json → database.
    // workspace.config.json at C:\engram\ lets engineers edit config in a text
    // editor without opening the app.  On every startup we read it and write any
    // values it contains into workspace_config (DB wins on conflict for keys not
    // in the JSON; JSON wins for keys it explicitly sets).
    try {
      const { loadWorkspaceConfig } = await import('./workspace-config.js');
      await loadWorkspaceConfig(db);
    } catch (e) {
      console.warn('[ENGRAM] workspace-config sync skipped:', e.message);
    }

    // 2. Always write the API key from env into the DB.
    // This ensures the key survives even if the database file is deleted and
    // recreated (common during development).  Only sk-* keys are accepted to
    // avoid writing placeholder values.
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey && apiKey.startsWith('sk-')) {
      setConfig(db, 'claude_api_key', apiKey);
      console.log('[ENGRAM] API key synced from .env');
    }

    // Auto-configure workspace from environment variables on first launch.
    // Useful for CI / Docker deployments where no setup wizard is shown.
    if (!getConfig(db, 'workspace_initialised') && process.env.ENGRAM_ENGINEER_NAME) {
      const envMap = {
        engineer_name:  process.env.ENGRAM_ENGINEER_NAME,
        engineer_email: process.env.ENGRAM_ENGINEER_EMAIL,
        plant_name:     process.env.ENGRAM_PLANT_NAME,
        area:           process.env.ENGRAM_AREA,
        api_key:        process.env.ENGRAM_API_KEY,
      };
      for (const [key, val] of Object.entries(envMap)) {
        if (val) setConfig(db, key, val);
      }
      setConfig(db, 'workspace_initialised', '1');
      console.log('[ENGRAM] Workspace auto-configured from environment');
    }

    // 3. Init vector stores.
    // store    → main document index at indexPath/
    // stdStore → standards/policy index at indexPath_standards/
    // Both are vectra LocalIndex instances; the path suffix is set in vectorstore.js.
    const store    = await initVectorStore(indexPath);
    const stdStore = await initStandardsStore(indexPath);

    // 4. Init git repo for change tracking / document history
    await initRepo(workspacePath, db);

    // 5. Register IPC handlers — MUST precede createWindow() so the renderer
    // never fires an ipcRenderer.invoke() against an unregistered channel.
    registerIPCHandlers(db, store, workspacePath, stdStore);

    // 6. Start the MCP server (Model Context Protocol) for external tool access
    startMCPServer(db, store, stdStore);

    // 7. Open the browser window — renderer will connect to Vite dev server
    createWindow();

    // 8. Run rules engine in background after window opens.
    // setImmediate defers to the next event loop iteration so the window paints
    // first.  Errors are swallowed — rule failures should not crash the app.
    setImmediate(() => {
      Promise.resolve().then(() => runRulesForAll(db)).catch(() => {})
    });
  } catch (err) {
    console.error('[ENGRAM] Bootstrap error:', err.message);
    console.error(err.stack);
  }
});

app.on('window-all-closed', () => {
  // macOS convention: apps stay open until Cmd+Q even with no windows.
  if (process.platform !== 'darwin') app.quit();
});
