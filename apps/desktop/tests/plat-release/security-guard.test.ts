import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// security.ts imports Electron, so it is bundled the way scripts/build-main.mjs bundles it (same
// __APLOS_RELEASE_BUILD__ define) and run against fake app/session/webContents objects. No Electron starts.
const entry = fileURLToPath(new URL('../../src/main/security.ts', import.meta.url));
const nodeRequire = createRequire(import.meta.url);
const bundles = new Map<boolean, Promise<string>>();
function bundle(release: boolean) {
  if (!bundles.has(release))
    bundles.set(
      release,
      build({
        entryPoints: [entry],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node22',
        external: ['electron'],
        define: { __APLOS_RELEASE_BUILD__: JSON.stringify(release) },
        write: false,
        logLevel: 'silent',
      }).then(result => result.outputFiles[0].text),
    );
  return bundles.get(release)!;
}

type Listener = (...args: unknown[]) => unknown;
class Emitter {
  listeners = new Map<string, Listener[]>();
  on(name: string, fn: Listener) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]);
    return this;
  }
  emit(name: string, ...args: unknown[]) {
    for (const fn of this.listeners.get(name) ?? []) fn(...args);
  }
  count(name: string) {
    return this.listeners.get(name)?.length ?? 0;
  }
}
class FakeSession extends Emitter {
  check?: Listener;
  request?: Listener;
  device?: Listener;
  display?: Listener;
  setPermissionCheckHandler(fn: Listener) {
    this.check = fn;
  }
  setPermissionRequestHandler(fn: Listener) {
    this.request = fn;
  }
  setDevicePermissionHandler(fn: Listener) {
    this.device = fn;
  }
  setDisplayMediaRequestHandler(fn: Listener) {
    this.display = fn;
  }
}
class FakeContents extends Emitter {
  openHandler?: Listener;
  constructor(
    public url: string,
    public session: FakeSession,
  ) {
    super();
  }
  getURL() {
    return this.url;
  }
  setWindowOpenHandler(fn: Listener) {
    this.openHandler = fn;
  }
}
const event = (fields: Record<string, unknown> = {}) => ({
  ...fields,
  defaultPrevented: false,
  preventDefault() {
    this.defaultPrevented = true;
  },
});
class Exit extends Error {
  constructor(public code: number) {
    super(`exit ${code}`);
  }
}

const RENDERER = 'file:///app/dist/renderer/index.html';
interface Security {
  installPermissionHandlers(): void;
  debugSwitch(argv: string[]): string | undefined;
  DEBUG_GUARD_EXIT_CODE: number;
}
interface Options {
  release?: boolean;
  packaged?: boolean;
  argv?: string[];
  switches?: string[];
  env?: Record<string, string>;
  platform?: string;
  inspector?: string;
}
async function load(options: Options = {}) {
  const app = Object.assign(new Emitter(), {
    isPackaged: options.packaged ?? true,
    commandLine: { hasSwitch: (name: string) => (options.switches ?? []).includes(name) },
  });
  const defaultSession = new FakeSession();
  const opened: string[] = [];
  const asked: string[] = [];
  const stderr: string[] = [];
  const signals: string[] = [];
  const electron = {
    app,
    session: { defaultSession },
    shell: { openExternal: async (url: string) => void opened.push(url) },
    systemPreferences: {
      askForMediaAccess: async (kind: string) => (asked.push(kind), true),
    },
    BrowserWindow: { fromWebContents: () => ({}) },
  };
  const fakeProcess = {
    argv: ['/Applications/Aplos Mail.app/Contents/MacOS/Aplos Mail', ...(options.argv ?? [])],
    env: options.env ?? {},
    platform: options.platform ?? 'darwin',
    stderr: { write: (line: string) => void stderr.push(line) },
    on: (name: string) => void signals.push(name),
    exit: (code: number) => {
      throw new Exit(code);
    },
  };
  const module = { exports: {} as Security };
  const inspector = { url: () => options.inspector };
  // The guard writes its one line with fs.writeSync(2, ...) so it survives the exit; capture fd 2 only.
  const fs = {
    ...(nodeRequire('node:fs') as object),
    writeSync: (fd: number, line: string) => {
      if (fd !== 2) throw new Error(`unexpected write to fd ${fd}`);
      stderr.push(line);
      return line.length;
    },
  };
  const fakes: Record<string, unknown> = { electron, 'node:inspector': inspector, 'node:fs': fs };
  const requireFake = (id: string) => fakes[id] ?? nodeRequire(id);
  let exitCode: number | undefined;
  try {
    new Function(
      'require',
      'module',
      'exports',
      'process',
      '__dirname',
      await bundle(options.release ?? false),
    )(requireFake, module, module.exports, fakeProcess, '/app/dist/main');
  } catch (error) {
    if (!(error instanceof Exit)) throw error;
    exitCode = error.code;
  }
  return {
    security: module.exports,
    app,
    defaultSession,
    opened,
    asked,
    stderr,
    signals,
    exitCode,
  };
}
async function installed(options: Options = {}) {
  const loaded = await load(options);
  loaded.security.installPermissionHandlers();
  const contents = (url = RENDERER, ses = loaded.defaultSession) => {
    const wc = new FakeContents(url, ses);
    loaded.app.emit('web-contents-created', event(), wc);
    return wc;
  };
  return { ...loaded, contents };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

const PERMISSIONS = [
  'clipboard-read',
  'clipboard-sanitized-write',
  'display-capture',
  'fileSystem',
  'fullscreen',
  'geolocation',
  'hid',
  'idle-detection',
  'keyboardLock',
  'local-fonts',
  'mediaKeySystem',
  'midi',
  'midiSysex',
  'notifications',
  'openExternal',
  'pointerLock',
  'serial',
  'storage-access',
  'usb',
  'bluetooth',
  'window-management',
  'unknown',
];

test('installPermissionHandlers hardens the default session and listens for every new session and webContents', async () => {
  const { security, app, defaultSession } = await load();
  security.installPermissionHandlers();
  security.installPermissionHandlers(); // a second call adds nothing
  for (const handler of ['check', 'request', 'device', 'display'] as const)
    assert.equal(typeof defaultSession[handler], 'function', handler);
  assert.equal(app.count('web-contents-created'), 1);
  assert.equal(app.count('session-created'), 1);
  for (const name of ['select-hid-device', 'select-serial-port', 'select-usb-device'])
    assert.equal(defaultSession.count(name), 1, name);
});

test('permission checks deny everything except the trusted window microphone', async () => {
  const { defaultSession, contents } = await installed();
  const trusted = contents(`${RENDERER}?thread=t1`);
  const outside = contents('https://example.com/');
  const check = defaultSession.check!;
  for (const permission of PERMISSIONS)
    assert.equal(check(trusted, permission, 'file:///', { isMainFrame: true }), false, permission);
  assert.equal(
    check(trusted, 'media', 'file:///', { mediaType: 'audio', isMainFrame: true }),
    true,
  );
  assert.equal(
    check(trusted, 'media', 'file:///', { mediaType: 'unknown', isMainFrame: true }),
    true,
  );
  assert.equal(
    check(trusted, 'media', 'file:///', { mediaType: 'video', isMainFrame: true }),
    false,
  );
  assert.equal(
    check(trusted, 'media', 'file:///', {
      mediaType: 'audio',
      isMainFrame: true,
      requestingUrl: RENDERER,
    }),
    true,
  );
  assert.equal(check(outside, 'media', 'https://example.com', { mediaType: 'audio' }), false);
  assert.equal(check(null, 'media', '', { mediaType: 'audio' }), false);
  // A frame inside the trusted window is not the trusted window.
  for (const details of [
    { mediaType: 'audio', isMainFrame: false, requestingUrl: RENDERER },
    { mediaType: 'audio', isMainFrame: false, requestingUrl: 'about:blank' },
    { mediaType: 'audio', isMainFrame: true, requestingUrl: 'https://evil.example/' },
  ])
    assert.equal(check(trusted, 'media', 'file:///', details), false, JSON.stringify(details));
});

test('permission requests deny everything; the trusted microphone still asks macOS', async () => {
  const { defaultSession, contents, asked } = await installed();
  const trusted = contents(RENDERER);
  const request = (wc: FakeContents, permission: string, details: unknown) =>
    new Promise(resolve => defaultSession.request!(wc, permission, resolve, details));
  // Electron always sets isMainFrame and requestingUrl on a request (PermissionRequest).
  const main = { isMainFrame: true, requestingUrl: RENDERER };
  for (const permission of PERMISSIONS)
    assert.equal(await request(trusted, permission, main), false, permission);
  assert.equal(await request(trusted, 'media', { ...main, mediaTypes: ['audio', 'video'] }), false);
  assert.equal(await request(trusted, 'media', { ...main, mediaTypes: ['video'] }), false);
  assert.equal(
    await request(contents('https://example.com/'), 'media', {
      isMainFrame: true,
      requestingUrl: 'https://example.com/',
      mediaTypes: ['audio'],
    }),
    false,
  );
  // Subframes of the trusted window, or a request without frame details, never reach the grant.
  for (const details of [
    { mediaTypes: ['audio'], isMainFrame: false, requestingUrl: 'about:blank' },
    { mediaTypes: ['audio'], isMainFrame: false, requestingUrl: RENDERER },
    { mediaTypes: ['audio'], isMainFrame: false, requestingUrl: 'https://evil.example/' },
    { mediaTypes: ['audio'], isMainFrame: true, requestingUrl: 'https://evil.example/' },
    { mediaTypes: ['audio'] },
  ])
    assert.equal(await request(trusted, 'media', details), false, JSON.stringify(details));
  assert.deepEqual(asked, []);
  assert.equal(await request(trusted, 'media', { ...main, mediaTypes: ['audio'] }), true);
  assert.equal(
    await request(trusted, 'media', { ...main, requestingUrl: `${RENDERER}?thread=t1` }),
    true,
  );
  assert.deepEqual(asked, ['microphone', 'microphone']);

  const linux = await installed({ platform: 'linux' });
  const granted = await new Promise(resolve =>
    linux.defaultSession.request!(linux.contents(RENDERER), 'media', resolve, {
      ...main,
      mediaTypes: ['audio'],
    }),
  );
  assert.equal(granted, true);
  assert.deepEqual(linux.asked, []);
});

test('device, display-capture and device-chooser requests are refused', async () => {
  const { defaultSession, contents } = await installed();
  for (const deviceType of ['hid', 'serial', 'usb', 'bluetooth'])
    assert.equal(defaultSession.device!({ deviceType, origin: 'file://' }), false, deviceType);
  const streams: unknown[] = [];
  defaultSession.display!(
    { frame: null, videoRequested: true, audioRequested: true },
    (value: unknown) => streams.push(value),
  );
  assert.deepEqual(streams, [null]);

  const picks: unknown[] = [];
  const hid = event();
  defaultSession.emit(
    'select-hid-device',
    hid,
    { deviceList: [{ deviceId: 'h' }] },
    (id: unknown) => picks.push(id),
  );
  const serial = event();
  defaultSession.emit('select-serial-port', serial, [{ portId: 's' }], {}, (id: unknown) =>
    picks.push(id),
  );
  const usb = event();
  defaultSession.emit(
    'select-usb-device',
    usb,
    { deviceList: [{ deviceId: 'u' }] },
    (id?: unknown) => picks.push(id),
  );
  const bluetooth = event();
  contents().emit('select-bluetooth-device', bluetooth, [{ deviceId: 'b' }], (id: unknown) =>
    picks.push(id),
  );
  assert.deepEqual(picks, [null, '', undefined, '']);
  for (const e of [hid, serial, usb, bluetooth]) assert.equal(e.defaultPrevented, true);
});

const OUTSIDE = [
  'https://example.com/',
  'http://127.0.0.1:5173/',
  'javascript:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  'file:///etc/passwd',
  'file:///app/dist/renderer/other.html',
  'about:blank',
  'aplos:thread/1',
  'mailto:someone@example.com',
  'not a url',
];

test('navigation and redirects are blocked unless they go to the renderer', async () => {
  const { contents } = await installed();
  const wc = contents();
  const blocked = (name: string, url: string, isMainFrame = true) => {
    const e = event({ url, isMainFrame });
    wc.emit(name, e, url);
    return e.defaultPrevented;
  };
  for (const name of ['will-navigate', 'will-redirect']) {
    for (const url of OUTSIDE) assert.equal(blocked(name, url), true, `${name} ${url}`);
    assert.equal(blocked(name, RENDERER), false, name);
    assert.equal(blocked(name, `${RENDERER}?draft=d1#x`), false, name);
  }
  // Main frames are judged by will-navigate (see the next test); will-frame-navigate leaves them alone.
  for (const url of OUTSIDE) assert.equal(blocked('will-frame-navigate', url), false, url);
  // Subframes may hold inert documents, nothing else from outside.
  assert.equal(blocked('will-frame-navigate', 'about:srcdoc', false), false);
  assert.equal(blocked('will-frame-navigate', 'about:blank', false), false);
  assert.equal(blocked('will-frame-navigate', RENDERER, false), false);
  for (const url of OUTSIDE.filter(url => url !== 'about:blank'))
    assert.equal(blocked('will-frame-navigate', url, false), true, url);
  assert.equal(blocked('will-redirect', 'https://example.com/', false), true);
});

test('a blocked top-level link still reaches windows.ts, which opens it in the browser', async () => {
  const { contents, security, opened } = await installed();
  const wc = contents();
  // windows.ts's own will-navigate handler, registered after the guard (the guard runs at creation).
  const sec = security as unknown as Security & {
    trustedURL(url: string): boolean;
    external(url: string): Promise<void>;
  };
  wc.on('will-navigate', (...args: unknown[]) => {
    const [e, url] = args as [ReturnType<typeof event>, string];
    if (!sec.trustedURL(url)) {
      e.preventDefault();
      void sec.external(url).catch(() => {});
    }
  });
  // Electron's order for a main-frame navigation: will-frame-navigate, then will-navigate only if the
  // first was not prevented.
  const navigate = (url: string) => {
    const frame = event({ url, isMainFrame: true });
    wc.emit('will-frame-navigate', frame);
    if (frame.defaultPrevented) return true;
    const e = event({ url, isMainFrame: true });
    wc.emit('will-navigate', e, url);
    return e.defaultPrevented;
  };
  assert.equal(navigate('https://example.com/clicked'), true);
  assert.equal(navigate('javascript:alert(1)'), true);
  assert.equal(navigate(RENDERER), false);
  await settle();
  assert.deepEqual(opened, ['https://example.com/clicked']);
});

test('the dev renderer origin is the only trusted one under APLOS_RENDERER_URL', async () => {
  const { contents } = await installed({ env: { APLOS_RENDERER_URL: 'http://127.0.0.1:5173/' } });
  const wc = contents('http://127.0.0.1:5173/');
  for (const [url, prevented] of [
    ['http://127.0.0.1:5173/?thread=1', false],
    ['http://127.0.0.1:4317/', true],
    [RENDERER, true],
  ] as const) {
    const e = event({ url, isMainFrame: true });
    wc.emit('will-navigate', e, url);
    assert.equal(e.defaultPrevented, prevented, url);
  }
});

test('a release build ignores APLOS_RENDERER_URL', async () => {
  const attacker = 'http://127.0.0.1:31337/';
  const { contents, defaultSession, asked, security } = await installed({
    release: true,
    env: { APLOS_RENDERER_URL: attacker },
  });
  assert.equal((security as unknown as { devURL?: string }).devURL, undefined);
  const wc = contents(attacker);
  for (const [url, prevented] of [
    [attacker, true],
    [RENDERER, false],
  ] as const) {
    const e = event({ url, isMainFrame: true });
    wc.emit('will-navigate', e, url);
    assert.equal(e.defaultPrevented, prevented, url);
  }
  const granted = await new Promise(resolve =>
    defaultSession.request!(wc, 'media', resolve, {
      isMainFrame: true,
      requestingUrl: attacker,
      mediaTypes: ['audio'],
    }),
  );
  assert.equal(granted, false);
  assert.deepEqual(asked, []);
});

test('window.open is always denied; only web and mail links open in the browser', async () => {
  const { contents, opened } = await installed();
  const wc = contents();
  const urls = [
    'https://example.com/a',
    'http://example.com/b',
    'mailto:someone@example.com',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,hi',
    'about:blank',
    'https://user:pass@example.com/',
    'aplos:thread/1',
    '',
  ];
  for (const url of urls) assert.deepEqual(wc.openHandler!({ url }), { action: 'deny' }, url);
  await settle();
  assert.deepEqual(opened, [
    'https://example.com/a',
    'http://example.com/b',
    'mailto:someone@example.com',
  ]);
});

test('every webContents is guarded, including webview hosts and views in other sessions', async () => {
  const { app, contents } = await installed();
  const attach = event();
  const wc = contents();
  wc.emit('will-attach-webview', attach, {}, {});
  assert.equal(attach.defaultPrevented, true);
  for (const name of [
    'will-navigate',
    'will-frame-navigate',
    'will-redirect',
    'will-attach-webview',
  ])
    assert.equal(wc.count(name), 1, name);

  const partition = new FakeSession();
  const view = contents('about:blank', partition);
  assert.equal(typeof view.openHandler, 'function');
  assert.equal(partition.check!(view, 'media', '', { mediaType: 'audio' }), false);
  assert.equal(partition.device!({ deviceType: 'usb' }), false);
  const created = new FakeSession();
  app.emit('session-created', created);
  assert.equal(created.check!(null, 'geolocation', '', {}), false);
  assert.equal(created.count('select-usb-device'), 1);
  app.emit('session-created', created); // hardened once per session
  assert.equal(created.count('select-usb-device'), 1);
});

const HOSTILE_ARGS = [
  ['--remote-debugging-port=0'],
  ['--remote-debugging-port', '9222'],
  ['-remote-debugging-port=9222'],
  ['--remote-debugging-pipe'],
  ['--remote-debugging-address=0.0.0.0'],
  ['--inspect'],
  ['--inspect=0'],
  ['--inspect-brk=9229'],
  ['--inspect-port=9229'],
  ['--inspect-wait'],
  ['--debug-port=9229'],
  ['--debug'],
  ['--debug-brk=5858'],
  ['-inspect-brk=9229'],
  ['--js-flags=--inspect'],
  ['--user-data-dir=/tmp/x', '--INSPECT=0'],
];

test('a packaged release build exits with code 78 for every debugging switch, before anything else', async () => {
  for (const argv of HOSTILE_ARGS) {
    // load() only sees the exit if it happens while the module itself is evaluated (on import).
    for (const packaged of [true, false]) {
      // app.isPackaged comes from the executable's name, so it must not matter.
      const { exitCode, stderr } = await load({ release: true, packaged, argv });
      assert.equal(exitCode, 78, `${packaged} ${argv.join(' ')}`);
      assert.equal(stderr.length, 1);
      // Only the switch name is printed, never a value (a port, an address, a js-flags string).
      assert.match(stderr[0], /^Aplos Mail: a release build does not start with --[a-z-]+\.\n$/);
    }
  }
  // Chromium's own parse (app.commandLine) is a second source.
  const parsed = await load({ release: true, packaged: true, switches: ['remote-debugging-port'] });
  assert.equal(parsed.exitCode, 78);
  assert.deepEqual(parsed.stderr, [
    'Aplos Mail: a release build does not start with --remote-debugging-port.\n',
  ]);
  // An inspector opened some other way (NODE_OPTIONS on a build without the fuse) is refused too.
  const inspecting = await load({ release: true, inspector: 'ws://127.0.0.1:9229/x' });
  assert.equal(inspecting.exitCode, 78);
});

test('a release build traps SIGUSR1 so it cannot open the inspector; other builds leave it to Node', async () => {
  assert.deepEqual((await load({ release: true })).signals, ['SIGUSR1']);
  assert.deepEqual((await load({ release: false })).signals, []);
});

test('the debug guard leaves dev, local package and E2E builds, and harmless switches, alone', async () => {
  for (const argv of HOSTILE_ARGS) {
    for (const options of [
      { release: false, packaged: true },
      { release: false, packaged: false },
    ]) {
      const { exitCode, security } = await load({ ...options, argv });
      assert.equal(exitCode, undefined, `${JSON.stringify(options)} ${argv.join(' ')}`);
      assert.equal(typeof security.installPermissionHandlers, 'function');
    }
  }
  const harmless = [
    '--user-data-dir=/tmp/aplos',
    '--js-flags=--expose-gc',
    'aplos:thread/1',
    'mailto:someone@example.com?subject=--inspect',
    '--lang=en',
    '--debugger-ui',
    '-NSDocumentRevisionsDebugMode',
    'YES',
  ];
  const { exitCode } = await load({ release: true, packaged: true, argv: harmless });
  assert.equal(exitCode, undefined);
  const dev = await load({ release: false, inspector: 'ws://127.0.0.1:9229/x' });
  assert.equal(dev.exitCode, undefined);
});

test('debugSwitch names the first debugging switch after the executable', async () => {
  const { security } = await load();
  assert.equal(security.DEBUG_GUARD_EXIT_CODE, 78);
  assert.equal(security.debugSwitch(['exe', 'aplos:x', '--inspect-brk=1']), '--inspect-brk');
  assert.equal(security.debugSwitch(['--inspect']), undefined, 'argv[0] is the executable');
});

// verify-hardening.mjs lands from its own branch (rv/plat-release/verify-hardening); once both are in,
// this pins the two exit codes together.
const verifier = new URL('../../scripts/verify-hardening.mjs', import.meta.url);
test(
  'the guard and verify-hardening agree on the exit code',
  { skip: !existsSync(verifier) && 'verify-hardening.mjs is not on this branch yet' },
  async () => {
    const { security } = await load();
    const vh = (await import(verifier.href)) as { DEBUG_GUARD_EXIT_CODE: number };
    assert.equal(vh.DEBUG_GUARD_EXIT_CODE, security.DEBUG_GUARD_EXIT_CODE);
  },
);
