import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const scripts = resolve(import.meta.dirname, '..');

/** Writes { 'relative/path': 'content' } into a fresh temp directory and returns it. */
export function makeDir(files) {
  const dir = mkdtempSync(join(tmpdir(), 'aplos-web-check-'));
  for (const [name, content] of Object.entries(files)) {
    const file = join(dir, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return dir;
}

export function run(script, args = [], env = {}) {
  const r = spawnSync(process.execPath, [join(scripts, script), ...args], {
    encoding: 'utf8',
    env: { ...process.env, VERCEL_ENV: '', ...env },
    timeout: 120000,
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
