/**
 * `bridge.ts` against a fake `window.aplosEngine`: the `EngineSession` surface, the `Frame` validation, the error
 * normalisation and the close semantics of the trust boundary. Run:
 * `cd apps/desktop && npx tsx --test src/renderer/bridge.test.ts`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ContractError, Frame, type ErrorBody } from '@aplos/contract';
import type { EngineSession } from '@aplos/contract/client';
import { UNREACHABLE_MESSAGE } from './data/client';
import { createEngineBridge, hasEngineBridge } from './bridge';

type Upstream = (frame: unknown) => void;
type CallImpl = (method: unknown, args: unknown, transfer: unknown) => unknown;

/** A fake `window.aplosEngine` with its members and every use of them recorded. */
function fakeBridge(call?: CallImpl, subscribe?: (listener: Upstream) => unknown) {
  const calls: { method: unknown; args: unknown; transfer: unknown }[] = [];
  const upstream = new Set<Upstream>();
  const stats = { unbinds: 0, positionCalls: 0, otherCalls: 0 };
  const api = {
    call(method: unknown, args?: unknown, transfer?: unknown) {
      calls.push({ method, args, transfer });
      return call ? call(method, args, transfer) : Promise.resolve({ ok: true });
    },
    subscribe(listener: Upstream) {
      upstream.add(listener);
      if (subscribe) return subscribe(listener);
      return () => {
        stats.unbinds++;
        upstream.delete(listener);
      };
    },
    position() {
      stats.positionCalls++;
      return { dbEpoch: 'e1', seq: 0 };
    },
  };
  return {
    api,
    host: { aplosEngine: api },
    calls,
    stats,
    upstream,
    emit(frame: unknown) {
      for (const listener of [...upstream]) listener(frame);
    },
  };
}

const sessionOf = (fake: ReturnType<typeof fakeBridge>): EngineSession => {
  const session = createEngineBridge(fake.host);
  assert.ok(session);
  return session;
};

/** A rejection on `session.call` as a `ContractError`. */
async function rejection(session: EngineSession): Promise<ContractError> {
  return session.call('Session/get', {}).then(
    () => assert.fail('the call resolved'),
    error => {
      assert.ok(error instanceof ContractError, `not a ContractError: ${String(error)}`);
      return error;
    },
  );
}

const VALID_STATE = { frame: 'state', dbEpoch: 'e1', seq: 1, types: { Thread: 2, Counts: 1 } };
const VALID_RESET = { frame: 'reset', dbEpoch: 'e1', seq: 2, reason: 'restore' };
const VALID_DESKTOP = { frame: 'desktop', event: { type: 'shown' } };

// ---- the bridge detector --------------------------------------------------------------------------------------

test('hasEngineBridge is true only for an object with function call and subscribe', () => {
  const fake = fakeBridge();
  assert.equal(hasEngineBridge(fake.host), true);
  assert.equal(hasEngineBridge({}), false);
  assert.equal(hasEngineBridge(undefined), false);
  assert.equal(hasEngineBridge(null), false);
  assert.equal(hasEngineBridge(42), false);
  assert.equal(hasEngineBridge({ aplosEngine: undefined }), false);
  assert.equal(hasEngineBridge({ aplosEngine: null }), false);
  assert.equal(hasEngineBridge({ aplosEngine: 'x' }), false);
  assert.equal(hasEngineBridge({ aplosEngine: { subscribe() {} } }), false);
  assert.equal(hasEngineBridge({ aplosEngine: { call() {} } }), false);
  assert.equal(hasEngineBridge({ aplosEngine: { call: 'yes', subscribe() {} } }), false);
  assert.equal(hasEngineBridge({ aplosEngine: { call() {}, subscribe: 'yes' } }), false);
});

test('a host or member getter that throws reads as no bridge, never a throw', () => {
  const hostileHost = Object.defineProperty({}, 'aplosEngine', {
    enumerable: true,
    get() {
      throw new Error('hostile');
    },
  });
  assert.equal(hasEngineBridge(hostileHost), false);
  assert.equal(createEngineBridge(hostileHost), null);
  const hostileMember = {
    aplosEngine: Object.defineProperty({ subscribe() {} }, 'call', {
      enumerable: true,
      get() {
        throw new Error('hostile');
      },
    }),
  };
  assert.equal(hasEngineBridge(hostileMember), false);
  assert.equal(createEngineBridge(hostileMember), null);
});

test('createEngineBridge returns a session of exactly call, subscribe and close, never the bridge itself', () => {
  const session = sessionOf(fakeBridge());
  assert.deepEqual(Object.keys(session).sort(), ['call', 'close', 'subscribe']);
  assert.equal(createEngineBridge({}), null);
  assert.equal(createEngineBridge({ aplosEngine: { call: 1, subscribe: 2 } }), null);
});

// ---- calls ----------------------------------------------------------------------------------------------------

test('call forwards method, args and a whole ArrayBuffer transfer list, and resolves with the result', async () => {
  const fake = fakeBridge(() => Promise.resolve({ answer: 1 }));
  const session = sessionOf(fake);
  const buffers = [new ArrayBuffer(8), new ArrayBuffer(4)];
  const result = await session.call('Thread/get', { ids: ['t1'] }, { transfer: buffers });
  assert.deepEqual(result, { answer: 1 });
  assert.deepEqual(fake.calls, [
    { method: 'Thread/get', args: { ids: ['t1'] }, transfer: buffers },
  ]);
  assert.equal(fake.calls[0]!.transfer, buffers);
});

test('a transfer option that is not an ArrayBuffer array is not passed through', async () => {
  const fake = fakeBridge();
  const session = sessionOf(fake);
  await session.call('Blob/put', {}, { transfer: 'x' as unknown as ArrayBuffer[] });
  await session.call(
    'Blob/put',
    {},
    {
      transfer: [new ArrayBuffer(1), 'x' as unknown as ArrayBuffer],
    },
  );
  await session.call('Blob/put', {});
  assert.deepEqual(
    fake.calls.map(call => call.transfer),
    [undefined, undefined, undefined],
  );
});

test('a contract error body becomes a ContractError of the same type, message and reasonCode', async () => {
  const fake = fakeBridge(() =>
    Promise.reject({ type: 'paused', message: 'This account is paused.', reasonCode: 'auth' }),
  );
  const error = await rejection(sessionOf(fake));
  assert.equal(error.body.type, 'paused');
  assert.equal(error.body.message, 'This account is paused.');
  assert.equal(error.body.reasonCode, 'auth');
});

test('a cloned ContractError (its body kept, its own fields partial) still yields the body', async () => {
  // contextBridge clones errors: a ContractError can arrive with `type` and `body` but no string `message` of its own.
  const fake = fakeBridge(() =>
    Promise.reject({
      name: 'ContractError',
      type: 'unavailable',
      body: { type: 'needsReauth', message: 'Sign in again.' },
    }),
  );
  const error = await rejection(sessionOf(fake));
  assert.equal(error.body.type, 'needsReauth');
  assert.equal(error.body.message, 'Sign in again.');
});

test('garbage rejections become the generic unavailable error and never echo foreign text', async () => {
  for (const reason of [
    'boom',
    null,
    undefined,
    42,
    { foo: 1 },
    { type: 7, message: 'x' },
    { type: 'validation' },
    { type: 'internal', message: 99 },
    new Error('boom'),
  ]) {
    const fake = fakeBridge(() => Promise.reject(reason));
    const error = await rejection(sessionOf(fake));
    assert.equal(error.body.type, 'unavailable', `reason: ${String(reason)}`);
    assert.equal(error.body.message, UNREACHABLE_MESSAGE);
  }
});

test('a call that throws synchronously rejects the same way, and a non-promise return resolves', async () => {
  const thrown = fakeBridge(() => {
    throw new Error('sync');
  });
  const error = await rejection(sessionOf(thrown));
  assert.equal(error.body.type, 'unavailable');
  const plain = fakeBridge(() => 42);
  assert.equal(await sessionOf(plain).call('Counts/get', {}), 42);
});

test('an error message is carried only capped', async () => {
  const fake = fakeBridge(() =>
    Promise.reject({ type: 'internal', message: `ok ${'x'.repeat(5_000)}` }),
  );
  const error = await rejection(sessionOf(fake));
  assert.equal(error.body.type, 'internal');
  assert.ok(error.body.message.length <= 500);
  assert.ok(error.body.message.startsWith('ok '));
});

test('an error message is capped at 500 code points, never ending in a lone surrogate', async () => {
  const fake = fakeBridge(() =>
    Promise.reject({ type: 'internal', message: `${'x'.repeat(499)}💥tail` }),
  );
  const error = await rejection(sessionOf(fake));
  assert.equal(error.body.type, 'internal');
  assert.equal(error.body.message, `${'x'.repeat(499)}💥`);
  assert.equal(Array.from(error.body.message).length, 500);
});

test('a ContractError rejection keeps its body whole: reasonCode, resumeAt, path and retryAfterMs', async () => {
  const body: ErrorBody = {
    type: 'paused',
    message: 'This account is paused.',
    reasonCode: 'auth',
    resumeAt: 1_700_000_000_000,
    retryAfterMs: 60_000,
    path: ['patch', 'mail'],
  };
  const fake = fakeBridge(() => Promise.reject(new ContractError(body)));
  const error = await rejection(sessionOf(fake));
  assert.deepEqual(error.body, body);
});

test('a rejection whose body getter throws still yields a valid outer body', async () => {
  const hostile = Object.defineProperty(
    { type: 'paused', message: 'The outer body still parses.' },
    'body',
    {
      enumerable: true,
      get() {
        throw new Error('hostile body');
      },
    },
  );
  const fake = fakeBridge(() => Promise.reject(hostile));
  const error = await rejection(sessionOf(fake));
  assert.equal(error.body.type, 'paused');
  assert.equal(error.body.message, 'The outer body still parses.');
});

test('a throwing transfer getter never makes call throw synchronously: it rejects unavailable', async () => {
  const fake = fakeBridge(() => Promise.resolve({ ok: true }));
  const session = sessionOf(fake);
  const options = Object.defineProperty({}, 'transfer', {
    enumerable: true,
    get() {
      throw new Error('hostile transfer');
    },
  }) as { transfer?: ArrayBuffer[] };
  const error = await session.call('Blob/put', {}, options).then(
    () => assert.fail('the call resolved'),
    reason => reason,
  );
  assert.ok(error instanceof ContractError);
  assert.equal(error.body.type, 'unavailable');
  assert.equal(error.body.message, UNREACHABLE_MESSAGE);
  assert.equal(fake.calls.length, 0);
});

test('a revoked proxy in the transfer list never makes call throw synchronously', async () => {
  const fake = fakeBridge(() => Promise.resolve({ ok: true }));
  const session = sessionOf(fake);
  const { proxy, revoke } = Proxy.revocable(new ArrayBuffer(1), {});
  revoke();
  const error = await session.call('Blob/put', {}, { transfer: [proxy as ArrayBuffer] }).then(
    () => assert.fail('the call resolved'),
    reason => reason,
  );
  assert.ok(error instanceof ContractError);
  assert.equal(error.body.type, 'unavailable');
});

// ---- frames ---------------------------------------------------------------------------------------------------

test('subscribe delivers valid frames in order and drops invalid ones without reaching listeners', () => {
  const fake = fakeBridge();
  const session = sessionOf(fake);
  const received: unknown[] = [];
  session.subscribe(frame => received.push(frame));
  const hugeDelta = {
    frame: 'progress',
    dbEpoch: 'e1',
    seq: 3,
    runId: 'run-1',
    source: 'ask',
    kind: 'text',
    delta: 'x'.repeat(200_000),
  };
  for (const frame of [
    VALID_STATE,
    'garbage',
    null,
    42,
    { frame: 'bogus', dbEpoch: 'e1', seq: 1 },
    { frame: 'state', dbEpoch: 'e1', seq: 'x', types: {} },
    { frame: 'reset', dbEpoch: 'e1', reason: 'restore' },
    hugeDelta,
    VALID_RESET,
    VALID_DESKTOP,
  ])
    fake.emit(frame);
  assert.deepEqual(received, [VALID_STATE, VALID_RESET, VALID_DESKTOP]);
});

test('a valid frame arrives as the parsed frame: foreign extra keys are stripped', () => {
  const fake = fakeBridge();
  const session = sessionOf(fake);
  const received: Frame[] = [];
  session.subscribe(frame => received.push(frame));
  fake.emit({ ...VALID_RESET, junk: { nested: 'x' } });
  assert.equal(received.length, 1);
  assert.deepEqual(received[0], VALID_RESET);
});

test('a throwing listener does not stop the other listeners', () => {
  const fake = fakeBridge();
  const session = sessionOf(fake);
  const received: Frame[] = [];
  session.subscribe(() => {
    throw new Error('listener bug');
  });
  session.subscribe(frame => received.push(frame));
  session.subscribe(() => {
    throw new Error('listener bug');
  });
  fake.emit(VALID_STATE);
  assert.deepEqual(received, [VALID_STATE]);
});

test('unsubscribe stops delivery for that listener only, upstream stays until close', () => {
  const fake = fakeBridge();
  const session = sessionOf(fake);
  const a: Frame[] = [];
  const b: Frame[] = [];
  const offA = session.subscribe(frame => a.push(frame));
  session.subscribe(frame => b.push(frame));
  fake.emit(VALID_STATE);
  offA();
  fake.emit(VALID_RESET);
  assert.deepEqual(a, [VALID_STATE]);
  assert.deepEqual(b, [VALID_STATE, VALID_RESET]);
  assert.equal(fake.stats.unbinds, 0);
  session.close();
  assert.equal(fake.stats.unbinds, 1);
});

test('a listener that closes the session stops the remaining listeners of that frame', () => {
  const fake = fakeBridge();
  const session = sessionOf(fake);
  const received: Frame[] = [];
  session.subscribe(() => session.close());
  session.subscribe(frame => received.push(frame));
  fake.emit(VALID_STATE);
  assert.deepEqual(received, []);
});

test('a subscribe that throws after registering is never retried, so no frame is delivered twice', async () => {
  const upstreams: Upstream[] = [];
  let subscribes = 0;
  const api = {
    call: () => Promise.resolve({ answer: 2 }),
    subscribe: (listener: Upstream) => {
      subscribes++;
      upstreams.push(listener);
      throw new Error('refused after registering');
    },
  };
  const session = createEngineBridge({ aplosEngine: api });
  assert.ok(session);
  const received: Frame[] = [];
  session.subscribe(frame => received.push(frame));
  session.subscribe(frame => received.push(frame));
  assert.equal(subscribes, 1);
  for (const upstream of upstreams) upstream(VALID_STATE);
  assert.deepEqual(received, [VALID_STATE, VALID_STATE]);
  assert.deepEqual(await session.call('Counts/get', {}), { answer: 2 });
  session.close();
});

test('a thenable the foreign subscribe returns is chained and swallowed, never unhandled', async () => {
  let thenCalls = 0;
  const fake = fakeBridge(undefined, () => ({
    then(_resolve: unknown, reject: (reason: unknown) => void) {
      thenCalls++;
      reject(new Error('foreign subscribe'));
    },
  }));
  const session = sessionOf(fake);
  const received: Frame[] = [];
  session.subscribe(frame => received.push(frame));
  fake.emit(VALID_STATE);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(thenCalls, 1);
  assert.deepEqual(received, [VALID_STATE]);
});

test('a rejected promise the foreign subscribe returns is swallowed, and frames still flow', async () => {
  const fake = fakeBridge(undefined, () => Promise.reject(new Error('foreign subscribe')));
  const session = sessionOf(fake);
  const received: Frame[] = [];
  session.subscribe(frame => received.push(frame));
  fake.emit(VALID_STATE);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(received, [VALID_STATE]);
  session.close();
});

test('a thenable the foreign unsubscribe returns is chained and swallowed on close', async () => {
  let thenCalls = 0;
  const fake = fakeBridge(undefined, () => () => ({
    then(_resolve: unknown, reject: (reason: unknown) => void) {
      thenCalls++;
      reject(new Error('foreign unsubscribe'));
    },
  }));
  const session = sessionOf(fake);
  session.subscribe(() => {});
  session.close();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(thenCalls, 1);
});

// ---- close ----------------------------------------------------------------------------------------------------

test('close unsubscribes the upstream, later calls reject unavailable and subscribe is a no-op', async () => {
  const fake = fakeBridge();
  const session = sessionOf(fake);
  const received: Frame[] = [];
  session.subscribe(frame => received.push(frame));
  session.close();
  assert.equal(fake.stats.unbinds, 1);
  fake.emit(VALID_STATE);
  assert.deepEqual<Frame[]>(received, []);
  const error = await rejection(session);
  assert.equal(error.body.type, 'unavailable');
  const off = session.subscribe(frame => received.push(frame));
  assert.equal(typeof off, 'function');
  off();
  assert.equal(fake.upstream.size, 0);
  fake.emit(VALID_RESET);
  assert.deepEqual(received, []);
  assert.doesNotThrow(() => session.close());
  assert.equal(fake.stats.unbinds, 1);
});

test('close drops the bridge reference: position and the other members are never touched', () => {
  const fake = fakeBridge();
  const session = sessionOf(fake);
  const received: Frame[] = [];
  session.subscribe(frame => received.push(frame));
  fake.emit(VALID_STATE);
  session.close();
  assert.equal(fake.stats.positionCalls, 0);
  assert.deepEqual(received, [VALID_STATE]);
});

// ---- seeded fuzz -----------------------------------------------------------------------------------------------

/** A small deterministic PRNG (mulberry32), so a failure replays. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FRAME_POOL: readonly unknown[] = [
  { frame: 'state', dbEpoch: 'e1', seq: 1, types: { Thread: 2, Counts: 1 } },
  { frame: 'reset', dbEpoch: 'e1', seq: 2, reason: 'cannotCalculateChanges' },
  { frame: 'desktop', event: { type: 'engine', state: 'ready', at: 100 } },
  {
    frame: 'progress',
    dbEpoch: 'e1',
    seq: 3,
    runId: 'run-1',
    source: 'ask',
    kind: 'text',
    delta: 'hi',
  },
  { frame: 'connect', dbEpoch: 'e1', seq: 4, connectId: 'c-1', mode: 'new', state: 'waiting' },
  { frame: 'Draft/changed', dbEpoch: 'e1', seq: 5, draftId: 'd-1', revision: 2, conflict: false },
];

const GARBAGE: readonly unknown[] = [null, undefined, 0, 'x', [], {}, { frame: 'nope' }];

/** A pool frame with one field broken or bent, or raw garbage. */
function randomFrame(rand: () => number): unknown {
  const pick = <T>(list: readonly T[]) => list[Math.floor(rand() * list.length)]!;
  if (rand() < 0.2) return pick(GARBAGE);
  const frame = JSON.parse(JSON.stringify(pick(FRAME_POOL))) as Record<string, unknown>;
  switch (Math.floor(rand() * 8)) {
    case 0:
      frame.seq = 'x';
      break;
    case 1:
      frame.seq = -1;
      break;
    case 2:
      delete frame.dbEpoch;
      break;
    case 3:
      frame.dbEpoch = `e${'x'.repeat(200)}`;
      break;
    case 4:
      frame.extra = { junk: [1, 2, 3] };
      break;
    case 5:
      frame.delta = 'x'.repeat(150_000);
      break;
    case 6:
      frame.types = 'x';
      break;
    default:
      frame.seq = Math.floor(rand() * 100);
      break;
  }
  return frame;
}

test('a seeded fuzz of 500 frames never throws and delivers exactly the valid ones in order', () => {
  const rand = mulberry32(0xc0ffee);
  const frames = Array.from({ length: 500 }, () => randomFrame(rand));
  const fake = fakeBridge();
  const session = sessionOf(fake);
  const received: Frame[] = [];
  session.subscribe(frame => received.push(frame));
  assert.doesNotThrow(() => frames.forEach(frame => fake.emit(frame)));
  const expected = frames
    .map(frame => Frame.safeParse(frame))
    .filter(parsed => parsed.success)
    .map(parsed => parsed.data);
  assert.deepEqual(received, expected);
  assert.equal(fake.stats.positionCalls, 0);
});
