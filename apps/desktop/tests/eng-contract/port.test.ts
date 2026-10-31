import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageChannel } from 'node:worker_threads';
import type { Frame } from '@aplos/contract';
import type { EngineSession } from '@aplos/contract/client';
import { hostMethods, secretMethods } from '@aplos/contract/allowlists';
import {
  createPortBroker,
  createPortClient,
  createPortHost,
  portMethods,
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
    42,
  ])
    assert.equal(signInURL(url), undefined, String(url));
});
