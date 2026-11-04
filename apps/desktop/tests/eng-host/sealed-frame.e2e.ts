import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';

// html-5's main side for the sealed mail frame in a real Chromium (lane eng-host): the key relay through the REAL
// preload, links clicked in a letter, and the process-isolation check. Run:
// npx tsx --test apps/desktop/tests/eng-host/sealed-frame.e2e.ts (a few seconds; not part of `npm test`, which starts
// no Electron). A hidden window only, no Dock item, a temp user-data dir, ELECTRON_RUN_AS_NODE removed, AI keys
// blanked, nothing shown and no network: the letter is served from memory and no link ever reaches the browser or the
// OS (the sinks record). Keys go in through `webContents.sendInputEvent`, the browser-side path a real key takes; a real
// key press in the packaged app stays an owner hand-check (DECISIONS).

const nodeRequire = createRequire(import.meta.url);
const electronBinary = nodeRequire('electron') as unknown as string;

interface LinkResult {
  mails: string[];
  webs: string[];
  frameUrl: string;
  hostUrl: string;
}
interface KeyStep {
  step: string;
  focused: string;
  mailKeys: unknown[];
  hostKeys: string[];
}
interface Result {
  url: string;
  hostUrl: string;
  isolation: {
    frameProcess: { id: number; os: number };
    hostProcess: { id: number; os: number };
    mainPid: number;
    metrics: { pid: number; type: string }[];
    inFrame: Record<string, string>;
    inHost: Record<string, string>;
  };
  links: {
    clicked: Record<string, LinkResult>;
    navigations: { url: string; main: boolean; frame: string | null; initiator: string | null }[];
    messages: string[];
  };
  keys: KeyStep[];
  fragment: {
    frameUrl: string;
    focused: string;
    mailKeys: unknown[];
    mails: string[];
    webs: string[];
  };
}

function safeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    // APLOS_RENDERER_URL would make security.ts trust a dev server instead of the test's host page.
    const dropped = key === 'ELECTRON_RUN_AS_NODE' || key === 'APLOS_RENDERER_URL';
    if (!dropped && !/_API_KEY$/.test(key)) env[key] = value;
  }
  return { ...env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' };
}

async function bundle(entry: string, outfile: string): Promise<void> {
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
    define: { __APLOS_RELEASE_BUILD__: 'false' },
    logLevel: 'silent',
  });
}

async function runApp(): Promise<Result> {
  const dir = await mkdtemp(join(tmpdir(), 'aplos-sealed-'));
  try {
    const main = join(dir, 'main', 'main.cjs');
    await bundle(join(import.meta.dirname, 'support', 'sealed-frame-app.ts'), main);
    await bundle(
      join(import.meta.dirname, '..', '..', 'src', 'main', 'preload.ts'),
      join(dir, 'main', 'preload.cjs'),
    );
    const args = [main, `--user-data-dir=${join(dir, 'user-data')}`, '--no-proxy-server'];
    const child = spawn(electronBinary, args, {
      env: safeEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', chunk => (out += chunk));
    child.stderr.on('data', chunk => (err += chunk));
    const timer = setTimeout(() => child.kill('SIGKILL'), 40_000);
    await new Promise(resolve => child.once('exit', resolve));
    clearTimeout(timer);
    const line = out.split('\n').find(l => l.startsWith('SEALED-RESULT '));
    if (!line) throw new Error(`no result\n${out}\n${err.slice(-2000)}`);
    return JSON.parse(line.slice('SEALED-RESULT '.length)) as Result;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test(
  'the sealed frame in a hidden Electron: process isolation, keys, links',
  { timeout: 60_000 },
  async t => {
    const r = await runApp();
    if (process.env.SEALED_DEBUG) console.log(JSON.stringify(r, null, 1));

    await t.test(
      'the frame runs in its own OS process, with no bridge and no way into the page',
      () => {
        const { frameProcess, hostProcess, mainPid, metrics, inFrame, inHost } = r.isolation;
        assert.notEqual(frameProcess.id, hostProcess.id, 'Electron process ids differ');
        assert.ok(frameProcess.os > 0 && hostProcess.os > 0);
        assert.notEqual(frameProcess.os, hostProcess.os, 'OS pids differ');
        assert.notEqual(frameProcess.os, mainPid);
        const renderers = metrics.filter(m => m.type === 'Tab').map(m => m.pid);
        assert.ok(
          renderers.includes(frameProcess.os),
          'the frame’s pid is a live renderer process',
        );
        assert.ok(renderers.includes(hostProcess.os), 'the page’s pid is a live renderer process');
        // Positive control: the page has the real preload and its bridges.
        assert.equal(inHost.aplos, 'object');
        assert.equal(inHost.aplosEngine, 'object');
        // The frame has none of it.
        for (const name of ['aplos', 'aplosEngine', 'require', 'process', 'Buffer', 'electron'])
          assert.equal(inFrame[name], 'undefined', name);
        assert.equal(inFrame.origin, 'null', 'an opaque origin');
        assert.equal(inFrame.parentDocument, 'SecurityError');
        assert.equal(inFrame.parentAplos, 'SecurityError');
        assert.equal(inFrame.topLocation, 'SecurityError');
        assert.equal(inFrame.storage, 'SecurityError');
        // And the page cannot reach the frame’s DOM either.
        assert.equal(inHost.contentDocument, 'null');
        assert.equal(inHost.contentWindowDocument, 'SecurityError');
        assert.equal(inHost.frameDom, 'SecurityError');
      },
    );

    const step = (name: string) => r.keys.find(k => k.step === name)!;

    await t.test(
      'a listed, unmodified key in the sealed frame reaches the page once, as one narrow message',
      () => {
        const expected: Record<string, string> = {
          j: 'j',
          k: 'k',
          'shift J': 'J',
          'shift K': 'K',
          ArrowUp: 'ArrowUp',
          ArrowDown: 'ArrowDown',
          PageUp: 'PageUp',
          PageDown: 'PageDown',
          Home: 'Home',
          End: 'End',
          Escape: 'Escape',
        };
        for (const [name, key] of Object.entries(expected)) {
          assert.deepEqual(step(name).mailKeys, [{ key }], name);
          assert.equal(
            step(name).focused,
            r.url,
            `${name}: the focused frame is the sealed letter`,
          );
          // Not asserted: whether the page’s own keydown listener also sees the key. In this hidden, never-activated window
          // it does (sendInputEvent reaches the page although focusedFrame names the letter), which a real key in an
          // active window should not; DECISIONS records it and the packaged-app hand-check covers it.
        }
      },
    );

    await t.test('nothing destructive, no modifier combination, no unlisted key is relayed', () => {
      for (const name of [
        'e',
        'r',
        'Space',
        'Enter',
        'Delete',
        'Backspace',
        'ctrl j',
        'meta k',
        'alt ArrowUp',
        'shift ArrowDown',
      ])
        assert.deepEqual(step(name).mailKeys, [], name);
    });

    await t.test(
      'a forged message on the channel is dropped by preload; the one good message arrives once',
      () => {
        assert.deepEqual(step('forged channel messages, then one good one').mailKeys, [
          { key: 'Escape' },
        ]);
      },
    );

    await t.test('keys from the app page itself are never relayed as mail keys', () => {
      for (const name of [
        'app page: j typed in its own input',
        'app page: k with focus on the page',
      ]) {
        assert.deepEqual(step(name).mailKeys, [], name);
        assert.notEqual(
          step(name).focused,
          r.url,
          `${name}: the sealed frame is not the focused one`,
        );
      }
      assert.deepEqual(step('app page: j typed in its own input').hostKeys, ['j']);
      assert.deepEqual(step('app page: k with focus on the page').hostKeys, ['k']);
    });

    const click = (id: string) => r.links.clicked[id];

    await t.test(
      'mailto in the letter goes to Compose through the mail sink with the parsed URL, never to the browser',
      () => {
        assert.deepEqual(click('mail-blank').mails, [
          'mailto:ada@example.invalid?subject=Hi%20there',
        ]);
        assert.deepEqual(click('mail-blank').webs, []);
        assert.deepEqual(click('mail-self').mails, ['mailto:grace@example.invalid']);
        assert.deepEqual(click('mail-self').webs, []);
      },
    );

    await t.test(
      'http and https go to the browser sink; credentials, control characters and other schemes go nowhere',
      () => {
        assert.deepEqual(click('web-blank').webs, ['https://example.invalid/x']);
        assert.deepEqual(click('web-self').webs, ['https://example.invalid/y']);
        assert.deepEqual(click('http-self').webs, ['http://example.invalid/z']);
        for (const id of Object.keys(r.links.clicked)) {
          if (['mail-blank', 'mail-self', 'web-blank', 'web-self', 'http-self'].includes(id))
            continue;
          assert.deepEqual(click(id).mails, [], id);
          assert.deepEqual(click(id).webs, [], id);
        }
      },
    );

    await t.test('no click moved the letter or the page, and nothing ran', () => {
      for (const [id, result] of Object.entries(r.links.clicked)) {
        assert.equal(result.frameUrl, r.url, `${id}: the letter still shows its own document`);
        assert.equal(result.hostUrl, r.hostUrl, `${id}: the page did not move`);
      }
      assert.deepEqual(r.links.messages, []);
    });

    await t.test(
      'after a real in-mail fragment click the letter still gets its keys and its links',
      () => {
        const f = r.fragment;
        assert.equal(f.frameUrl, `${r.url}#m-section`, 'the fragment click changed the frame URL');
        assert.equal(f.focused, `${r.url}#m-section`);
        assert.deepEqual(f.mailKeys, [{ key: 'j' }]);
        assert.deepEqual(f.mails, ['mailto:grace@example.invalid']);
        assert.deepEqual(f.webs, ['https://example.invalid/y']);
      },
    );
  },
);
