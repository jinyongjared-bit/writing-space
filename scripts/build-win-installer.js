'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const cli = path.join(projectRoot, 'node_modules', 'electron-builder', 'cli.js');
const result = spawnSync(process.execPath, [cli,
  '--win',
  'nsis',
  '--x64',
  '--config.electronDist=node_modules/electron/dist',
  '--publish',
  'never'
], {
  cwd: projectRoot,
  env: {
    ...process.env,
    ELECTRON_BUILDER_CACHE: path.join(projectRoot, '.electron-builder-cache')
  },
  stdio: 'inherit',
  shell: false
});

if (result.error) throw result.error;
process.exitCode = result.status || 0;
