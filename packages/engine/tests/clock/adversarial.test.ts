import test from 'node:test';
import assert from 'node:assert/strict';
import type { LogRecord } from '@aplos/contract/log/events';
import { createLogger } from '../../src/diag/log';
import {
  createTimerLoop,
  fakeClock,
  MAX_WAKES_PER_HOUR,
  systemClock,
  type FakeClock,
} from '../../src/clock/module';
import { TICK_MS } from '../../src/views/fanout';
import { testEngine } from '../runtime.helpers';

const SEC = 1_000;
const HOUR = 3_600 * SEC;

function setup(options: { maxWakesPerHour?: number; clock?: FakeClock } = {}) {
  const clock = options.clock ?? fakeClock();
  const records: LogRecord[] = [];
  const log = createLogger({
    sink: { write: r => records.push(r) },
    salt: 'test-salt',
    clock,
    level: 'debug',
  });
  const loop = createTimerLoop({ clock, log, maxWakesPerHour: options.maxWakesPerHour });
  return { clock, loop, records };
}

/** A fake clock whose `now()` moves one ms per read, like real time passing while the loop awaits. */
function tickingClock(): FakeClock {
  const base = fakeClock();
  let drift = 0;
  return { ...base, now: () => base.now() + drift++ };
}

const microtasks = async (n: number) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

test('a source whose next() starts throwing backs off even when time passes during the fire', async t => {
  const { clock, loop } = setup({ clock: tickingClock() });
  t.after(() => loop.stop());
  let fires = 0;
  let broken = false;
  const t0 = clock.now();
  loop.register({
    id: 'jobs',
    next: async () => {
      if (broken) throw new Error('gone');
      return t0;
    },
    fire: async () => {
      fires++;
      broken = true;
    },
  });
  loop.start();
  await microtasks(80);
  // The unreadable-source backoff was overwritten by the post-fire stuck check when `now` had moved on.
  assert.ok(fires <= 2, `${fires} fires in 80 microtask turns`);
});

test('a source that inches next() one ms ahead of now cannot spin the pass', async t => {
  const { clock, loop } = setup({ clock: tickingClock() });
  t.after(() => loop.stop());
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
  await microtasks(80);
  // Real time moves on while the source works, so its new deadline is already due again: a pass that fires it
  // straight away never yields to the event loop and bypasses the wake budget.
  assert.ok(fires <= 2, `${fires} fires in 80 microtask turns`);
});

test('a changed() landing in the same turn a pass ends is not lost', async () => {
  for (let depth = 0; depth < 40; depth++) {
    const { clock, loop } = setup();
    const t0 = clock.now();
    let deadline: number | undefined = t0 + HOUR;
    const firedAt: number[] = [];
    loop.register({
      id: 'outbox',
      next: async () => deadline,
      async fire(now) {
        firedAt.push(now);
        deadline = now + HOUR;
      },
    });
    loop.start();
    await clock.flush();
    deadline = t0 + 5 * SEC;
    loop.changed('outbox');
    // A commit's continuation runs `depth` microtasks later, somewhere across the pass's last awaits.
    let chain: Promise<void> = Promise.resolve();
    for (let i = 0; i < depth; i++) chain = chain.then(() => {});
    void chain.then(() => {
      deadline = t0 + 2 * SEC;
      loop.changed('outbox');
    });
    await clock.flush();
    await clock.advance(10 * SEC);
    assert.deepEqual(firedAt, [t0 + 2 * SEC], `depth ${depth}: the moved deadline fired on time`);
    loop.stop();
  }
});

test('closing the engine waits for a fire in flight before the store goes away', async () => {
  const clock = fakeClock();
  const t = await testEngine({ clock });
  try {
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    let started = false;
    let done = false;
    let due: number | undefined = clock.now() + SEC;
    t.engine.services.deadlines.register({
      id: 'outbox',
      next: async () => due,
      async fire() {
        started = true;
        due = undefined;
        await gate;
        done = true;
      },
    });
    await clock.advance(SEC);
    assert.ok(started, 'the fire began');
    let closed = false;
    const closing = t.engine.close().then(() => (closed = true));
    await clock.flush();
    assert.equal(closed, false, 'close() waits for the running fire');
    release();
    await closing;
    assert.ok(done);
  } finally {
    await t.cleanup();
  }
});

test("the default wake budget admits eng-views' tick", () => {
  const perHour = HOUR / TICK_MS;
  assert.ok(
    MAX_WAKES_PER_HOUR >= perHour,
    `${MAX_WAKES_PER_HOUR}/h would throttle a ${TICK_MS} ms ticker (${perHour}/h) after minutes`,
  );
});

test("one source's spent wake budget does not delay another source", async t => {
  const { clock, loop } = setup({ maxWakesPerHour: 5 });
  t.after(() => loop.stop());
  const t0 = clock.now();
  let inchNext = t0;
  loop.register({
    id: 'jobs',
    next: async () => inchNext,
    async fire(now) {
      inchNext = now + 1;
    },
  });
  const fired: number[] = [];
  let due: number | undefined = t0 + 10 * SEC;
  loop.register({
    id: 'outbox',
    next: async () => due,
    async fire() {
      fired.push(clock.now());
      due = undefined;
    },
  });
  loop.start();
  await clock.advance(10 * SEC);
  // A runaway `jobs` has used up its hour; the outbox deadline still goes on time.
  assert.deepEqual(fired, [t0 + 10 * SEC]);
});

test('the system clock splits a wait longer than a timeout can hold and never fires early', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const clock = systemClock();
  const waits: number[] = [];
  const realSetTimeout = globalThis.setTimeout;
  const spy = t.mock.method(globalThis, 'setTimeout', (fn: () => void, ms?: number) => {
    waits.push(ms ?? 0);
    return realSetTimeout(fn, ms);
  });
  // Past 2^31 ms (24.8 days) twice over, so the re-arm after the first clamp is itself clamped.
  const month = 60 * 24 * HOUR;
  let firedAt = 0;
  clock.timer(clock.now() + month, () => (firedAt = Date.now()));
  t.mock.timers.tick(2 ** 31 - 1);
  assert.equal(firedAt, 0, 'not after the first clamp');
  t.mock.timers.tick(month);
  assert.ok(firedAt >= 1_000_000 + month, `fired at ${firedAt}`);
  assert.ok(
    waits.every(ms => ms <= 2 ** 31 - 1),
    `armed ${waits}`,
  );
  spy.mock.restore();
});

test('timers with an equal deadline fire in the order they were armed, on every clock', async () => {
  const clock = fakeClock();
  const at = clock.now() + SEC;
  const order: string[] = [];
  clock.timer(at, () => order.push('a'));
  clock.timer(at - 1, () => order.push('early'));
  clock.timer(at, () => order.push('b'));
  clock.timer(at, () => order.push('c'));
  await clock.advance(SEC);
  assert.deepEqual(order, ['early', 'a', 'b', 'c']);
});

test('sources due at the same instant fire in registration order', async t => {
  const { clock, loop } = setup();
  t.after(() => loop.stop());
  const at = clock.now() + SEC;
  const order: string[] = [];
  for (const id of ['first', 'second', 'third']) {
    let done = false;
    loop.register({
      id,
      next: async () => (done ? undefined : at),
      async fire() {
        done = true;
        order.push(id);
      },
    });
  }
  loop.start();
  await clock.advance(SEC);
  assert.deepEqual(order, ['first', 'second', 'third']);
});

test('stop leaves no timer armed the moment it returns', async () => {
  const { clock, loop } = setup();
  loop.register({ id: 'later', next: async () => clock.now() + HOUR, fire: async () => {} });
  loop.start();
  await loop.idle();
  assert.equal(clock.pending(), 1);
  void loop.stop();
  assert.equal(clock.pending(), 0);
});

test("a stuck source's backoff written before a backward jump holds one second, not the whole jump", async t => {
  const { clock, loop } = setup();
  t.after(() => loop.stop());
  let fires = 0;
  loop.register({
    id: 'jobs',
    next: async () => clock.now() - 1,
    fire: async () => void fires++,
  });
  loop.start();
  await loop.idle();
  assert.equal(fires, 1);
  await clock.set(clock.now() - HOUR);
  loop.wake();
  await clock.advance(1_500);
  assert.ok(fires >= 2, `${fires} fires: the stale backoff stamp deferred the source by the jump`);
});
