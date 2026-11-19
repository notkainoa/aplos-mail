// A sign-in's cancel and deadline reach the host's flow end to end: ConnectSessions -> the real ActorHost ->
// the provider factory's ConnectRequest.signal and ConnectContext.signal (prov-gov wiring, #78 condition e).
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Frame } from '@aplos/contract';
import { ContractError } from '@aplos/contract/contract-error';
import type { ConnectContext, ConnectRequest, ConnectResult, ProviderFactory } from '../src/ports';
import type { StorePort } from '../src/store';
import {
  ConnectSessions,
  SIGN_IN_DEADLINE_MS,
  type ConnectFlow,
} from '../src/sync/connect-sessions';
import { Governor } from '../src/sync/governor';
import { ActorHost } from '../src/sync/host';
import {
  FakeClock,
  FakeDeadlines,
  connectResult,
  deferred,
  fakeLogger,
  portClock,
  until,
} from './sync-actor-helpers';

/** A store with no account rows: every sign-in here is a first-time connect. */
const emptyStore = {
  commit() {},
  read: (fn: (q: unknown) => unknown) => fn({ get: () => undefined }),
};

interface Call {
  req: ConnectRequest;
  ctx: ConnectContext;
  answer: ReturnType<typeof deferred<ConnectResult>>;
}

/** A factory whose connect waits for the test and ignores the abort (a flow still winding down). */
function slowFactory() {
  const calls: Call[] = [];
  const discarded: string[] = [];
  const factory: ProviderFactory = {
    kind: 'google',
    connect: (req, ctx) => {
      const answer = deferred<ConnectResult>();
      calls.push({ req, ctx, answer });
      return answer.promise;
    },
    budgets: () => [],
    open: () => assert.fail('no adapter here'),
    discardCredential: async ref => void discarded.push(ref),
  };
  return { factory, calls, discarded };
}

function rig() {
  const clock = new FakeClock({ auto: false });
  const { factory, calls, discarded } = slowFactory();
  const host = new ActorHost({
    store: emptyStore as unknown as StorePort,
    governor: new Governor({ clock, role: 'secondary', random: () => 0 }),
    providers: [factory],
    tokens: { cached: () => undefined, refresh: async () => ({ token: 'x', expiresAt: 0 }) },
    clock: portClock(clock),
    log: fakeLogger(),
    deadlines: new FakeDeadlines(),
    deviceId: 'device-a',
    env: () => ({ now: 0, focused: false, windowVisible: false, onBattery: false }),
  });
  const deadlines = new FakeDeadlines();
  const frames: Frame[] = [];
  const now = { t: 1_000 };
  let n = 0;
  const sessions = new ConnectSessions({
    accounts: host,
    frames: { emit: (f: Frame) => void frames.push(f), changed() {}, reset() {} } as never,
    randomBytes: len => new Uint8Array(len).fill(++n),
    clock: { now: () => now.t },
    deadlines,
  });
  const accepted: ConnectResult[] = [];
  const flow = (accountId = 'a-new'): ConnectFlow => ({
    mode: 'new',
    accountId,
    key: 'new:owner@example.test',
    kind: 'google',
    request: { mode: 'new', address: 'owner@example.test' },
    accept: result => void accepted.push(result),
  });
  const states = () => frames.map(f => f.frame === 'connect' && f.state);
  return { sessions, calls, discarded, deadlines, now, flow, accepted, states };
}

/** Whether a new sign-in for the same account can start (the first one freed its keys). */
function beginWorks(r: ReturnType<typeof rig>): boolean {
  try {
    r.sessions.begin(r.flow());
    return true;
  } catch {
    return false;
  }
}

/** A flow whose request carries the caller's own abort signal. */
function flowWithOwnSignal(r: ReturnType<typeof rig>, own: AbortController): ConnectFlow {
  const flow = r.flow();
  flow.request = { ...flow.request, signal: own.signal };
  return flow;
}

test('Account/cancelConnect aborts the signal the provider factory sees, on the request and the context', async () => {
  const r = rig();
  const { connectId } = r.sessions.begin(r.flow());
  await until(() => r.calls.length === 1, 'the host connect');
  const { req, ctx } = r.calls[0];
  assert.ok(req.signal, 'ConnectRequest.signal reaches the factory');
  assert.equal(req.signal.aborted, false);
  assert.equal(r.sessions.cancel(connectId), true);
  assert.equal(req.signal.aborted, true);
  assert.equal(ctx.signal.aborted, true);
  r.calls[0].answer.reject(new Error('cancelled'));
  await until(() => r.states().includes('cancelled'), 'the cancelled frame');
});

test('the 10-minute deadline aborts the factory’s signal', async () => {
  const r = rig();
  r.sessions.begin(r.flow());
  await until(() => r.calls.length === 1, 'the host connect');
  r.now.t += SIGN_IN_DEADLINE_MS;
  await r.deadlines.sources.get('connect')!.fire(r.now.t);
  assert.equal(r.calls[0].ctx.signal.aborted, true);
  assert.equal(r.calls[0].req.signal?.aborted, true);
  assert.deepEqual(r.states(), ['waiting', 'failed']);
});

test('a result that arrives after the cancel is discarded by the host and never accepted', async () => {
  const r = rig();
  const { connectId } = r.sessions.begin(r.flow());
  await until(() => r.calls.length === 1, 'the host connect');
  r.sessions.cancel(connectId);
  r.calls[0].answer.resolve(connectResult({ credentialRef: 'ref-late' }));
  await until(() => r.discarded.length === 1, 'discardLate');
  assert.deepEqual(r.discarded, ['ref-late']);
  assert.equal(r.accepted.length, 0);
});

test('a cancelled sign-in keeps the account key until the host flow has settled', async () => {
  const r = rig();
  const { connectId } = r.sessions.begin(r.flow());
  await until(() => r.calls.length === 1, 'the host connect');
  r.sessions.cancel(connectId);
  assert.throws(
    () => r.sessions.begin(r.flow()),
    (e: unknown) => e instanceof ContractError && e.body.type === 'conflict',
    'a second flow cannot run beside the one winding down',
  );
  r.calls[0].answer.reject(new Error('cancelled'));
  await until(() => beginWorks(r), 'the key freed');
});

test('a signal the request already carries stays in force next to the session’s own', async () => {
  const r = rig();
  const own = new AbortController();
  r.sessions.begin(flowWithOwnSignal(r, own));
  await until(() => r.calls.length === 1, 'the host connect');
  assert.equal(r.calls[0].req.signal?.aborted, false);
  own.abort();
  assert.equal(r.calls[0].req.signal?.aborted, true, 'the caller’s abort reaches the host flow');
  r.calls[0].answer.reject(new Error('aborted'));
  await until(() => beginWorks(r), 'the key freed');
});

test('aborting only the request’s own signal ends the sign-in cancelled, not failed', async () => {
  const r = rig();
  const own = new AbortController();
  r.sessions.begin(flowWithOwnSignal(r, own));
  await until(() => r.calls.length === 1, 'the host connect');
  own.abort();
  assert.equal(r.calls[0].ctx.signal.aborted, true, 'the host flow is aborted');
  assert.equal(r.calls[0].req.signal?.aborted, true);
  assert.deepEqual(r.states(), ['waiting', 'cancelled']);
  assert.equal(beginWorks(r), false, 'the key waits for the host flow to settle');
  r.calls[0].answer.reject(new Error('aborted'));
  await until(() => beginWorks(r), 'the key freed');
  assert.deepEqual(r.states().slice(0, 2), ['waiting', 'cancelled'], 'never failed');
  assert.equal(r.states().includes('failed'), false);
});

test('a request signal aborted before the sign-in runs cancels it without calling the host', async () => {
  const r = rig();
  const own = new AbortController();
  r.sessions.begin(flowWithOwnSignal(r, own));
  own.abort();
  await until(() => r.states().length === 1, 'the cancelled frame');
  assert.deepEqual(r.states(), ['cancelled']);
  assert.equal(r.calls.length, 0);
  assert.equal(beginWorks(r), true, 'the key is free at once');
});
