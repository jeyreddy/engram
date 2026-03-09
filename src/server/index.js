//
// src/server/index.js — Express web server entry point
//
// Replaces the Electron main process for network-accessible deployments.
// Run with:  node src/server/index.js
// or:        pm2 start ecosystem.config.cjs
//
// STARTUP ORDER:
//   1. Create / open workspace directory (WORKSPACE_PATH env var or default)
//   2. Init sql.js database  → initDB()
//   3. Init vectra indexes   → initVectorStore() + initStandardsStore()
//   4. Sync ANTHROPIC_API_KEY from env into workspace_config (if set)
//   5. Register all API routes via registerRoutes()
//   6. Serve built React app from dist/ (static files)
//   7. Listen on 0.0.0.0:PORT
//
// AUTH:
//   Set ENGRAM_TOKEN in the environment.  Every /api/* request must include
//   the header  x-engram-token: <token>  or query param  ?token=<token>.
//   Static files (index.html, /assets/) are always served without auth so
//   the browser can load the app before the user is authenticated.
//

import 'dotenv/config';

const apiKey = process.env.ANTHROPIC_API_KEY;
console.log('[engram] API key:', apiKey
  ? 'found (' + apiKey.slice(0, 10) + '...)'
  : 'NOT FOUND - check .env file');

import express             from 'express';
import cors                from 'cors';
import path                from 'path';
import { fileURLToPath }   from 'url';
import { existsSync, mkdirSync } from 'fs';

import { initDB }                        from '../db/schema.js';
import { initVectorStore, initStandardsStore } from '../ai/vectorstore.js';
import { registerRoutes }                from './routes.js';

const app      = express();
const PORT     = process.env.PORT || 3000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Middleware ─────────────────────────────────────────────────────────────

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ── Startup ────────────────────────────────────────────────────────────────

async function start() {
  // Determine workspace directory
  const workspacePath =
    process.env.WORKSPACE_PATH ||
    'C:\\Users\\Jagan Reddy\\AppData\\Roaming\\engram\\engram-workspace';

  if (!existsSync(workspacePath)) {
    mkdirSync(workspacePath, { recursive: true });
  }
  console.log('[engram] workspace:', workspacePath);

  // Database
  const dbPath = path.join(workspacePath, 'engram.db');
  const db     = await initDB(dbPath);
  console.log('[engram] database ready');

  // Vector indexes
  const indexPath = path.join(workspacePath, 'vectorindex');
  const store     = await initVectorStore(indexPath);
  const stdStore  = await initStandardsStore(indexPath);
  console.log('[engram] vector indexes ready');

  // Sync API key from environment into DB (overrides whatever is stored there)
  if (apiKey) {
    const { setConfig } = await import('../db/workspace.js');
    setConfig(db, 'claude_api_key', apiKey);
  }

  // Register all API routes
  registerRoutes(app, db, store, stdStore, workspacePath);

  // Serve the built React app (vite build → dist/)
  const distPath = path.join(__dirname, '../../dist');
  app.use(express.static(distPath));

  // SPA fallback — all non-API routes serve index.html
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  ENGRAM running on http://0.0.0.0:${PORT}\n`);
  });
}

start().catch(err => {
  console.error('[engram] startup failed:', err);
  process.exit(1);
});
