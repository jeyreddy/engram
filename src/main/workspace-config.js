import { readFileSync, writeFileSync, existsSync } from 'fs';

const CONFIG_PATH = 'C:\\engram\\workspace.config.json';

const DEFAULTS = {
  engineer_name:       'Jagan Reddy',
  engineer_email:      'jagan@aircompany.com',
  plant_name:          'Air Company Plant',
  area:                'Unit 100',
  source_paths:        [],
  projects:            ['Default'],
  current_project:     'Default',
  discipline:          'instrumentation',
  notes:               'Edit this file in Notepad to configure ENGRAM. Save and restart the app for changes to take effect. Do NOT add your Downloads or Desktop folder to source_paths.',
  source_paths_guide:  'Add full folder paths here. Example: C:\\\\Projects\\\\Plant1\\\\Documents. ENGRAM will index ALL files in these folders on Re-index.',
};

// Keys to exclude when syncing file → db (arrays are JSON-serialised)
const SKIP_SYNC_TO_DB = new Set(['notes', 'source_paths_guide']);

// Keys to exclude when saving db → file
const SKIP_SAVE_TO_FILE = new Set(['claude_api_key', 'workspace_initialised', 'index_status', 'staged_changes']);

/**
 * Read workspace.config.json, create with defaults if missing,
 * and sync all values into workspace_config table.
 */
export async function loadWorkspaceConfig(db) {
  let config;

  if (existsSync(CONFIG_PATH)) {
    try {
      config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    } catch (e) {
      console.warn('[workspace-config] Failed to parse config file, using defaults:', e.message);
      config = { ...DEFAULTS };
    }
  } else {
    config = { ...DEFAULTS };
    try {
      writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
      console.log('[workspace-config] Created default config at', CONFIG_PATH);
    } catch (e) {
      console.warn('[workspace-config] Could not write default config:', e.message);
    }
  }

  // Sync file values → database
  for (const [key, value] of Object.entries(config)) {
    if (SKIP_SYNC_TO_DB.has(key)) continue;
    try {
      const strValue = Array.isArray(value) || typeof value === 'object'
        ? JSON.stringify(value)
        : String(value ?? '');
      db.prepare(
        "INSERT INTO workspace_config(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
      ).run(key, strValue);
    } catch (e) {
      console.warn(`[workspace-config] Could not sync key "${key}":`, e.message);
    }
  }

  console.log('[workspace-config] Synced config to database');
  return config;
}

/**
 * Read all workspace_config rows from the database and write to
 * workspace.config.json, excluding sensitive / runtime-only keys.
 */
export async function saveWorkspaceConfig(db) {
  try {
    const rows = db.prepare('SELECT key, value FROM workspace_config ORDER BY key').all();
    const config = {};

    for (const { key, value } of rows) {
      if (SKIP_SAVE_TO_FILE.has(key)) continue;
      // Try to parse JSON values (arrays, objects); fall back to raw string
      try {
        config[key] = JSON.parse(value);
      } catch {
        config[key] = value;
      }
    }

    // Always include metadata fields from DEFAULTS so the file stays readable
    config.notes              = DEFAULTS.notes;
    config.source_paths_guide = DEFAULTS.source_paths_guide;

    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
    console.log('[workspace-config] Saved config to', CONFIG_PATH);
    return true;
  } catch (e) {
    console.error('[workspace-config] Save failed:', e.message);
    return false;
  }
}
