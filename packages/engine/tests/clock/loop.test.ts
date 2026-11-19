import test from 'node:test';
import assert from 'node:assert/strict';
import type { LogRecord } from '@aplos/contract/log/events';
import { createLogger } from '../../src/diag/log';
import { createTimerLoop, fakeClock, systemClock, type FakeClock } from '../../src/clock/module';
import type { DeadlineSource } from '../../src/ports/time';

const SEC = 1_000;
const HOUR = 3_600 * SEC;

function setup(options: { maxWakesPerHour?: number } = {}) {
  const clock = fakeClock();
  const records: LogRecord[] = [];
  const log = createLogger({
    sink: { write: r => records.push(r) },
    salt: 'test-salt',
    clock,
    level: 'debug',
  });
  const loop = createTimerLoop({ clock, log, ...options });
  const drift = () => records.filter(r => r.event === 'engine.watchdog').length;
  return { clock, loop, drift };
}

/** A source over a list of deadlines that handles everything due, recording when each one fired. */
function listSource(id: string, clock: FakeClock, deadlines: number[]) {
  const fired: { at: number; firedAt: number }[] = [];
  const pending = [...deadlines].sort((a, b) => a - b);
  const source: DeadlineSource = {
    id,
    next: async () => pending[0],
    async fire(now) {
      while (pending.length && pending[0] <= now)
        fired.push({ at: pending.shift()!, firedAt: clock.now() });
    },
  };
  return { source, fired, pending };
}

test('fires at its deadline, not before, and holds one timer while asleep', async () => {
  const { clock, loop } = setup();
  const t0 = clock.now();
  const { source, fired } = listSource('reminders', clock, [t0 + 10 * SEC]);
  loop.register(source);
  loop.start();
  await clock.flush();
  assert.equal(clock.pending(), 1);
  await clock.advance(10 * SEC - 1);
  assert.equal(fired.length, 0);
  await clock.advance(1);
  assert.deepEqual(fired, [{ at: t0 + 10 * SEC, firedAt: t0 + 10 * SEC }]);
  assert.equal(clock.pending(), 0, 'nothing left to wait for: no timer armed');
});

test('changed() re-reads a source whose deadline moved earlier', async () => {
  const { clock, loop } = setup();
  const t0 = clock.now();
  const list = listSource('outbox', clock, [t0 + HOUR]);
  loop.register(list.source);
  loop.start();
  await clock.flush();
  list.pending.unshift(t0 + 5 * SEC);
  loop.changed('outbox');
  await clock.advance(5 * SEC);
  assert.deepEqual(
    list.fired.map(f => f.firedAt),
    [t0 + 5 * SEC],
  );
  assert.equal(clock.pending(), 1, 'the old timer was replaced, not doubled');
});

test('20 overdue items from 20 sources catch up at launch in deadline order', async () => {
  const { clock, loop } = setup();
  const t0 = clock.now();
  const order: number[] = [];
  // Registered in reverse so registration order cannot pass for deadline order.
  for (let i = 19; i >= 0; i--) {
    let done = false;
    loop.register({
      id: `sync:acct-${i}`,
      next: async () => (done ? undefined : t0 - (20 - i) * HOUR),
      async fire() {
        done = true;
        order.push(i);
      },
    });
  }
  loop.start();
  await loop.idle();
  assert.deepEqual(
    order,
    Array.from({ length: 20 }, (_, i) => i),
  );
});

test('spin: a source that never moves its deadline fires at most once a second and is logged', async () => {
  const { clock, loop, drift } = setup();
  let fires = 0;
  loop.register({ id: 'jobs', next: async () => clock.now() - 1, fire: async () => void fires++ });
  loop.start();
  await clock.advance(60 * SEC);
  assert.ok(fires <= 61, `${fires} fires in 60 s`);
  assert.ok(fires >= 59, `still retried (${fires})`);
  assert.ok(drift() >= fires - 1, 'each stuck fire is logged');
});

test('spin: a source that inches its deadline is bounded by the shared wake budget', async () => {
  const { clock, loop } = setup({ maxWakesPerHour: 60 });
  let fires = 0;
  let next = clock.now();
  loop.register({
    id: 'ops',
    next: async () => next,
    async fire(now) {
      fires++;
      next = now + 1;
    },
  });
  loop.start();
  await clock.advance(30 * SEC);
  assert.ok(fires <= 61, `${fires} fires in 30 s`);
});

test('spin: a throwing source neither spins nor stops the others', async () => {
  const { clock, loop } = setup();
  const t0 = clock.now();
  let fires = 0;
  loop.register({
    id: 'broken',
    next: async () => t0,
    fire: async () => {
      fires++;
      throw new Error('bug');
    },
  });
  const ok = listSource('later', clock, [t0 + 3 * SEC]);
  loop.register(ok.source);
  loop.start();
  await clock.advance(10 * SEC);
  assert.ok(fires <= 11, `${fires} fires`);
  assert.deepEqual(
    ok.fired.map(f => f.firedAt),
    [t0 + 3 * SEC],
  );
});

test('starve: a slow source delays a due deadline by no more than its own run time', async () => {
  const { clock, loop } = setup();
  const t0 = clock.now();
  const run = 5 * SEC;
  let slowStart = 0,
    slowEnd = 0;
  let slowDone = false;
  loop.register({
    id: 'jobs',
    next: async () => (slowDone ? undefined : t0 + SEC),
    async fire() {
      slowStart = clock.now();
      await clock.sleep(run);
      slowEnd = clock.now();
      slowDone = true;
    },
  });
  const fast = listSource('reminders', clock, [t0 + 2 * SEC]);
  loop.register(fast.source);
  loop.start();
  await clock.advance(20 * SEC);
  assert.equal(slowEnd - slowStart, run);
  assert.equal(fast.fired.length, 1);
  assert.ok(fast.fired[0].firedAt <= slowEnd, 'fires as soon as the slow run ends');
  assert.ok(fast.fired[0].firedAt - fast.fired[0].at <= run, 'late by less than the slow run');
});

test('starve: a stuck source cannot hold back another source due later', async () => {
  const { clock, loop } = setup();
  const t0 = clock.now();
  loop.register({ id: 'jobs', next: async () => t0, fire: async () => {} });
  const later = listSource('later', clock, [t0 + 2_500, t0 + 7_250]);
  loop.register(later.source);
  loop.start();
  await clock.advance(10 * SEC);
  assert.deepEqual(
    later.fired.map(f => f.firedAt - f.at),
    [0, 0],
  );
});

test('wake-ups per hour are capped', async () => {
  const { clock, loop } = setup({ maxWakesPerHour: 10 });
  let fires = 0;
  let next = clock.now() + 2 * SEC;
  loop.register({
    id: 'drafts',
    next: async () => next,
    async fire(now) {
      fires++;
      next = now + 2 * SEC;
    },
  });
  loop.start();
  await clock.advance(HOUR - 1);
  assert.equal(fires, 10);
  await clock.advance(HOUR);
  assert.ok(fires <= 21, `${fires} after two hours`);
});

test('a clock jump forward fires each deadline once; a jump back fires nothing early', async () => {
  const { clock, loop } = setup();
  const t0 = clock.now();
  const list = listSource('reminders', clock, [t0 + HOUR, t0 + 2 * HOUR]);
  loop.register(list.source);
  loop.start();
  await clock.flush();
  await clock.set(t0 - 3 * 24 * HOUR);
  loop.wake();
  await clock.advance(HOUR);
  assert.equal(list.fired.length, 0, 'back in time: nothing fires');
  await clock.set(t0 + 3 * 24 * HOUR);
  loop.wake();
  await loop.idle();
  await clock.flush();
  assert.deepEqual(
    list.fired.map(f => f.at),
    [t0 + HOUR, t0 + 2 * HOUR],
  );
  await clock.advance(HOUR);
  assert.equal(list.fired.length, 2, 'each once');
});

test('unregister and stop leave no timer behind; a second register replaces the first', async () => {
  const { clock, loop } = setup();
  const t0 = clock.now();
  const a = listSource('later', clock, [t0 + SEC]);
  const b = listSource('later', clock, [t0 + 2 * SEC]);
  loop.register(a.source);
  const off = loop.register(b.source);
  loop.start();
  await clock.advance(3 * SEC);
  assert.equal(a.fired.length, 0);
  assert.equal(b.fired.length, 1);
  b.pending.push(t0 + HOUR);
  loop.changed('later');
  await clock.flush();
  off();
  await loop.idle();
  assert.equal(clock.pending(), 0);
  const c = listSource('outbox', clock, [t0 + HOUR]);
  loop.register(c.source);
  loop.stop();
  await clock.advance(2 * HOUR);
  assert.equal(c.fired.length, 0);
  assert.equal(clock.pending(), 0);
});

test("a source's deadlines each fire at their own time inside a second", async () => {
  const { clock, loop } = setup();
  const t0 = clock.now();
  const list = listSource('outbox', clock, [t0 + 100, t0 + 200, t0 + 300]);
  loop.register(list.source);
  loop.start();
  await clock.advance(5 * SEC);
  assert.deepEqual(
    list.fired.map(f => f.firedAt),
    [t0 + 100, t0 + 200, t0 + 300],
    'a source that moves next() past now is not held to the stuck-source backoff',
  );
});

test('the system clock never fires early and sleep honours abort', async () => {
  const clock = systemClock();
  const at = clock.now() + 30;
  const firedAt = await new Promise<number>(resolve => clock.timer(at, () => resolve(Date.now())));
  assert.ok(firedAt >= at);
  let fired = false;
  clock.timer(clock.now() + 20, () => (fired = true)).cancel();
  await new Promise(r => setTimeout(r, 40));
  assert.equal(fired, false);
  const abort = new AbortController();
  const slept = clock.sleep(10_000, abort.signal);
  abort.abort(new Error('quit'));
  await assert.rejects(slept, /quit/);
});

test('a drift line names the source kind that keeps backing off, never its account part', async () => {
  const clock = fakeClock();
  const records: LogRecord[] = [];
  const log = createLogger({
    sink: { write: r => records.push(r) },
    salt: 's',
    clock,
    level: 'debug',
  });
  const loop = createTimerLoop({ clock, log });
  // Stays due after every fire: the loop backs it off and says so.
  loop.register({
    id: 'sync:acct-secret@example.com',
    next: async () => clock.now(),
    fire: async () => {},
  });
  loop.start();
  await clock.flush();
  await clock.advance(2_000);
  const drift = records.filter(r => r.event === 'engine.watchdog');
  assert.ok(drift.length > 0, 'the source is reported');
  assert.ok(drift.every(r => r.data.source === 'sync'));
  assert.ok(!JSON.stringify(drift).includes('acct-secret'), 'no account part in the line');
});
