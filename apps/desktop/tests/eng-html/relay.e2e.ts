import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { startCanary, type Canary } from './canary';

// html-5 in a real Chromium: the app's own relay (main/mail-protocol.ts) in a hidden Electron, wired to a stand-in
// engine (support/relay-app.ts). Run: npx tsx --test apps/desktop/tests/eng-html/relay.e2e.ts (about 5 s; not part of
// `npm test`, which runs no Electron). Hidden windows only, no Dock item, a temp user-data dir, ELECTRON_RUN_AS_NODE
// removed, loopback canary only.

const nodeRequire = createRequire(import.meta.url);
const electronBinary = nodeRequire('electron') as unknown as string;

interface ServeLog {
  window: string;
  connection: string;
  token: string;
  path: string;
  status: number;
}
interface Result {
  ids: Record<'a' | 'b' | 'forger', { window: number; contents: number }> & { spare: number };
  urls: Record<'a1' | 'a2' | 'a3' | 'b1' | 'backstop' | 'forger', string>;
  log: ServeLog[];
  gotA: { origin: string; data: Record<string, unknown>; frame: number }[];
  gotB: { origin: string; data: Record<string, unknown>; frame: number }[];
  popups: { contents: number; url: string }[];
  forged: Record<string, unknown>;
  control: string;
  frameUrls: { url: string; origin: string }[];
  processes: { mail: number; host: number };
  keys: { type: string; key: string; focused: string | null }[];
}

function safeEnv(canary: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key !== 'ELECTRON_RUN_AS_NODE' && !/_API_KEY$/.test(key)) env[key] = value;
  }
  return { ...env, APLOS_RELAY_CANARY: canary, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' };
}

async function runApp(canary: Canary): Promise<Result> {
  const dir = await mkdtemp(join(tmpdir(), 'aplos-relay-'));
  try {
    const main = join(dir, 'main.cjs');
    await build({
      entryPoints: [join(import.meta.dirname, 'support', 'relay-app.ts')],
      outfile: main,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      external: ['electron'],
      logLevel: 'silent',
    });
    const args = [main, `--user-data-dir=${join(dir, 'user-data')}`, '--no-proxy-server'];
    const child = spawn(electronBinary, args, {
      env: safeEnv(canary.origin),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', chunk => (out += chunk));
    child.stderr.on('data', chunk => (err += chunk));
    const timer = setTimeout(() => child.kill('SIGKILL'), 40_000);
    await new Promise(resolve => child.once('exit', resolve));
    clearTimeout(timer);
    const line = out.split('\n').find(l => l.startsWith('RELAY-RESULT '));
    if (!line) throw new Error(`no result\n${out}\n${err.slice(-2000)}`);
    return JSON.parse(line.slice('RELAY-RESULT '.length)) as Result;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const tokenOf = (url: string) => url.slice('aplos-mail://m/'.length, -1);

test(
  'the relay in a hidden Electron: windows, stamp, GET-only, CSP, backstop',
  { timeout: 60_000 },
  async t => {
    const canary = await startCanary();
    t.after(() => canary.close());
    const r = await runApp(canary);
    const served = (token: string, path: string) =>
      r.log.filter(entry => entry.token === tokenOf(token) && entry.path === path);
    const A = String(r.ids.a.window);
    const B = String(r.ids.b.window);
    const F = String(r.ids.forger.window);

    await t.test(
      'the stamp is the embedding window: webContentsId translated to its window id',
      () => {
        assert.notEqual(
          r.ids.a.contents,
          r.ids.a.window,
          'ids differ, so the translation is exercised',
        );
        assert.deepEqual(served(r.urls.a1, ''), [
          { window: A, connection: `conn-${A}`, token: tokenOf(r.urls.a1), path: '', status: 200 },
        ]);
        const cid = served(r.urls.a1, 'cid/0').filter(e => e.window === A);
        assert.equal(cid.length, 1, 'the frame’s own cid sub-resource was requested once');
        assert.equal(cid[0].status, 200);
        assert.equal(
          r.log.filter(e => e.path.startsWith('img/')).length,
          0,
          'blocked images are never requested',
        );
      },
    );

    await t.test('window B cannot obtain window A’s token document or sub-resources', () => {
      assert.deepEqual(
        served(r.urls.a3, '').map(e => [e.window, e.status]),
        [
          [B, 404],
          [A, 200],
        ],
        'B’s attempt is the 404 and spends nothing; A then gets its document',
      );
      assert.deepEqual(
        served(r.urls.a1, 'cid/0')
          .filter(e => e.window !== A)
          .map(e => [e.window, e.status]),
        [
          [B, 404],
          [F, 404],
        ],
      );
      assert.equal(served(r.urls.b1, '')[0].status, 200);
    });

    await t.test('a page-forged X-Aplos-Window is overwritten by the stamp', () => {
      assert.equal(r.forged.forgedGet, 404);
      const forgedEntry = served(r.urls.a1, 'cid/0').find(e => e.window === F);
      assert.ok(forgedEntry, 'the forged request reached the engine as the forger’s own window');
      assert.equal(forgedEntry.connection, `conn-${F}`);
    });

    await t.test('POST and HEAD are 405 and never reach the engine', () => {
      assert.equal(r.forged.post, 405);
      assert.equal(r.forged.allow, 'GET');
      assert.equal(r.forged.head, 405);
      const forgerFetches = r.log.filter(e => e.window === F);
      assert.deepEqual(
        forgerFetches.map(e => e.path),
        ['', 'cid/0'],
        'the forger page itself and its one GET: nothing for POST or HEAD',
      );
    });

    await t.test(
      'the engine’s CSP reaches the document: the reporter runs, an inline script and handler do not',
      () => {
        const frameOf = (url: string) => r.frameUrls.findIndex(f => f.url === url);
        const fromCspProbe = r.gotA.filter(m => m.frame === frameOf(r.urls.a2));
        assert.ok(
          fromCspProbe.some(
            m => m.data.token === tokenOf(r.urls.a2) && typeof m.data.h === 'number',
          ),
          'the hash-pinned reporter posted its size',
        );
        assert.ok(
          fromCspProbe.every(m => m.origin === 'null'),
          'the frame is opaque: no allow-same-origin',
        );
        assert.equal(
          r.gotA.filter(m => 'pwned' in m.data).length,
          0,
          'no inline script or handler ran',
        );
        assert.ok(r.frameUrls.every(f => f.origin === 'null' || f.url.startsWith('file:')));
      },
    );

    await t.test('the mail frames run out of the host renderer’s process', () => {
      assert.notEqual(r.processes.mail, r.processes.host);
    });

    await t.test(
      'no http, https or ws request leaves a mail frame: images blocked, backstop holds',
      () => {
        const fromFrames = canary.hits.filter(
          h => h.url.startsWith('/relay/') && h.url !== '/relay/control.png',
        );
        assert.deepEqual(
          fromFrames.map(h => h.url),
          [],
          'remote image, backstop probe and forger page all stopped',
        );
        assert.ok(
          r.gotA.some(m => m.data.backstop === 'ran'),
          'the backstop probe’s script did run',
        );
        // Positive control: the app page itself (file://) still reaches the canary. The canary answers text, so the image
        // fails to decode; what counts is that the request arrived.
        assert.ok(['load', 'error'].includes(r.control));
        assert.ok(
          canary.hits.some(h => h.url === '/relay/control.png'),
          'the app page’s own request is not cancelled',
        );
      },
    );

    await t.test('links from inside the frame reach the embedding window’s open handler', () => {
      assert.deepEqual(
        r.popups.map(p => [p.contents, p.url]),
        [
          [r.ids.a.contents, 'https://example.invalid/x'],
          [r.ids.a.contents, 'mailto:ada@example.invalid'],
        ],
      );
    });

    await t.test(
      'keys (recorded, not wired): before-input-event fires with focus inside the mail frame',
      () => {
        // sendInputEvent goes through the browser's input path and is seen, with focusedFrame naming the mail frame;
        // DevTools' Input.dispatchKeyEvent is not seen. A real key in the packaged app is the hand-check (DECISIONS).
        assert.deepEqual(r.keys, [
          { type: 'keyDown', key: 'j', focused: r.urls.a1 },
          { type: 'keyUp', key: 'j', focused: r.urls.a1 },
        ]);
      },
    );
  },
);
