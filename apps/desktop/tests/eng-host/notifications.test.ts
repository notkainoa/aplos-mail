import test from 'node:test';
import assert from 'node:assert/strict';
import type { Frame, NotificationItem } from '@aplos/contract';
import {
  retryDelay,
  runNotificationLoop,
  type NotificationLoopSession,
  type RetryTimers,
} from '../../src/host/notifications';

const item = (n: number): NotificationItem => ({
  id: `mail:acct:m${n}`,
  kind: 'mail',
  accountId: 'acct',
  threadId: `acct:t${n}`,
  title: `Sender ${n}`,
  at: 1_000 + n,
});

const notifyFrame = (pending = 1): Frame =>
  ({ frame: 'host', event: { type: 'notify', pending } }) as Frame;

interface AckCall {
  ids: string[];
  state: string;
}

/** An engine that leases what it hands out (a claimed item is not offered again) and records every call. */
function fakeEngine(initial: NotificationItem[] = []) {
  const queue = [...initial];
  const listeners = new Set<(frame: Frame) => void>();
  const log: string[] = [];
  const acks: AckCall[] = [];
  const claims: unknown[] = [];
  const hooks = {
    claim: undefined as undefined | (() => Promise<unknown> | unknown),
    ack: undefined as undefined | ((call: AckCall) => Promise<unknown> | unknown),
  };
  const session: NotificationLoopSession = {
    async call(method, args) {
      log.push(method);
      if (method === 'Notification/claim') {
        claims.push(args);
        if (hooks.claim) return hooks.claim();
        const max = (args as { max: number }).max;
        return { items: queue.splice(0, max) };
      }
      if (method === 'Notification/ack') {
        const call = args as AckCall;
        if (hooks.ack) await hooks.ack(call);
        acks.push({ ids: [...call.ids], state: call.state });
        return { ok: true };
      }
      throw new Error(`unexpected ${method}`);
    },
    subscribe(listener) {
      log.push('subscribe');
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
  return {
    session,
    log,
    acks,
    claims,
    hooks,
    queue,
    emit: (frame: Frame) => listeners.forEach(l => l(frame)),
    listeners: () => listeners.size,
  };
}

/** Timers that only run when the test says so. */
function fakeTimers() {
  const pending = new Map<number, { run: () => void; ms: number }>();
  let next = 1;
  const timers: RetryTimers = {
    set: (run, ms) => {
      pending.set(next, { run, ms });
      return next++;
    },
    clear: handle => void pending.delete(handle as number),
  };
  return {
    timers,
    pending,
    fire() {
      const [id, timer] = [...pending][0]!;
      pending.delete(id);
      timer.run();
    },
  };
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise<void>(resolve => setImmediate(resolve));
};

const ackedIds = (acks: AckCall[], state: string) =>
  acks.filter(a => a.state === state).flatMap(a => a.ids);

test('it subscribes first, then claims once on connect', async () => {
  const e = fakeEngine([item(1)]);
  const posted: string[] = [];
  const stop = runNotificationLoop(e.session, i => (posted.push(i.id), 'posted'));
  await settle();
  assert.deepEqual(e.log.slice(0, 2), ['subscribe', 'Notification/claim']);
  assert.deepEqual(e.claims, [{ max: 50 }]);
  assert.deepEqual(posted, ['mail:acct:m1']);
  stop();
});

test('a notify event claims again', async () => {
  const e = fakeEngine();
  const posted: string[] = [];
  const stop = runNotificationLoop(e.session, i => (posted.push(i.id), 'posted'));
  await settle();
  e.queue.push(item(2));
  e.emit(notifyFrame());
  await settle();
  assert.deepEqual(posted, ['mail:acct:m2']);
  e.emit({ frame: 'host', event: { type: 'badge', count: 3 } } as Frame);
  await settle();
  assert.equal(e.claims.length, 2, 'other host events do not claim');
  stop();
});

test('it posts each item, then acks the posted and the dropped ids in one call per state', async () => {
  const e = fakeEngine([item(1), item(2), item(3)]);
  const stop = runNotificationLoop(e.session, i => (i.id.endsWith('m2') ? 'dropped' : 'posted'));
  await settle();
  assert.deepEqual(e.acks, [
    { ids: ['mail:acct:m1', 'mail:acct:m3'], state: 'posted' },
    { ids: ['mail:acct:m2'], state: 'dropped' },
  ]);
  stop();
});

test('it drains over 50 items and acks in chunks of at most 50', async () => {
  const e = fakeEngine(Array.from({ length: 120 }, (_, n) => item(n)));
  const posted: string[] = [];
  const stop = runNotificationLoop(e.session, i => (posted.push(i.id), 'posted'));
  await settle();
  assert.equal(posted.length, 120);
  assert.equal(e.claims.length, 3, '50 + 50 + 20, and the short batch ends the run');
  assert.ok(e.acks.every(a => a.ids.length <= 50));
  assert.equal(ackedIds(e.acks, 'posted').length, 120);
  stop();
});

test('an exactly full batch is followed by one more claim that finds nothing', async () => {
  const e = fakeEngine(Array.from({ length: 50 }, (_, n) => item(n)));
  const stop = runNotificationLoop(e.session, () => 'posted');
  await settle();
  assert.equal(e.claims.length, 2);
  stop();
});

test('a throwing post is not acked and nothing else is lost', async () => {
  const e = fakeEngine([item(1), item(2), item(3)]);
  const logs: string[] = [];
  const stop = runNotificationLoop(
    e.session,
    i => {
      if (i.id.endsWith('m2')) throw new Error('banner failed for Sender 2');
      return 'posted';
    },
    { log: message => logs.push(message) },
  );
  await settle();
  assert.deepEqual(ackedIds(e.acks, 'posted'), ['mail:acct:m1', 'mail:acct:m3']);
  assert.deepEqual(ackedIds(e.acks, 'dropped'), []);
  assert.ok(logs.length > 0);
  assert.ok(!logs.join(' ').includes('Sender 2'), 'the log carries no notification text');
  stop();
});

test('a post that rejects is not acked either', async () => {
  const e = fakeEngine([item(1)]);
  const stop = runNotificationLoop(e.session, async () => {
    throw new Error('x');
  });
  await settle();
  assert.deepEqual(e.acks, []);
  stop();
});

test('runs are serialised and notifies during a run schedule exactly one more run', async () => {
  const e = fakeEngine();
  let release!: () => void;
  const gate = new Promise<void>(resolve => (release = resolve));
  let first = true;
  e.hooks.claim = async () => {
    if (first) {
      first = false;
      await gate;
    }
    return { items: [] };
  };
  const stop = runNotificationLoop(e.session, () => 'posted');
  await settle();
  assert.equal(e.claims.length, 1, 'the first claim is in flight');
  e.emit(notifyFrame());
  e.emit(notifyFrame());
  e.emit(notifyFrame());
  await settle();
  assert.equal(e.claims.length, 1, 'no second run starts while one is running');
  release();
  await settle();
  assert.equal(e.claims.length, 2, 'three notifies during the run make exactly one more run');
  stop();
});

test('a failing claim is swallowed, does not spin, and the next notify tries again', async () => {
  const e = fakeEngine();
  let fail = true;
  e.hooks.claim = () => {
    if (fail) throw new Error('engine busy');
    return { items: [item(9)] };
  };
  const posted: string[] = [];
  const stop = runNotificationLoop(e.session, i => (posted.push(i.id), 'posted'));
  await settle();
  await settle();
  assert.equal(e.claims.length, 1, 'one attempt, no retry loop');
  fail = false;
  e.emit(notifyFrame());
  await settle();
  assert.equal(e.claims.length, 2);
  assert.deepEqual(posted, ['mail:acct:m9']);
  stop();
});

test('an id that was posted and acked is not posted again if it is offered again', async () => {
  const e = fakeEngine([item(1)]);
  const posted: string[] = [];
  const stop = runNotificationLoop(e.session, i => (posted.push(i.id), 'posted'));
  await settle();
  e.queue.push(item(1), item(2));
  e.emit(notifyFrame());
  await settle();
  assert.deepEqual(posted, ['mail:acct:m1', 'mail:acct:m2']);
  stop();
});

test('a posted item whose ack failed is acked again on the next run, never reposted', async () => {
  const e = fakeEngine([item(1)]);
  let failAck = true;
  e.hooks.ack = () => {
    if (failAck) throw new Error('ack lost');
  };
  const posted: string[] = [];
  const stop = runNotificationLoop(e.session, i => (posted.push(i.id), 'posted'));
  await settle();
  assert.deepEqual(posted, ['mail:acct:m1']);
  assert.deepEqual(e.acks, [], 'the first ack did not go through');
  failAck = false;
  e.queue.push(item(1));
  e.emit(notifyFrame());
  await settle();
  assert.deepEqual(posted, ['mail:acct:m1'], 'not reposted, even when the engine offers it again');
  const acked = ackedIds(e.acks, 'posted');
  assert.ok(acked.length >= 1 && acked.every(id => id === 'mail:acct:m1'));
  stop();
});

test('a failed ack is retried from the next run even when nothing new is claimed', async () => {
  const e = fakeEngine([item(1)]);
  let failAck = true;
  e.hooks.ack = () => {
    if (failAck) throw new Error('ack lost');
  };
  const stop = runNotificationLoop(e.session, () => 'posted');
  await settle();
  failAck = false;
  e.emit(notifyFrame(0));
  await settle();
  assert.deepEqual(ackedIds(e.acks, 'posted'), ['mail:acct:m1']);
  stop();
});

test('stop() unsubscribes and stops a run in flight', async () => {
  const e = fakeEngine([item(1), item(2)]);
  let release!: () => void;
  const gate = new Promise<void>(resolve => (release = resolve));
  const posted: string[] = [];
  const stop = runNotificationLoop(e.session, async (i): Promise<'posted'> => {
    posted.push(i.id);
    await gate;
    return 'posted';
  });
  await settle();
  assert.equal(e.listeners(), 1);
  stop();
  assert.equal(e.listeners(), 0);
  release();
  await settle();
  assert.deepEqual(posted, ['mail:acct:m1'], 'the second item is not posted after stop');
  const before = e.log.length;
  e.emit(notifyFrame());
  await settle();
  assert.equal(e.log.length, before, 'no call after stop');
});

test('retryDelay doubles from 5 s and stops at 5 min', () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7, 8, 20].map(retryDelay),
    [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000],
  );
});

test('a failed claim is retried once on a timer, longer each time, and a success resets the delay', async () => {
  const e = fakeEngine();
  const t = fakeTimers();
  let fail = true;
  e.hooks.claim = () => {
    if (fail) throw new Error('engine busy');
    return { items: [item(7)] };
  };
  const posted: string[] = [];
  const stop = runNotificationLoop(e.session, i => (posted.push(i.id), 'posted'), {
    timers: t.timers,
  });
  await settle();
  assert.deepEqual(
    [...t.pending.values()].map(x => x.ms),
    [5_000],
  );
  t.fire();
  await settle();
  assert.equal(e.claims.length, 2);
  assert.deepEqual(
    [...t.pending.values()].map(x => x.ms),
    [10_000],
    'one timer, doubled',
  );
  fail = false;
  t.fire();
  await settle();
  assert.deepEqual(posted, ['mail:acct:m7']);
  assert.equal(t.pending.size, 0, 'no timer after a good claim');
  fail = true;
  e.emit(notifyFrame());
  await settle();
  assert.deepEqual(
    [...t.pending.values()].map(x => x.ms),
    [5_000],
    'the delay started over',
  );
  stop();
});

test('a notify cancels the pending retry, and stop() clears it', async () => {
  const e = fakeEngine();
  const t = fakeTimers();
  let fail = true;
  e.hooks.claim = () => {
    if (fail) throw new Error('engine busy');
    return { items: [] };
  };
  const stop = runNotificationLoop(e.session, () => 'posted', { timers: t.timers });
  await settle();
  assert.equal(t.pending.size, 1);
  fail = false;
  e.emit(notifyFrame());
  await settle();
  assert.equal(t.pending.size, 0, 'the run that worked took the retry away');
  fail = true;
  e.emit(notifyFrame());
  await settle();
  assert.equal(t.pending.size, 1);
  stop();
  assert.equal(t.pending.size, 0);
});

test('a retry that fires after stop() claims nothing', async () => {
  const e = fakeEngine();
  const t = fakeTimers();
  e.hooks.claim = () => {
    throw new Error('engine busy');
  };
  const stop = runNotificationLoop(e.session, () => 'posted', { timers: t.timers });
  await settle();
  const run = [...t.pending.values()][0]!.run;
  stop();
  run();
  await settle();
  assert.equal(e.claims.length, 1);
});
