import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const scripts = resolve(import.meta.dirname, '..');
const made = [];

/** Writes { 'relative/path': 'content' } into a fresh temp directory and returns it. */
export function makeDir(files) {
  const dir = mkdtempSync(join(tmpdir(), 'aplos-web-check-'));
  made.push(dir);
  for (const [name, content] of Object.entries(files)) {
    const file = join(dir, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return dir;
}

/** Removes every directory makeDir created. Register it with after(cleanup) in each test file. */
export function cleanup() {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
}

const envFor = env => ({ ...process.env, VERCEL_ENV: '', ...env });

export function run(script, args = [], env = {}) {
  const r = spawnSync(process.execPath, [join(scripts, script), ...args], {
    encoding: 'utf8',
    env: envFor(env),
    timeout: 180000,
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

export function runAsync(script, args = [], env = {}) {
  return new Promise(done => {
    const child = spawn(process.execPath, [join(scripts, script), ...args], { env: envFor(env) });
    let out = '';
    child.stdout.on('data', d => (out += d));
    child.stderr.on('data', d => (out += d));
    child.on('close', code => done({ code, out }));
  });
}
