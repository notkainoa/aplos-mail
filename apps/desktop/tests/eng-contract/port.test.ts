import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { MessageChannel } from 'node:worker_threads';
import type { Frame } from '@aplos/contract';
import type { EngineSession } from '@aplos/contract/client';
import { hostMethods, secretMethods } from '@aplos/contract/allowlists';
import {
  CONNECT_LIMIT,
  controlMethods,
  createPortBroker,
  createPortClient,
  createPortHost,
  MAX_ARGS_BYTES,
  MAX_BLOB_MESSAGE_BYTES,
  MAX_IN_FLIGHT,
  MAX_IN_FLIGHT_BYTES,
  messageBytes,
  portMethods,
  revokeOnNewDocument,
  serveWindowPort,
  signInURL,
  trustedCaller,
  type CallerEvent,
  type EngineLink,
  type PortMessage,
} from '../../src/host/transports/port';
import { engineEndOf, fakeWindow, portTracker, until, windowEndOf } from './rig';

const APP = 'file:///app/renderer/index.html';
const trustedURL = (url: string) => url === APP;

/** A webContents with its main frame, and a subframe in it. */
function contents(url: string, type = 'window') {
  const mainFrame = { url, detached: false };
  const sender = { mainFrame, isDestroyed: () => false, getType: () => type };
  return { sender, mainFrame };
}
const windowFor = { id: 7 };
const check = (event: CallerEvent, hasWindow = true) =>
  trustedCaller(event, { trustedURL, windowOf: () => (hasWindow ? windowFor : undefined) });

test('port hijack: only a window’s trusted main frame gets a port', () => {
  const app = contents(APP);
  assert.equal(check({ sender: app.sender, senderFrame: app.mainFrame }), windowFor);

  // A mail frame (aplos-mail://m/<token>) is a subframe of the app's page: refused by design (ARCH 12.1).
  const mailFrame = { url: 'aplos-mail://m/token/', detached: false };
  assert.equal(check({ sender: app.sender, senderFrame: mailFrame }), undefined);
  // Any subframe, even one showing the app's own URL.
  assert.equal(check({ sender: app.sender, senderFrame: { url: APP } }), undefined);
  // A DevTools page: its own webContents, not a window's, at devtools://.
  const devtools = contents('devtools://devtools/bundled/devtools_app.html', 'remote');
  assert.equal(check({ sender: devtools.sender, senderFrame: devtools.mainFrame }), undefined);
  const devtoolsWindow = contents('devtools://devtools/bundled/devtools_app.html');
  assert.equal(
    check({ sender: devtoolsWindow.sender, senderFrame: devtoolsWindow.mainFrame }),
    undefined,
  );
  // Another origin in a window's main frame (a navigation that slipped through, a dev server it does not trust).
  const other = contents('https://evil.example/');
  assert.equal(check({ sender: other.sender, senderFrame: other.mainFrame }), undefined);
  // A webview, a detached frame, no frame, a webContents with no window.
  const webview = contents(APP, 'webview');
  assert.equal(check({ sender: webview.sender, senderFrame: webview.mainFrame }), undefined);
  const detached = contents(APP);
  detached.mainFrame.detached = true;
  assert.equal(check({ sender: detached.sender, senderFrame: detached.mainFrame }), undefined);
  assert.equal(check({ sender: app.sender, senderFrame: null }), undefined);
  assert.equal(check({ sender: app.sender, senderFrame: app.mainFrame }, false), undefined);
});

/**
 * A fake engine session that records calls and lets a test push frames. `leaky` keeps delivering frames after `close`,
 * like an engine bug would, so only the port's own guards can stop them.
 */
function fakeSession(options: { leaky?: boolean } = {}) {
  const calls: string[] = [];
  const listeners = new Set<(frame: Frame) => void>();
  let closed = false;
  const session: EngineSession = {
    call: async (method, args) => {
      calls.push(method);
      return { method, args };
    },
    subscribe: listener => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    close: () => {
      closed = true;
      if (!options.leaky) listeners.clear();
    },
  };
  const push = (frame: Frame) => listeners.forEach(listener => listener(frame));
  return { session, calls, push, isClosed: () => closed };
}

const state = (seq: number): Frame => ({
  frame: 'state',
  dbEpoch: 'e1',
  seq,
  types: { Thread: seq },
});
const position = () => ({ dbEpoch: 'e1', seq: 1 });

/** A link whose `attach`/`detach` reach a port host directly, as the utility process would; `posts` records what the engine side sent. */
function directLink(
  host: ReturnType<typeof createPortHost>,
  posts: PortMessage[] = [],
): EngineLink {
  const recorded = (port: never) => {
    const end = engineEndOf(port);
    return { ...end, post: (message: PortMessage) => (posts.push(message), end.post(message)) };
  };
  return {
    ready: Promise.resolve(position()),
    exited: false,
    call: async () => ({}),
    attach: (windowId, port) => host.attach(windowId, recorded(port as never)),
    detach: windowId => host.detach(windowId),
    power: () => undefined,
    quit: () => undefined,
    kill: () => undefined,
    onExit: () => undefined,
  };
}

test('port hijack: a closed window’s port stops receiving frames at once', async t => {
  const engine = fakeSession({ leaky: true });
  const host = createPortHost(() => engine.session, { position });
  const ports = portTracker(t);
  const posts: PortMessage[] = [];
  const link = directLink(host, posts);
  const broker = createPortBroker({ channel: ports.channel, link: () => link });
  const one = fakeWindow(1);
  broker.connect(one.win);
  await until(() => one.client.position().dbEpoch === 'e1', 'hello');
  engine.push(state(2));
  await until(() => one.frames.length === 1, 'the first frame');

  one.state.destroyed = true;
  broker.revoke(1);
  const sentBefore = posts.length;
  assert.equal(engine.isClosed(), true, 'the engine session closes with the port');
  assert.deepEqual(host.windows(), []);
  engine.push(state(3));
  engine.push(state(4));
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(one.frames.length, 1, 'no frame after the window closed');
  assert.equal(posts.length, sentBefore, 'the engine side posted nothing more to the closed port');
  assert.deepEqual(broker.holders(), []);
  // A restart re-issues ports only to windows that still hold one.
  broker.reissue();
  assert.equal(one.state.deliveries, 1);
});

test('port hijack: the window side going away closes the engine side too', async t => {
  const engine = fakeSession();
  const { port1, port2 } = new MessageChannel();
  t.after(() => port1.close());
  const served = serveWindowPort(() => engine.session, engineEndOf(port1), { position });
  port2.close();
  await until(() => served.closed, 'the served port to close');
  assert.equal(engine.isClosed(), true);
});

test('port hijack: methods outside the allowlist, host-only and desktop-only methods are refused', async t => {
  for (const method of hostMethods) assert.equal(portMethods.has(method), false, method);
  // `Ai/pasteKey` is secret and desktop-only: main reads the clipboard, the key never crosses a window's port.
  assert.equal(portMethods.has('Ai/pasteKey'), false);
  assert.equal(portMethods.has('Thread/get'), true);

  const refusedNames = [
    'Notification/claim',
    'Mail/serve',
    'Ai/pasteKey',
    'Window/compose',
    'Fixture/control',
    'toString',
    '__proto__',
    'constructor',
  ];
  // Preload's check: nothing leaves the window, and the refusal is immediate.
  const client = createPortClient();
  const posted: string[] = [];
  let deliver: (data: unknown) => void = () => undefined;
  client.attach({
    post: message => void posted.push(message.method),
    onMessage: handler => void (deliver = handler),
    close: () => undefined,
  });
  deliver({ kind: 'hello', dbEpoch: 'e1', seq: 1 });
  const hung = () => new Promise(resolve => setTimeout(() => resolve('no answer'), 200));
  for (const method of refusedNames) {
    const outcome = await Promise.race([client.call(method, {}).catch(error => error), hung()]);
    assert.deepEqual(
      (outcome as { type?: string }).type,
      'unsupported',
      `${method}: ${String(outcome)}`,
    );
  }
  assert.deepEqual(posted, [], 'no refused name was posted on the port');

  // The engine's check, for a page that got past preload and posts raw envelopes on the port.
  const engine = fakeSession();
  const { port1, port2 } = new MessageChannel();
  t.after(() => {
    port1.close();
    port2.close();
  });
  serveWindowPort(() => engine.session, engineEndOf(port1), { position });
  const replies: PortMessage[] = [];
  port2.on('message', message => replies.push(message));
  refusedNames.forEach((method, i) => port2.postMessage({ v: 1, id: i + 1, method, args: {} }));
  // Not even an envelope: no id to answer, nothing dispatched.
  port2.postMessage({ method: 'Thread/get' });
  port2.postMessage('Thread/get');
  await until(() => replies.length === refusedNames.length + 1, 'every refusal');
  assert.deepEqual(engine.calls, [], 'no refused name reached the engine session');
  for (const reply of replies.slice(1))
    assert.deepEqual(reply.kind === 'reply' && !reply.ok && reply.error.type, 'unsupported');
});

test('secret methods: windows may call them, and only down their own port', () => {
  // ARCH 12.3: secret methods are Electron-windows-only. Over a window's port they are allowed (the engine also
  // refuses them to every listener); the clipboard paste stays in main.
  for (const method of secretMethods)
    if (method !== 'Ai/pasteKey') assert.equal(portMethods.has(method), true, method);
});

test('port hijack: a second window never sees the first window’s replies or frames', async t => {
  const sessions: ReturnType<typeof fakeSession>[] = [];
  const host = createPortHost(
    () => {
      const next = fakeSession();
      sessions.push(next);
      return next.session;
    },
    { position },
  );
  const ports = portTracker(t);
  const broker = createPortBroker({ channel: ports.channel, link: () => directLink(host) });
  const one = fakeWindow(1);
  const two = fakeWindow(2);
  broker.connect(one.win);
  broker.connect(two.win);
  assert.equal(sessions.length, 2, 'each window gets its own engine session');
  const [a, b] = await Promise.all([
    one.client.call('Blob/release', { blobId: 'from-one' }),
    two.client.call('Blob/release', { blobId: 'from-two' }),
  ]);
  assert.deepEqual(a, { method: 'Blob/release', args: { blobId: 'from-one' } });
  assert.deepEqual(b, { method: 'Blob/release', args: { blobId: 'from-two' } });
  // A frame the engine sends only to window one's session (a targeted `progress`, a blob reply) stays there.
  sessions[0].push(state(5));
  await until(() => one.frames.length === 1, 'window one’s frame');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(two.frames.length, 0);
  // Closing one leaves the other untouched.
  broker.revoke(1);
  assert.equal(sessions[0].isClosed(), true);
  assert.equal(sessions[1].isClosed(), false);
  assert.deepEqual(await two.client.call('Counts/get', {}), { method: 'Counts/get', args: {} });
});

test('binary moves as a transferred ArrayBuffer, never base64', async t => {
  const engine = fakeSession();
  const { port1, port2 } = new MessageChannel();
  t.after(() => {
    port1.close();
    port2.close();
  });
  serveWindowPort(() => engine.session, engineEndOf(port1), { position });
  const client = createPortClient();
  client.attach(windowEndOf(port2));
  const bytes = new Uint8Array(1024).fill(7);
  const reply = (await client.call('Blob/put', { bytes, mime: 'audio/webm' }, [
    bytes.buffer,
    'not a buffer',
    port2,
  ])) as { args: { bytes: Uint8Array } };
  assert.equal(bytes.byteLength, 0, 'the window’s buffer moved (detached), it was not copied');
  assert.ok(reply.args.bytes instanceof Uint8Array);
  assert.equal(reply.args.bytes.byteLength, 1024);
  assert.equal(reply.args.bytes[0], 7);
});

/** A session whose every call answers `result()`, a fresh value per call unless the test shares one. */
function answering(result: () => unknown): EngineSession {
  return {
    call: async () => result(),
    subscribe: () => () => undefined,
    close: () => undefined,
  };
}

/** One window over a real Node channel, served by `session`. */
function servedClient(t: TestContext, session: EngineSession) {
  const { port1, port2 } = new MessageChannel();
  t.after(() => {
    port1.close();
    port2.close();
  });
  serveWindowPort(() => session, engineEndOf(port1), { position });
  const client = createPortClient();
  client.attach(windowEndOf(port2));
  return client;
}

test('a Blob/get reply moves its buffer to the window instead of copying it', async t => {
  const handed: Uint8Array[] = [];
  const client = servedClient(
    t,
    answering(() => {
      const bytes = new Uint8Array(4096).fill(9);
      handed.push(bytes);
      return { bytes, mime: 'application/pdf', size: bytes.byteLength };
    }),
  );
  const reply = (await client.call('Blob/get', { blobId: 'b_x' })) as { bytes: Uint8Array };
  assert.equal(reply.bytes.byteLength, 4096);
  assert.equal(reply.bytes[4095], 9);
  assert.equal(handed[0].byteLength, 0, 'the engine’s buffer moved (detached), it was not copied');
});

test('a blob reply never moves a buffer it does not wholly own, and other replies never move one', async t => {
  const shared = new Uint8Array(1024).fill(3);
  const view = shared.subarray(16, 32);
  const client = servedClient(
    t,
    answering(() => ({ bytes: view, mime: 'text/plain', size: view.byteLength })),
  );
  const reply = (await client.call('Blob/get', { blobId: 'b_x' })) as { bytes: Uint8Array };
  assert.equal(reply.bytes.byteLength, 16);
  assert.equal(shared.byteLength, 1024, 'a view onto a larger buffer is copied, never moved');
  assert.equal(view.byteLength, 16);

  const kept = new Uint8Array(64).fill(5);
  const other = servedClient(
    t,
    answering(() => ({ bytes: kept })),
  );
  await other.call('Counts/get', {});
  assert.equal(kept.byteLength, 64, 'a non-blob route’s reply is never moved');
});

test('main may read a blob on its control connection, and nothing else of the blob area', () => {
  assert.ok(controlMethods.has('Blob/get'));
  assert.equal(controlMethods.has('Blob/put'), false);
  assert.equal(controlMethods.has('Blob/release'), false);
});

test('the menu-bar status poll is a control method: without it the tray is stuck on "Starting…"', () => {
  assert.ok(controlMethods.has('Account/get'));
});

test('the engine may only ask main to open a provider sign-in page', () => {
  assert.equal(
    signInURL('https://accounts.google.com/o/oauth2/v2/auth?client_id=x'),
    'https://accounts.google.com/o/oauth2/v2/auth?client_id=x',
  );
  for (const url of [
    'http://accounts.google.com/',
    'https://accounts.google.com.evil.example/',
    'https://user:pw@accounts.google.com/',
    'https://accounts.google.com:8443/',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'https://evil.example/',
    'https://accounts.google.com/',
    'https://accounts.google.com/signin/v2/identifier',
    'https://accounts.google.com/o/oauth2/v2/authx',
    42,
  ])
    assert.equal(signInURL(url), undefined, String(url));
});

const hangingSession = (): EngineSession => ({
  call: () => new Promise(() => undefined),
  subscribe: () => () => undefined,
  close: () => undefined,
});

test('port hijack: a prevented navigation keeps the port; a committed one revokes it and the new document gets a fresh one', async t => {
  const engine = fakeSession();
  const host = createPortHost(() => engine.session, { position });
  const ports = portTracker(t);
  const broker = createPortBroker({ channel: ports.channel, link: () => directLink(host) });
  const contents = new EventEmitter();
  revokeOnNewDocument(contents, () => broker.revoke(1));
  const one = fakeWindow(1);
  broker.connect(one.win);
  assert.ok(await one.client.call('Counts/get', {}));

  // Electron's order for a link the window layer opens in the browser instead: did-start-navigation, then
  // will-navigate (prevented), and no did-navigate. The page stays, and so must its port.
  contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  contents.emit('will-navigate', { preventDefault: () => undefined });
  assert.deepEqual(broker.holders(), [1]);
  assert.deepEqual(await one.client.call('Counts/get', {}), { method: 'Counts/get', args: {} });

  // A committed main-frame navigation (a reload) revokes it; the new document's preload asks again.
  contents.emit('did-navigate');
  assert.deepEqual(broker.holders(), []);
  const reloaded = fakeWindow(1);
  broker.connect(reloaded.win);
  assert.deepEqual(await reloaded.client.call('Counts/get', {}), {
    method: 'Counts/get',
    args: {},
  });
  // A dead renderer ends the port too.
  contents.emit('render-process-gone');
  assert.deepEqual(broker.holders(), []);
});

test('a port that closes under the window fails its open calls at once and lets preload ask again', async t => {
  const { port1, port2 } = new MessageChannel();
  t.after(() => port2.close());
  const served = serveWindowPort(hangingSession, engineEndOf(port1), { position });
  let lostCount = 0;
  const client = createPortClient(portMethods, { onLost: () => void lostCount++ });
  client.attach(windowEndOf(port2));
  const pending = client.call('Counts/get', {});
  await until(() => client.position().dbEpoch === 'e1', 'hello');
  served.close();
  await assert.rejects(pending, { type: 'unavailable' });
  assert.equal(lostCount, 1);
  assert.equal(client.connected(), false);
});

test('a window may not flood its port: at most MAX_IN_FLIGHT open calls, arguments at most MAX_ARGS_BYTES', async t => {
  const { port1, port2 } = new MessageChannel();
  t.after(() => {
    port1.close();
    port2.close();
  });
  serveWindowPort(hangingSession, engineEndOf(port1), { position });
  const replies: PortMessage[] = [];
  port2.on('message', message => replies.push(message));
  for (let id = 1; id <= MAX_IN_FLIGHT + 1; id++)
    port2.postMessage({ v: 1, id, method: 'Counts/get', args: {} });
  await until(() => replies.length === 2, 'the hello and one refusal');
  const refused = replies[1];
  assert.equal(refused.kind === 'reply' && refused.id, MAX_IN_FLIGHT + 1);
  assert.equal(refused.kind === 'reply' && !refused.ok && refused.error.type, 'unavailable');

  const fresh = new MessageChannel();
  t.after(() => {
    fresh.port1.close();
    fresh.port2.close();
  });
  const engine = fakeSession();
  serveWindowPort(() => engine.session, engineEndOf(fresh.port1), { position });
  const html = 'x'.repeat(MAX_ARGS_BYTES);
  // A page past preload posts the raw envelope: the engine side refuses it.
  const raw: PortMessage[] = [];
  fresh.port2.on('message', message => raw.push(message));
  fresh.port2.postMessage({
    v: 1,
    id: 1,
    method: 'Draft/set',
    args: { opId: 'o', fields: { html } },
  });
  await until(() => raw.length === 2, 'the hello and the refusal');
  assert.equal(raw[1].kind === 'reply' && !raw[1].ok && raw[1].error.type, 'tooLarge');
  assert.deepEqual(engine.calls, [], 'the oversized call never reached the engine');
  // An upload route carries its bytes (Blob/put, 25 MB at most).
  const bytes = new Uint8Array(MAX_ARGS_BYTES + 1);
  fresh.port2.postMessage({ v: 1, id: 2, method: 'Blob/put', args: { bytes, mime: 'audio/webm' } });
  // (The fake engine echoes the bytes back, a reply too large for a non-blob route: only the arrival matters here.)
  await until(() => raw.length === 3, 'the upload’s answer');
  assert.deepEqual(engine.calls, ['Blob/put']);
});

/** A session whose calls stay open until the test answers them, oldest first. */
function heldSession() {
  const open: (() => void)[] = [];
  const session: EngineSession = {
    call: () => new Promise(resolve => open.push(() => resolve({}))),
    subscribe: () => () => undefined,
    close: () => undefined,
  };
  return { session, open };
}

/** A served port whose raw envelopes the test posts itself, as a page past preload would. */
function rawPort(t: TestContext, session: EngineSession) {
  const { port1, port2 } = new MessageChannel();
  t.after(() => {
    port1.close();
    port2.close();
  });
  serveWindowPort(() => session, engineEndOf(port1), { position });
  const replies: PortMessage[] = [];
  port2.on('message', message => replies.push(message));
  let id = 0;
  const post = (method: string, args: unknown) =>
    port2.postMessage({ v: 1, id: ++id, method, args });
  const outcome = (n: number) => {
    const reply = replies.find(message => message.kind === 'reply' && message.id === n);
    if (!reply || reply.kind !== 'reply') return undefined;
    return reply.ok ? 'ok' : reply.error.type;
  };
  return { post, outcome };
}

test('a window may have at most MAX_IN_FLIGHT_BYTES of arguments open on its port; a reply releases them', async t => {
  const held = heldSession();
  const a = rawPort(t, held.session);
  const mime = 'audio/webm';
  const envelope = messageBytes({ bytes: 0, mime });
  const chunk = 24 * 1024 * 1024;
  const source = new Uint8Array(chunk);
  a.post('Blob/put', { bytes: source, mime });
  a.post('Blob/put', { bytes: source, mime });
  // The third fills the budget exactly.
  const rest = MAX_IN_FLIGHT_BYTES - 2 * (chunk + envelope) - envelope;
  a.post('Blob/put', { bytes: new Uint8Array(rest), mime });
  await until(() => held.open.length === 3, 'three uploads up to the budget to reach the engine');
  // Any more arguments are over it.
  a.post('Counts/get', {});
  await until(() => a.outcome(4) !== undefined, 'the refusal');
  assert.equal(a.outcome(4), 'unavailable');
  assert.equal(held.open.length, 3, 'the refused call never reached the engine');

  // Per port: another window's port has its own budget.
  const b = rawPort(t, held.session);
  b.post('Blob/put', { bytes: source, mime });
  b.post('Blob/put', { bytes: source, mime });
  await until(() => held.open.length === 5, 'the other port’s uploads');

  // A reply releases its bytes.
  held.open[0]();
  await until(() => a.outcome(1) === 'ok', 'the first upload’s reply');
  a.post('Blob/put', { bytes: source, mime });
  await until(() => held.open.length === 6, 'an upload after the release');
  assert.equal(a.outcome(5), undefined, 'still open, not refused');
});

test('preload refuses oversized arguments before they leave the window', async () => {
  const client = createPortClient();
  const posted: string[] = [];
  let deliver: (data: unknown) => void = () => undefined;
  client.attach({
    post: message => void posted.push(message.method),
    onMessage: handler => void (deliver = handler),
    close: () => undefined,
  });
  deliver({ kind: 'hello', dbEpoch: 'e1', seq: 1 });
  const html = 'x'.repeat(MAX_ARGS_BYTES);
  await assert.rejects(client.call('Draft/set', { opId: 'o', fields: { html } }), {
    type: 'tooLarge',
  });
  const bytes = new Uint8Array(MAX_BLOB_MESSAGE_BYTES);
  await assert.rejects(client.call('Blob/put', { bytes, mime: 'audio/webm' }, [bytes.buffer]), {
    type: 'tooLarge',
  });
  assert.equal(bytes.byteLength, MAX_BLOB_MESSAGE_BYTES, 'the refused buffer did not move');
  assert.deepEqual(posted, [], 'nothing oversized was posted on the port');
  // An upload under its cap still leaves.
  void client.call('Blob/put', { bytes: new Uint8Array(MAX_ARGS_BYTES + 1), mime: 'audio/webm' });
  assert.deepEqual(posted, ['Blob/put']);
});

test('port hijack: connect refuses a window whose main frame no longer shows the app', async t => {
  const host = createPortHost(() => fakeSession().session, { position });
  const ports = portTracker(t);
  const broker = createPortBroker({ channel: ports.channel, link: () => directLink(host) });
  const one = fakeWindow(1);
  one.state.url = 'https://evil.example/';
  assert.throws(() => broker.connect(one.win), /Untrusted application window/);
  assert.equal(one.state.deliveries, 0);
  assert.deepEqual(broker.holders(), []);
  assert.deepEqual(host.windows(), []);
});

test('port hijack: an engine restart re-issues no port to a window that no longer shows the app', async t => {
  const host = createPortHost(() => fakeSession().session, { position });
  const ports = portTracker(t);
  const broker = createPortBroker({ channel: ports.channel, link: () => directLink(host) });
  const one = fakeWindow(1);
  const two = fakeWindow(2);
  broker.connect(one.win);
  broker.connect(two.win);
  one.state.url = 'https://evil.example/';
  broker.reissue();
  assert.equal(one.state.deliveries, 1, 'the untrusted window got no new port');
  assert.equal(two.state.deliveries, 2, 'the trusted window did');
  assert.deepEqual(broker.holders(), [2]);
});

test('a window may ask for a port CONNECT_LIMIT.count times in CONNECT_LIMIT.windowMs: a loop of asks is refused, and a reload later is not', async t => {
  const engine = fakeSession();
  const host = createPortHost(() => engine.session, { position });
  const ports = portTracker(t);
  const link = directLink(host);
  let now = 1_000;
  const broker = createPortBroker({ channel: ports.channel, link: () => link, now: () => now });
  const one = fakeWindow(1);
  const other = fakeWindow(2);
  for (let i = 0; i < CONNECT_LIMIT.count; i++) {
    broker.connect(one.win);
    now += 100;
  }
  assert.throws(() => broker.connect(one.win), /./, 'the next ask is refused');
  assert.equal(one.state.deliveries, CONNECT_LIMIT.count, 'and issues no new port');
  broker.connect(other.win);
  assert.equal(other.state.deliveries, 1, 'another window has its own allowance');
  now += CONNECT_LIMIT.windowMs;
  broker.connect(one.win);
  assert.equal(
    one.state.deliveries,
    CONNECT_LIMIT.count + 1,
    'after the window passes it may ask again',
  );
});
