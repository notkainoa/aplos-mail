import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { LogRecord } from '@aplos/contract/log/events';
import { createLogger } from '../../src/diag/log';
import { createTimerLoop, fakeClock, systemClock, type FakeClock } from '../../src/clock/module';
import type { DeadlineSource } from '../../src/ports/time';

const SEC = 1_000;

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
  const drift = () => records.filter(r => r.event === 'engine.watchdog').length;
  return { clock, loop, drift, records };
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

test('a source whose next() returns NaN backs off instead of spinning', async t => {
  const { clock, loop, drift } = setup();
  t.after(() => loop.stop());
  let fires = 0;
  loop.register({
    id: 'jobs',
    next: async () => Number.NaN,
    fire: async () => {
      fires++;
    },
  });
  loop.start();
  // Microtask yields only: a spinning pass starves real timers, so a fixed count of yields bounds it.
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.ok(fires <= 2, `${fires} fires in 20 ticks`);
  await clock.advance(3 * SEC);
  assert.ok(fires <= 4, `${fires} fires in 3 s`);
  assert.ok(drift() >= 1, 'the invalid deadline is logged');
});

test('a source whose next() returns Infinity is treated as unreadable, not armed forever', async t => {
  const { clock, loop, drift } = setup();
  t.after(() => loop.stop());
  let fires = 0;
  loop.register({
    id: 'jobs',
    next: async () => Number.POSITIVE_INFINITY,
    fire: async () => {
      fires++;
    },
  });
  loop.start();
  await clock.advance(2 * SEC);
  assert.ok(drift() >= 1, 'the invalid deadline is logged');
  assert.ok(fires <= 3, `${fires} fires in 2 s`);
});

test('an armed system timer and sleep do not hold the process open', () => {
  const url = new URL('../../src/clock/system.ts', import.meta.url).href;
  const script =
    `const m = await import(${JSON.stringify(url)});` +
    `m.systemClock().timer(Date.now() + 300000, () => {});` +
    `void m.systemClock().sleep(300000);`;
  const child = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', script],
    { timeout: 15_000 },
  );
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, `child did not exit: ${child.signal} ${child.stderr}`);
});

test('a pass that throws is logged and leaves idle() resolved, not rejected', async t => {
  const clock = fakeClock();
  const { loop, records } = setup({ clock });
  t.after(() => loop.stop());
  const realTimer = clock.timer;
  let calls = 0;
  clock.timer = (at, fire) => {
    if (calls++ === 0) throw new Error('boom');
    return realTimer(at, fire);
  };
  const list = listSource('later', clock, [clock.now() + SEC]);
  loop.register(list.source);
  loop.start();
  await loop.idle();
  await clock.advance(2 * SEC);
  assert.equal(list.fired.length, 1);
  assert.ok(
    records.some(r => r.event === 'engine.watchdog'),
    'the failed pass is logged',
  );
});

test('a failed re-arm cannot early-return the next arm on a dead timer', async t => {
  const clock = fakeClock();
  const { loop } = setup({ clock });
  t.after(() => loop.stop());
  const t0 = clock.now();
  const list = listSource('later', clock, [t0 + 10 * SEC]);
  const realTimer = clock.timer;
  let calls = 0;
  clock.timer = (at, fire) => {
    calls++;
    if (calls === 2) throw new Error('boom');
    return realTimer(at, fire);
  };
  loop.register(list.source);
  loop.start();
  await loop.idle();
  list.pending[0] = t0 + 5 * SEC;
  loop.changed('later');
  await loop.idle();
  list.pending[0] = t0 + 10 * SEC;
  loop.changed('later');
  await loop.idle();
  await clock.advance(11 * SEC);
  assert.equal(list.fired.length, 1);
});

test('the wake budget survives a wall-clock jump backwards', async t => {
  const { clock, loop } = setup({ maxWakesPerHour: 1 });
  t.after(() => loop.stop());
  const t0 = clock.now();
  let fires = 0;
  let next = t0 + 2 * SEC;
  loop.register({
    id: 'drafts',
    next: async () => next,
    async fire(now) {
      fires++;
      next = now + 2 * SEC;
    },
  });
  loop.start();
  await clock.advance(4 * SEC);
  assert.equal(fires, 1, 'the cap deferred the second wake');
  await clock.set(t0 - 60 * SEC);
  loop.wake();
  await clock.advance(70 * SEC);
  assert.equal(fires, 2, 'the pending deadline fires at its own time, not an hour out');
});

test('a backward wall-clock jump does not defer an overdue deadline', async t => {
  const { clock, loop } = setup();
  t.after(() => loop.stop());
  const t0 = clock.now();
  const list = listSource('later', clock, [t0 + SEC]);
  loop.register(list.source);
  loop.start();
  await clock.advance(SEC);
  assert.equal(list.fired.length, 1);
  list.pending.push(t0 - 700 * SEC);
  await clock.set(t0 - 600 * SEC);
  loop.wake();
  // A stale stamp holds at most the 1 s backoff, not the whole 10-minute jump.
  await loop.idle();
  assert.equal(list.fired.length, 2, 'the overdue deadline fires at the wake');
  assert.equal(list.fired[1].firedAt, t0 - 600 * SEC);
});

test('advance fires timers armed by a fire over many turns', async () => {
  const clock = fakeClock();
  const t0 = clock.now();
  const fired: number[] = [];
  clock.timer(t0 + SEC, () => {
    void (async () => {
      await clock.flush();
      await clock.flush();
      clock.timer(t0 + 2 * SEC, () => fired.push(1));
    })();
  });
  await clock.advance(3 * SEC);
  assert.deepEqual(fired, [1]);
});

test('a NaN target fires once instead of spinning the system clock', async () => {
  const clock = systemClock();
  const fired = await new Promise<number>(resolve => {
    const timer = clock.timer(Number.NaN, () => resolve(1));
    setTimeout(() => {
      timer.cancel();
      resolve(0);
    }, 300);
  });
  assert.equal(fired, 1);
});

test('the fake clock fires a NaN-targeted timer like the real one', async () => {
  const clock = fakeClock();
  let fired = false;
  clock.timer(Number.NaN, () => {
    fired = true;
  });
  await clock.advance(1);
  assert.equal(fired, true);
});

test('advance and set reject non-finite input and advance rejects a negative step', async () => {
  const clock = fakeClock();
  const t0 = clock.now();
  await assert.rejects(clock.advance(-1));
  await assert.rejects(clock.advance(Number.NaN));
  await assert.rejects(clock.set(Number.NaN));
  assert.equal(clock.now(), t0);
});

test('a throwing timer fire does not skip later timers or corrupt the clock', async () => {
  const clock = fakeClock();
  const t0 = clock.now();
  const fired: number[] = [];
  clock.timer(t0 + SEC, () => {
    throw new Error('bug');
  });
  clock.timer(t0 + 2 * SEC, () => fired.push(2));
  await assert.rejects(clock.advance(3 * SEC), /bug/);
  assert.deepEqual(fired, [2], 'the later timer still fired');
  assert.equal(clock.now(), t0 + 3 * SEC);
});

test('a sub-second deadline source ticks inside one fake advance', async t => {
  const { clock, loop } = setup();
  t.after(() => loop.stop());
  let ticks = 0;
  let nextAt = clock.now() + 50;
  loop.register({
    id: 'views',
    next: async () => nextAt,
    async fire(now) {
      ticks++;
      nextAt = now + 50;
    },
  });
  loop.start();
  await loop.idle();
  // The contract: a source that moves next() past now is not throttled to one fire a second.
  await clock.advance(300);
  assert.equal(ticks, 6);
});

test('a source unregistered inside its own fire is not read again', async t => {
  const { clock, loop } = setup();
  t.after(() => loop.stop());
  const t0 = clock.now();
  let nextCalls = 0;
  const off = loop.register({
    id: 'later',
    next: async () => {
      nextCalls++;
      return t0;
    },
    async fire() {
      off();
    },
  });
  loop.start();
  await loop.idle();
  assert.equal(nextCalls, 1);
});

test('a zero wake budget still lets deadlines fire', async t => {
  const { clock, loop } = setup({ maxWakesPerHour: 0 });
  t.after(() => loop.stop());
  const list = listSource('later', clock, [clock.now() + SEC]);
  loop.register(list.source);
  loop.start();
  await clock.advance(2 * SEC);
  assert.equal(list.fired.length, 1);
});

test('a source whose next() throws retries like a stuck one and is logged', async t => {
  const { clock, loop, drift } = setup();
  t.after(() => loop.stop());
  let reads = 0;
  let fires = 0;
  loop.register({
    id: 'jobs',
    next: async () => {
      reads++;
      throw new Error('gone');
    },
    fire: async () => {
      fires++;
    },
  });
  loop.start();
  await clock.advance(3 * SEC);
  assert.ok(fires <= 4, `${fires} fires in 3 s`);
  assert.ok(reads <= 5, `${reads} reads`);
  assert.ok(drift() >= 1, 'the unreadable source is logged');
});
