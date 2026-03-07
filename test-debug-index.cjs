'use strict';
const path = require('path');
(async () => {
  try {
    const e = await import('electron');
    console.log('ESM import electron keys:', Object.keys(e));
    console.log('ESM import electron.default keys:', Object.keys(e.default || {}));
    console.log('ESM import electron.app:', typeof e.app);
    console.log('ESM import electron.default.app:', typeof (e.default || {}).app);

    const em = await import('electron/main');
    console.log('ESM import electron/main keys:', Object.keys(em));
    const d = em.default || {};
    console.log('electron/main.default.app:', typeof d.app);
    console.log('electron/main.default keys:', Object.keys(d).slice(0, 15));
  } catch(e) { console.error('Error:', e.message); }
})();
