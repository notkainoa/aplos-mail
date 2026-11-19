// Run a command under Electron's own Node: `node scripts/audit/electron-node.mjs <args...>`
// spawns the Electron binary with ELECTRON_RUN_AS_NODE=1 (headless, no window) and
// propagates the exit code. See plans/40-platform-quality.md ADR 40-4: node:sqlite uses
// the SQLite of the runtime that loads it, so database suites must run under Electron's
// own Node, not system Node. `require("electron")` prints the binary path on macOS and
// Linux alike, so no shell or app-specific path is baked in.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electron = require('electron');

if (typeof electron !== 'string') {
  console.error('electron-node.mjs: require("electron") did not return a binary path');
  process.exit(1);
}

const child = spawn(electron, process.argv.slice(2), {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
});
child.on('error', error => {
  console.error(`electron-node.mjs: failed to start ${electron}: ${error.message}`);
  process.exit(1);
});
child.on('close', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
