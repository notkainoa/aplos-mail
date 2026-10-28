import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from 'dotenv';
// Paths follow this file, so it works from the repo root (`node scripts/launch.mjs`) and from apps/desktop.
const desktop = resolve(import.meta.dirname, '..');
for (const dir of [desktop, resolve(desktop, '..', '..')])
  config({ path: resolve(dir, '.env'), quiet: true });
const executable = resolve(desktop, 'release/mac-arm64/Aplos Mail.app/Contents/MacOS/Aplos Mail');
if (!existsSync(executable)) {
  console.error('Run npm run package first.');
  process.exit(1);
}
// Terminal hosts may use Electron as Node themselves. Do not pass that mode to the desktop app.
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(executable, process.argv.slice(2), { env, stdio: 'inherit' });
child.on('error', e => {
  console.error(e.message);
  process.exitCode = 1;
});
child.on('exit', code => {
  process.exitCode = code ?? 0;
});
