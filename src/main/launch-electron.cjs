'use strict';
// Delete ELECTRON_RUN_AS_NODE before spawning — setting it to "" still
// triggers node mode in Electron; it must be fully absent from the environment.
delete process.env.ELECTRON_RUN_AS_NODE;

const { spawn } = require('child_process');
const electron  = require('electron');

const child = spawn(electron, ['.'], { stdio: 'inherit' });
child.on('exit', code => process.exit(code ?? 0));
