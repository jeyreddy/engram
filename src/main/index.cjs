'use strict';
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
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    title: 'ENGRAM',
  });
  mainWindow.loadURL('http://localhost:5173');
  mainWindow.webContents.openDevTools();
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(async () => {
  try {
    const { initDB }               = await import('../db/schema.js');
    const { getConfig, setConfig } = await import('../db/workspace.js');
    const { initVectorStore }      = await import('../ai/vectorstore.js');
    const { initRepo }             = await import('../git/engine.js');
    const { registerIPCHandlers }  = require('./ipc.cjs');
    const { startMCPServer }       = await import('../mcp/server.js');
    const { runRulesForAll }       = await import('../rules/engine.js');

    const workspacePath = path.join(app.getPath('userData'), 'engram-workspace');
    const dbPath        = path.join(workspacePath, 'engram.db');
    const indexPath     = path.join(workspacePath, 'vectorindex');

    // 1. Init DB
    const db = await initDB(dbPath);

    // 2. Persist API key from environment
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey) {
      setConfig(db, 'claude_api_key', apiKey);
      console.log('[ENGRAM] API key loaded from environment');
    }

    // Auto-configure workspace from environment on first launch
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

    // 3. Init vector store
    const store = await initVectorStore(indexPath);

    // 4. Init git repo
    await initRepo(workspacePath, db);

    // 5. Register IPC handlers (must be before window loads)
    registerIPCHandlers(db, store, workspacePath);

    // 6. Start MCP server
    startMCPServer(db, store);

    // 7. Open window (IPC handlers are ready)
    createWindow();

    // 8. Run rules in background
    setImmediate(() => {
      Promise.resolve().then(() => runRulesForAll(db)).catch(() => {})
    });
  } catch (err) {
    console.error('[ENGRAM] Bootstrap error:', err.message);
    console.error(err.stack);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
