'use strict';
(async () => {
  const Module = require('module');

  // Check the resolve
  try {
    const resolved = Module._resolveFilename('electron');
    console.log('resolved electron:', resolved);
  } catch(e) { console.log('resolve error:', e.message); }

  // Check module load list (what's already loaded by Electron)
  const loadList = process.moduleLoadList || [];
  const electronMods = loadList.filter(m => m.includes('lectron'));
  console.log('electron modules in load list:', electronMods.slice(0, 20));

  // Try using the preloaded modules
  console.log('NativeModule:', typeof NativeModule);
})();
