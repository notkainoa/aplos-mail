// verify-hardening-real-engine.mjs — the go-live smoke: launches a packaged Aplos Mail .app with
// APLOS_TEST=1 + APLOS_ENGINE=real on an isolated data dir, headless, drives the first window over
// CDP and FAILS when the first window is the legacy fatal screen or the console shows an
// 'aplos:invoke' refusal. Exists because 2026-11-05's premature hand-check passed a build whose
// first window fataled on 'This screen is not on the new engine yet.' Run it after every packaging
// build meant for a real-engine launch.
//
// Usage: node scripts/verify-hardening-real-engine.mjs <path-to-.app> [--out file.png] [--json]
// Exits 0 on PASS, 1 on any FAIL row, 2 on usage/environment.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const appArg = process.argv.find(a => a.endsWith('.app'));
const out = flag('--out');
const json = process.argv.includes('--json');
if (!appArg) {
  console.error(
    'usage: node verify-hardening-real-engine.mjs <path-to-.app> [--out file.png] [--json]',
  );
  process.exit(2);
}
const exe = resolve(appArg, 'Contents/MacOS/Aplos Mail');
if (!existsSync(exe)) {
  console.error(`verify-real-engine: no executable at ${exe}`);
  process.exit(2);
}
function flag(name) {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

const dataDir = mkdtempSync(join(tmpdir(), 'aplos-real-engine-'));
const rows = [];
const row = (id, status, reason) => {
  rows.push({ id, status, reason });
  if (!json) console.log(`${status}  ${id.padEnd(24)} ${reason}`);
};
const pass = (id, reason) => row(id, 'PASS', reason);
const fail = (id, reason) => row(id, 'FAIL', reason);

const cleanup = () => {
  if (dataDir && dataDir !== '/' && dataDir.includes('aplos-real-engine-'))
    rmSync(dataDir, { recursive: true, force: true });
};

const output = [];
let resolveReady;
const engineReady = new Promise(r => (resolveReady = r));
const child = spawn(exe, ['--remote-debugging-port=0'], {
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: undefined,
    APLOS_TEST: '1',
    APLOS_DATA_DIR: dataDir,
    APLOS_ENGINE: 'real',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let port;
for (const stream of [child.stdout, child.stderr])
  stream.on('data', chunk => {
    const text = chunk.toString();
    output.push(text);
    const m = text.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/);
    if (m) port = Number(m[1]);
    if (text.includes('engine: real engine ready')) resolveReady();
  });

const deadline = Date.now() + 90_000;
const delay = ms => new Promise(r => setTimeout(r, ms));
async function targets() {
  return (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
}

try {
  // Engine must come up inside 45 s or the whole check is moot.
  await Promise.race([
    engineReady,
    delay(45_000).then(() => {
      throw new Error('engine did not report ready within 45 s');
    }),
  ]);
  pass('engine-ready', 'real engine utility process is up');

  let page;
  while (!page && Date.now() < deadline) {
    if (port)
      try {
        page = (await targets()).find(t => t.type === 'page' && t.url.startsWith('file:'));
      } catch {
        /* devtools http not up yet */
      }
    if (!page) await delay(300);
  }
  if (!page) throw new Error('no file: renderer page inside 90 s');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  });
  const send = (method, params = {}) =>
    new Promise(r => {
      const i = ++id;
      pending.set(i, r);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const evaluate = expression =>
    send('Runtime.evaluate', { expression, returnByValue: true }).then(
      m => m.result?.result?.value,
    );

  // Read the first window's text until it settles: a transient "can't reach its mail engine" is
  // fine while the bridge connects, but a fatal screen, or an engine-down state that outlasts
  // the window, is a FAIL either way.
  let body = '';
  let settled = '';
  for (let i = 0; i < 30 && Date.now() < deadline; i++) {
    body = String(await evaluate('document.body?.innerText ?? ""'));
    if (/Aplos needs a moment|Error invoking remote method/i.test(body)) break;
    if (body.trim() && !/can’t reach its mail engine|can't reach its mail engine/i.test(body)) {
      settled = body;
      break;
    }
    await delay(2000);
  }
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  if (out && shot.result?.data) writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
  ws.close();

  if (/(Aplos needs a moment|Error invoking remote method)/i.test(String(body)))
    fail('first-window', `the first window shows the fatal screen: ${String(body).slice(0, 120)}`);
  else if (!settled)
    fail(
      'first-window',
      `the first window never left the engine-down state: ${String(body).slice(0, 120)}`,
    );
  else pass('first-window', `first window rendered content: ${settled.slice(0, 80)}`);

  const console_ = output.join('');
  const refused = console_.match(/[^\n]*aplos:invoke[^\n]*/);
  if (refused) fail('invoke-refusals', refused[0].trim().slice(0, 200));
  else pass('invoke-refusals', 'no aplos:invoke refusal on the console');
} catch (error) {
  fail('run', error?.message ?? String(error));
} finally {
  if (child.exitCode === null) {
    child.kill('SIGTERM');
    const t = Date.now();
    while (child.exitCode === null && Date.now() - t < 15_000) await delay(200);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  cleanup();
}

const failed = rows.filter(r => r.status === 'FAIL');
if (json) console.log(JSON.stringify({ rows }));
if (failed.length) {
  if (!json) console.log(`verify-real-engine: ${failed.length} FAIL`);
  process.exit(1);
}
if (!json) console.log('verify-real-engine: all pass');
