'use strict';
(async () => {
  const e = await import('electron');
  console.log('module.exports type (require):', typeof require('electron'));
  console.log('import default type:', typeof e.default);
  console.log('default value:', e.default);
  // Try electron/main
  try {
    const em = await import('electron/main');
    console.log('electron/main keys:', Object.keys(em).slice(0, 15));
  } catch(err) {
    console.log('electron/main error:', err.message);
  }
})();
