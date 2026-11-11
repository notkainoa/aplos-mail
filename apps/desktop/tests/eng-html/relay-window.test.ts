import test from 'node:test';
import assert from 'node:assert/strict';
import type { EngineSession } from '@aplos/contract/client';
import { notFound } from '@aplos/mail-html/frame';
import {
  controlMethods,
  createPortHost,
  hostServeArgs,
  type EnginePortEnd,
  type FromUtility,
  type PortMessage,
} from '../../src/host/transports/port';
import { runEngineUtility } from '../../src/main/engine-utility';
import type { ComposedHost } from '../../src/host/compose';
import {
  IDS,
  mailWorld,
  settle,
  tokenIn,
  type World,
} from '../../../../packages/engine/tests/mail/harness';

// html-5, the utility side: main sends the Electron window id it stamped, and the utility's port host swaps it for that
// window's engine connection id before `Mail/serve` runs. Unknown, detached or malformed is `''` (the engine's 404).

const position = () => ({ dbEpoch: 'e1', seq: 0 });

/** The engine's end of one window's channel, driven by the test. */
function fakeEnd() {
  const sent: PortMessage[] = [];
  const closers: (() => void)[] = [];
  let receive: ((data: unknown) => void) | undefined;
  let closed = false;
  const end: EnginePortEnd = {
    post: message => void sent.push(message),
    onMessage: handler => void (receive = handler),
    onClose: handler => void closers.push(handler),
    close: () => void (closed = true),
  };
  return {
    end,
    sent,
    call: (id: number, method: string, args: unknown) => receive?.({ v: 1, id, method, args }),
    goAway: () => closers.forEach(handler => handler()),
    isClosed: () => closed,
  };
}

function fakeSession(connectionId?: string) {
  let closed = false;
  const session = {
    ...(connectionId === undefined ? {} : { connectionId }),
    call: async () => ({}),
    subscribe: () => () => undefined,
    close: () => void (closed = true),
  } as EngineSession;
  return { session, isClosed: () => closed };
}

test('Mail/serve is a control method; the utility translates it and nothing else', () => {
  assert.ok(controlMethods.has('Mail/serve'));
});

test('hostServeArgs: a known window becomes its connection id; anything else is empty, never main’s value', () => {
  const connectionOf = (id: number) => (id === 3 ? 'c7' : undefined);
  const args = (windowId: unknown) =>
    hostServeArgs({ token: 't', path: 'p', windowId }, connectionOf);
  assert.deepEqual(args(3), { token: 't', path: 'p', windowId: 'c7' });
  assert.deepEqual(args('3'), { token: 't', path: 'p', windowId: 'c7' });
  for (const windowId of [
    4,
    '4',
    'c7',
    'c1',
    '',
    '03',
    '3.0',
    3.5,
    -3,
    0,
    null,
    undefined,
    [3],
    { id: 3 },
    '3 ',
  ]) {
    assert.equal(args(windowId).windowId, '', JSON.stringify(windowId) ?? 'undefined');
  }
  assert.deepEqual(hostServeArgs(undefined, connectionOf), {
    token: undefined,
    path: undefined,
    windowId: '',
  });
  const extra = hostServeArgs({ token: 't', path: 'p', windowId: 3, caller: 'x' }, connectionOf);
  assert.deepEqual(Object.keys(extra).sort(), ['path', 'token', 'windowId']);
});

test('the port host knows each attached window’s connection, and forgets it on detach or when the port goes away', () => {
  const sessions = [fakeSession('c11'), fakeSession('c12'), fakeSession('c13'), fakeSession()];
  let next = 0;
  const host = createPortHost(() => sessions[next++].session, { position });
  const one = fakeEnd();
  const two = fakeEnd();
  host.attach(1, one.end);
  host.attach(2, two.end);
  assert.equal(host.connectionOf(1), 'c11');
  assert.equal(host.connectionOf(2), 'c12');
  assert.equal(host.connectionOf(3), undefined);

  host.detach(1);
  assert.equal(host.connectionOf(1), undefined);
  assert.ok(
    sessions[0].isClosed(),
    'detach closes the window’s engine session (which releases its tokens)',
  );
  assert.ok(one.isClosed());

  two.goAway();
  assert.equal(host.connectionOf(2), undefined);
  assert.ok(sessions[1].isClosed(), 'the port going away closes the session too');

  // Re-attaching gives a new connection: an old token never follows a window into its next document.
  host.attach(2, fakeEnd().end);
  assert.equal(host.connectionOf(2), 'c13');
  host.attach(2, fakeEnd().end);
  assert.equal(host.connectionOf(2), undefined, 'a session that names no connection id gives none');
  assert.ok(sessions[2].isClosed(), 'a second attach replaced and closed the first');
});

async function withWorld(fn: (w: World) => Promise<void>) {
  const world = await mailWorld();
  try {
    await fn(world);
  } finally {
    await world.cleanup();
  }
}

/** Mail/frame down a window's own port, as the renderer calls it. */
async function frameThrough(port: ReturnType<typeof fakeEnd>, id: number): Promise<string> {
  port.call(id, 'Mail/frame', { messageId: IDS.rich, imagePolicy: 'block' });
  for (let i = 0; i < 200; i++) {
    const reply = port.sent.find(m => m.kind === 'reply' && m.id === id);
    if (reply && reply.kind === 'reply') {
      assert.ok(reply.ok, JSON.stringify(reply));
      return (reply.result as { url: string }).url;
    }
    await settle(1);
  }
  throw new Error('no Mail/frame reply');
}

test('over the real engine: a token serves only to the window that made it, and detach releases it', () =>
  withWorld(async w => {
    const host = createPortHost(() => w.engine.connect(), { position });
    const one = fakeEnd();
    const two = fakeEnd();
    host.attach(1, one.end);
    host.attach(2, two.end);
    const url = await frameThrough(one, 1);
    const serve = (windowId: unknown, path = '') =>
      w.main.call(
        'Mail/serve',
        hostServeArgs({ token: tokenIn(url), path, windowId }, id => host.connectionOf(id)),
      ) as Promise<{ status: number }>;

    assert.deepEqual(await serve(2), notFound(), 'window 2 cannot fetch window 1’s document');
    assert.deepEqual(await serve(9), notFound(), 'an unknown window gets the 404');
    assert.deepEqual(
      await serve(host.connectionOf(1)),
      notFound(),
      'a connection id from main is not passed through',
    );
    assert.equal((await serve(1)).status, 200, 'window 1 still gets it: nothing was spent');
    assert.deepEqual(await serve(2, 'cid/0'), notFound(), 'nor window 1’s sub-resources');

    const tokens = w.engine.services.mailFrames.tokens;
    const connection = host.connectionOf(1)!;
    await frameThrough(one, 2);
    assert.ok(tokens.liveCount(connection) >= 1);
    host.detach(1);
    assert.equal(
      tokens.liveCount(connection),
      0,
      'detach reached onConnectionClose: the window’s tokens are gone',
    );
    assert.deepEqual(await serve(1, 'cid/0'), notFound());
  }));

test('the utility rewrites Mail/serve’s windowId from its port host before the engine sees it', async () => {
  const toMain: FromUtility[] = [];
  const asked: unknown[] = [];
  let send: ((data: unknown, ports: readonly unknown[]) => void) | undefined;
  let counter = 0;
  const window = () => ({ ...fakeSession(`w${++counter}`).session });
  const control = {
    call: async (method: string, args: unknown) => {
      asked.push({ method, args });
      return { ok: true };
    },
    subscribe: () => () => undefined,
    close: () => undefined,
  };
  const engine = {
    services: { store: { dbEpoch: 'e1', seq: () => 0 } },
    connect: (caller?: { kind: string }) => (caller?.kind === 'host' ? control : window()),
  };
  runEngineUtility(
    { post: message => void toMain.push(message), onMessage: handler => void (send = handler) },
    {
      options: async () => ({}) as never,
      compose: async () => ({ engine, close: async () => undefined }) as unknown as ComposedHost,
      wrapPort: () => fakeEnd().end,
      exit: () => undefined,
    },
  );
  send!({ kind: 'init', init: { dataDir: '/nowhere', appVersion: '0' } }, []);
  await settle();
  send!({ kind: 'attach', windowId: 5 }, [{}]);
  const call = (id: number, method: string, args: unknown) =>
    send!({ kind: 'call', id, method, args }, []);
  call(1, 'Mail/serve', { token: 't', path: '', windowId: '5' });
  call(2, 'Mail/serve', { token: 't', path: '', windowId: '6' });
  call(3, 'Mail/serve', { token: 't', path: '', windowId: 'w1' });
  call(4, 'Counts/get', { windowId: '5' });
  send!({ kind: 'detach', windowId: 5 }, []);
  call(5, 'Mail/serve', { token: 't', path: '', windowId: 5 });
  await settle();
  // The utility also seeds main's theme once after `ready` (a Settings/get on the control session, #453): not a relayed call.
  const relayed = asked.filter(entry => (entry as { method: string }).method !== 'Settings/get');
  assert.deepEqual(relayed, [
    { method: 'Mail/serve', args: { token: 't', path: '', windowId: 'w1' } },
    { method: 'Mail/serve', args: { token: 't', path: '', windowId: '' } },
    { method: 'Mail/serve', args: { token: 't', path: '', windowId: '' } },
    { method: 'Counts/get', args: { windowId: '5' } },
    { method: 'Mail/serve', args: { token: 't', path: '', windowId: '' } },
  ]);
  assert.equal(toMain.filter(m => m.kind === 'reply').length, 5);
});
