import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { REPORTER_SOURCE } from '@aplos/mail-html/frame';

// html-5's Electron wiring (main/mail-protocol.ts, the subframe rule in main/security.ts), bundled the way
// scripts/build-main.mjs bundles main and run against fake Electron objects; plus source pins for what must stay true
// across files (one webRequest owner, real path only, never both key relays). No Electron starts.

const nodeRequire = createRequire(import.meta.url);
const src = fileURLToPath(new URL('../../src/', import.meta.url));
const TOKEN = 'cd'.repeat(16);
const DOC = `aplos-mail://m/${TOKEN}/`;
const RENDERER = 'file:///app/dist/renderer/index.html';

async function bundle(entry: string): Promise<string> {
  const result = await build({
    entryPoints: [join(src, entry)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
    define: { __APLOS_RELEASE_BUILD__: 'false' },
    write: false,
    logLevel: 'silent',
  });
  return result.outputFiles[0].text;
}

function run<T>(code: string, electron: unknown, dirname = '/app/dist/main'): T {
  const module = { exports: {} as T };
  const fakes: Record<string, unknown> = { electron };
  const requireFake = (id: string) => fakes[id] ?? nodeRequire(id);
  new Function('require', 'module', 'exports', '__dirname', code)(
    requireFake,
    module,
    module.exports,
    dirname,
  );
  return module.exports;
}

type Listener = (...args: unknown[]) => unknown;

function fakeMailElectron() {
  const registered: unknown[] = [];
  const handled: { scheme: string; handler: Listener }[] = [];
  const listeners = { headers: [] as Listener[], request: [] as Listener[] };
  const contents = new Map<number, { type: string; window?: number; destroyed?: boolean }>([
    [4, { type: 'window', window: 2 }],
    [5, { type: 'webview', window: 3 }],
    [6, { type: 'window', window: 9, destroyed: true }],
    [7, { type: 'window' }],
  ]);
  const defaultSession = {
    webRequest: {
      onBeforeSendHeaders: (fn: Listener) => void listeners.headers.push(fn),
      onBeforeRequest: (fn: Listener) => void listeners.request.push(fn),
    },
    protocol: {
      handle: (scheme: string, handler: Listener) => void handled.push({ scheme, handler }),
    },
  };
  const electron = {
    protocol: { registerSchemesAsPrivileged: (list: unknown) => void registered.push(list) },
    session: { defaultSession },
    webContents: {
      fromId: (id: number) => {
        const entry = contents.get(id);
        if (!entry) return undefined;
        return { id, getType: () => entry.type, isDestroyed: () => !!entry.destroyed, entry };
      },
    },
    BrowserWindow: {
      fromWebContents: (c: { entry: { window?: number } }) =>
        c.entry.window === undefined ? null : { id: c.entry.window },
    },
  };
  return { electron, registered, handled, listeners, defaultSession };
}

interface MailProtocol {
  registerMailScheme(): void;
  installWebRequestGuards(ses: unknown): boolean;
  installMailProtocol(serve: (args: unknown) => Promise<unknown>): void;
}

const mailBundle = bundle('main/mail-protocol.ts');

test('registerMailScheme registers aplos-mail as standard+secure, nothing else', async () => {
  const fake = fakeMailElectron();
  run<MailProtocol>(await mailBundle, fake.electron).registerMailScheme();
  assert.deepEqual(fake.registered, [
    [{ scheme: 'aplos-mail', privileges: { standard: true, secure: true } }],
  ]);
});

test('one listener per webRequest event: installing twice never replaces the first', async () => {
  const fake = fakeMailElectron();
  const mail = run<MailProtocol>(await mailBundle, fake.electron);
  assert.equal(mail.installWebRequestGuards(fake.defaultSession), true);
  assert.equal(mail.installWebRequestGuards(fake.defaultSession), false);
  mail.installMailProtocol(async () => ({}));
  mail.installMailProtocol(async () => ({}));
  assert.equal(fake.listeners.headers.length, 1);
  assert.equal(fake.listeners.request.length, 1);
  assert.deepEqual(
    fake.handled.map(h => h.scheme),
    ['aplos-mail'],
  );
});

test('the installed listeners stamp the window and run the backstop', async () => {
  const fake = fakeMailElectron();
  const mail = run<MailProtocol>(await mailBundle, fake.electron);
  mail.installMailProtocol(async () => ({}));
  const [stamp] = fake.listeners.headers;
  const [backstop] = fake.listeners.request;
  let headers: unknown;
  stamp(
    { url: DOC, webContentsId: 4, requestHeaders: { 'x-aplos-window': '99' } },
    (out: { requestHeaders: unknown }) => (headers = out.requestHeaders),
  );
  assert.deepEqual(headers, { 'X-Aplos-Window': '4' });
  const cancel = (details: Record<string, unknown>) => {
    let out: { cancel?: boolean } = {};
    backstop(details, (value: { cancel?: boolean }) => (out = value));
    return out.cancel;
  };
  assert.equal(cancel({ url: 'https://x.example/', initiatorOrigin: 'null' }), true);
  assert.equal(cancel({ url: 'wss://x.example/', frame: { url: DOC } }), true);
  assert.equal(cancel({ url: 'https://x.example/', initiatorOrigin: 'file://' }), false);
  const gone = {
    url: 'https://x.example/',
    get frame(): never {
      throw new Error('frame gone');
    },
  };
  assert.equal(cancel(gone), false, 'a frame that is gone is read as none, never a throw');
});

test('the handler names only a live app window: webviews, destroyed or windowless contents are the 404', async () => {
  const fake = fakeMailElectron();
  const mail = run<MailProtocol>(await mailBundle, fake.electron);
  const asked: unknown[] = [];
  mail.installMailProtocol(async args => {
    asked.push(args);
    return {
      status: 404,
      headers: { 'content-security-policy': "default-src 'none'" },
      body: new Uint8Array(),
    };
  });
  const handler = fake.handled[0].handler as (request: unknown) => Promise<Response>;
  for (const stamp of ['4', '5', '6', '7', '8']) {
    const response = await handler({
      method: 'GET',
      url: DOC,
      headers: new Headers({ 'X-Aplos-Window': stamp }),
    });
    assert.equal(response.status, 404);
  }
  assert.deepEqual(asked, [{ token: TOKEN, path: '', windowId: '2' }]);
});

// ---- security.ts: the subframe rule ------------------------------------------------------------------------------

class Emitter {
  listeners = new Map<string, Listener[]>();
  on(name: string, fn: Listener) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]);
    return this;
  }
  emit(name: string, ...args: unknown[]) {
    for (const fn of this.listeners.get(name) ?? []) fn(...args);
  }
}

function fakeSecurityElectron() {
  const session = Object.assign(new Emitter(), {
    setPermissionCheckHandler() {},
    setPermissionRequestHandler() {},
    setDevicePermissionHandler() {},
    setDisplayMediaRequestHandler() {},
  });
  const app = Object.assign(new Emitter(), {
    isPackaged: false,
    commandLine: { hasSwitch: () => false },
  });
  const electron = {
    app,
    session: { defaultSession: session },
    shell: { openExternal: async () => undefined },
    systemPreferences: {},
    BrowserWindow: { fromWebContents: () => ({}) },
  };
  return { electron, app, session };
}

const event = (fields: Record<string, unknown>) => ({
  ...fields,
  defaultPrevented: false,
  preventDefault() {
    this.defaultPrevented = true;
  },
});

async function guardedContents() {
  const fake = fakeSecurityElectron();
  const security = run<{ installPermissionHandlers(): void; allowMailFrames(): void }>(
    await bundle('main/security.ts'),
    fake.electron,
  );
  security.installPermissionHandlers();
  const contents = Object.assign(new Emitter(), {
    session: fake.session,
    getURL: () => RENDERER,
    setWindowOpenHandler() {},
  });
  fake.app.emit('web-contents-created', event({}), contents);
  const blocked = (name: string, fields: Record<string, unknown>) => {
    const e = event(fields);
    contents.emit(name, e);
    return e.defaultPrevented;
  };
  return { security, blocked };
}

test('security.ts: no aplos-mail frame before the real path allows it (the legacy path never does)', async () => {
  const { blocked } = await guardedContents();
  assert.equal(blocked('will-frame-navigate', { url: DOC, isMainFrame: false }), true);
  assert.equal(blocked('will-frame-navigate', { url: 'about:srcdoc', isMainFrame: false }), false);
});

test('security.ts: once allowed, only the exact document form, only in a subframe', async () => {
  const { security, blocked } = await guardedContents();
  security.allowMailFrames();
  assert.equal(blocked('will-frame-navigate', { url: DOC, isMainFrame: false }), false);
  assert.equal(blocked('will-redirect', { url: DOC, isMainFrame: false }), false);
  const refused = [
    `${DOC}cid/0`,
    `${DOC}img/0`,
    `aplos-mail://m/${TOKEN}`,
    `${DOC}?x`,
    `aplos-mail://m/${TOKEN.toUpperCase()}/`,
    'aplos-mail://m/',
    `aplos-mail://x/${TOKEN}/`,
    'https://example.com/',
    'javascript:alert(1)',
  ];
  for (const url of refused) {
    assert.equal(blocked('will-frame-navigate', { url, isMainFrame: false }), true, url);
    assert.equal(blocked('will-redirect', { url, isMainFrame: false }), true, url);
  }
  assert.equal(blocked('will-navigate', { url: DOC }), true, 'main frame: never');
  assert.equal(
    blocked('will-redirect', { url: DOC, isMainFrame: true }),
    true,
    'main frame redirect: never',
  );
});

// ---- source pins -------------------------------------------------------------------------------------------------

function sources(dir: string): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (/\.(ts|tsx|cjs|mjs|js)$/.test(name) && !/\.test\.tsx?$/.test(name))
      out.push({ file: relative(src, path), text: readFileSync(path, 'utf8') });
  }
  return out;
}
const all = sources(src);
/** Code lines only: a line that is a comment (`//`, `/*`, ` * `) may name an API without calling it. */
const code = (text: string) =>
  text
    .split('\n')
    .filter(line => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
    .join('\n');
const filesWith = (pattern: RegExp) => all.filter(s => pattern.test(code(s.text))).map(s => s.file);

test('mail-protocol.ts is the only owner of webRequest listeners and scheme privileges', () => {
  assert.deepEqual(filesWith(/webRequest\s*\.\s*on/), ['main/mail-protocol.ts']);
  assert.deepEqual(filesWith(/registerSchemesAsPrivileged/), ['main/mail-protocol.ts']);
  assert.deepEqual(filesWith(/protocol\s*\.\s*handle\s*\(/), ['main/mail-protocol.ts']);
});

test('real path only: the scheme is registered under `if (realPath)` and the relay installed from bootRealEngine', () => {
  assert.deepEqual(filesWith(/registerMailScheme\(\)/), [
    'main/engine-host.ts',
    'main/mail-protocol.ts',
  ]);
  const host = all.find(s => s.file === 'main/engine-host.ts')!.text;
  assert.match(host, /^if \(realPath\) registerMailScheme\(\);$/m);
  assert.equal(host.match(/registerMailScheme\(\)/g)?.length, 1);
  assert.deepEqual(filesWith(/installMailProtocol\(/), [
    'main/engine-real.ts',
    'main/mail-protocol.ts',
  ]);
  assert.deepEqual(filesWith(/allowMailFrames\(\)/), ['main/engine-real.ts', 'main/security.ts']);
  const real = all.find(s => s.file === 'main/engine-real.ts')!.text;
  const boot = /async function bootRealEngine[\s\S]*?\n}\n/.exec(real)?.[0] ?? '';
  assert.match(boot, /installMailProtocol\(serveMail\);\s*allowMailFrames\(\);/);
});

test('main never loosens the frame sandbox: no allow-same-origin, no sandbox attribute written', () => {
  const main = all.filter(s => s.file.startsWith('main/') || s.file.startsWith('host/'));
  for (const { file, text } of main) {
    assert.doesNotMatch(text, /allow-same-origin/, file);
    assert.doesNotMatch(text, /setAttribute\(\s*['"]sandbox/, file);
  }
});

test('keys: never both main’s before-input-event relay and the reporter’s key fallback (today: neither)', () => {
  const reporterKeys = /key(?:down|up|press)|['"]key['"]/i.test(REPORTER_SOURCE);
  const mainKeys = filesWith(/before-input-event/).filter(f => f.startsWith('main/'));
  assert.ok(!(reporterKeys && mainKeys.length > 0), 'a key would arrive twice');
  // Pinned as it is today (DECISIONS, html-5): whoever adds one relay updates this line and keeps the other off.
  assert.deepEqual({ reporterKeys, mainKeys }, { reporterKeys: false, mainKeys: [] });
});
