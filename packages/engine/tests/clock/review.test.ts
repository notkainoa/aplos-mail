import test from 'node:test';
import assert from 'node:assert/strict';
import type { LogRecord } from '@aplos/contract/log/events';
import { createLogger, type Logger } from '../../src/diag/log';
import {
  createTimerLoop,
  fakeClock,
  FIRE_TIMEOUT_MS,
  MAX_SYSTEM_WAIT_MS,
  NEXT_TIMEOUT_MS,
  systemClock,
  type FakeClock,
} from '../../src/clock/module';
import type { TimerLoop } from '../../src/clock/module';
import type { DeadlineSource } from '../../src/ports/time';
import { testEngine } from '../runtime.helpers';

const SEC = 1_000;
const HOUR = 3_600 * SEC;

function setup(wrap?: (log: Logger) => Logger) {
  const clock = fakeClock();
  const records: LogRecord[] = [];
  const base = createLogger({
    sink: { write: r => records.push(r) },
    salt: 'test-salt',
    clock,
    level: 'debug',
  });
  const loop = createTimerLoop({ clock, log: wrap ? wrap(base) : base });
  const drifts = () =>
    records.filter(r => r.event === 'engine.watchdog' && r.data.kind === 'timer_drift');
  return { clock, loop, drifts };
}

/** A promise the test settles by hand: the "one hung network call". */
function hung<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('hung fire: one source stuck in fire() never stalls the others, and never overlaps itself', async () => {
  const { clock, loop, drifts } = setup();
  const t0 = clock.now();
  const gate = hung();
  let syncFires = 0;
  let running = 0;
  let maxRunning = 0;
  loop.register({
    id: 'sync:acct',
    next: async () => t0 + SEC,
    async fire() {
      syncFires++;
      maxRunning = Math.max(maxRunning, ++running);
      await gate.promise;
      running--;
    },
  });
  const sent: number[] = [];
  let outboxDone = false;
  loop.register({
    id: 'outbox',
    next: async () => (outboxDone ? undefined : t0 + 60 * SEC),
    async fire() {
      sent.push(clock.now());
      outboxDone = true;
    },
  });
  loop.start();
  await clock.advance(61 * SEC);
  assert.deepEqual(sent, [t0 + 60 * SEC], 'the outbox deadline fired on time');
  assert.equal(syncFires, 1, 'the hung slot was not fired again while its fire was unsettled');
  assert.ok(drifts().length >= 1, 'the abandoned fire is logged as timer_drift');
  // The late settle frees the slot: it is re-read (dirty) and kicked.
  gate.resolve();
  await clock.flush();
  await loop.idle();
  assert.equal(maxRunning, 1);
});

test('hung fire: once it settles the slot is marked dirty, re-read and fires again', async () => {
  const { clock, loop } = setup();
  const t0 = clock.now();
  const gate = hung();
  let due = t0 + SEC;
  let fires = 0;
  loop.register({
    id: 'jobs',
    next: async () => due,
    async fire(now) {
      fires++;
      if (fires === 1) await gate.promise;
      due = fires === 1 ? now + 5 * SEC : Number.POSITIVE_INFINITY;
      if (fires > 1) due = now + 100 * HOUR;
    },
  });
  loop.start();
  await clock.advance(FIRE_TIMEOUT_MS + 5 * SEC);
  assert.equal(fires, 1);
  gate.resolve();
  await clock.flush();
  await clock.advance(6 * SEC);
  assert.equal(fires, 2, 'read again after the hung call settled');
});

test('hung fire: a timed-out fire that later rejects raises no unhandled rejection', async () => {
  const { clock, loop } = setup();
  const t0 = clock.now();
  const gate = hung();
  const seen: unknown[] = [];
  const onRejection = (reason: unknown) => seen.push(reason);
  process.on('unhandledRejection', onRejection);
  try {
    loop.register({ id: 'ops', next: async () => t0 + SEC, fire: () => gate.promise });
    loop.start();
    await clock.advance(FIRE_TIMEOUT_MS + 2 * SEC);
    gate.reject(new Error('socket closed'));
    await clock.flush();
    await new Promise(resolve => setTimeout(resolve, 20));
  } finally {
    process.off('unhandledRejection', onRejection);
  }
  assert.deepEqual(seen, []);
});

test('hung next: a source whose next() never answers does not stall the others', async () => {
  const { clock, loop, drifts } = setup();
  const t0 = clock.now();
  const gate = hung<number | undefined>();
  let reads = 0;
  loop.register({
    id: 'drafts',
    next: () => {
      reads++;
      return reads === 1 ? gate.promise : Promise.resolve(undefined);
    },
    fire: async () => {},
  });
  const fired: number[] = [];
  let done = false;
  loop.register({
    id: 'outbox',
    next: async () => (done ? undefined : t0 + 10 * SEC),
    async fire() {
      fired.push(clock.now());
      done = true;
    },
  });
  loop.start();
  await clock.advance(10 * SEC);
  assert.deepEqual(fired, [t0 + 10 * SEC]);
  assert.equal(reads, 1, 'next() is not called again while the first call is unsettled');
  assert.ok(drifts().length >= 1);
  assert.ok(NEXT_TIMEOUT_MS < FIRE_TIMEOUT_MS, 'a read times out sooner than a fire');
  gate.resolve(clock.now() + SEC);
  await clock.flush();
  await loop.idle();
  assert.equal(reads, 2, 'settling the hung read marks the slot dirty and reads it again');
});

test('register over a hung id: the new source waits for the old call to settle, then fires once', async () => {
  for (const reRegisterAfterTimeout of [false, true]) {
    const { clock, loop } = setup();
    const t0 = clock.now();
    const gate = hung();
    loop.register({ id: 'sync:a', next: async () => t0 + SEC, fire: () => gate.promise });
    loop.start();
    await clock.advance(2 * SEC);
    if (reRegisterAfterTimeout) await clock.advance(FIRE_TIMEOUT_MS);
    let fires = 0;
    loop.register({
      id: 'sync:a',
      next: async () => (fires > 0 ? undefined : t0 + SEC),
      fire: async () => void fires++,
    });
    await clock.advance(FIRE_TIMEOUT_MS + 5 * SEC);
    assert.equal(
      fires,
      0,
      `replacement fired while the old call hung (late=${reRegisterAfterTimeout})`,
    );
    gate.resolve();
    await clock.flush();
    await clock.advance(5 * SEC);
    assert.equal(fires, 1, 'fires once after the old call settled');
  }
});

test('dispose then register over a hung id: the new source waits for the old call to settle, then fires once', async () => {
  for (const disposeAfterTimeout of [false, true]) {
    const { clock, loop } = setup();
    const t0 = clock.now();
    const gate = hung();
    const off = loop.register({
      id: 'sync:a',
      next: async () => t0 + SEC,
      fire: () => gate.promise,
    });
    loop.start();
    await clock.advance(2 * SEC);
    if (disposeAfterTimeout) await clock.advance(FIRE_TIMEOUT_MS);
    off();
    let fires = 0;
    loop.register({
      id: 'sync:a',
      next: async () => (fires > 0 ? undefined : t0 + SEC),
      fire: async () => void fires++,
    });
    await clock.advance(FIRE_TIMEOUT_MS + 5 * SEC);
    assert.equal(fires, 0, `new source ran beside the hung call (late=${disposeAfterTimeout})`);
    gate.resolve();
    await clock.flush();
    await clock.advance(5 * SEC);
    assert.equal(fires, 1, 'fires once after the old call settled');
    await loop.stop();
  }
});

test('stop keeps the unsettled-call guard, and a late settle after stop does nothing', async () => {
  const { clock, loop } = setup();
  const t0 = clock.now();
  const gate = hung();
  let reads = 0;
  loop.register({
    id: 'sync:a',
    next: async () => (reads++, t0 + SEC),
    fire: () => gate.promise,
  });
  loop.start();
  await clock.advance(FIRE_TIMEOUT_MS + 2 * SEC);
  await loop.stop();
  const before = reads;
  gate.resolve();
  await clock.flush();
  assert.equal(reads, before, 'a settle after stop does not read or kick');
  assert.equal(clock.pending(), 0);
});

test('after stop and start, an id whose old call is still hung does not run beside it', async () => {
  const { clock, loop } = setup();
  const t0 = clock.now();
  const gate = hung();
  let fires = 0;
  loop.register({
    id: 'sync:a',
    next: async () => t0 + SEC,
    fire: () => (fires++, gate.promise),
  });
  loop.start();
  await clock.advance(FIRE_TIMEOUT_MS + 2 * SEC);
  assert.equal(fires, 1);
  await loop.stop();
  loop.start();
  await clock.advance(5 * SEC);
  assert.equal(fires, 1, 'a restarted loop does not fire the id beside its hung call');
  gate.resolve();
  await clock.flush();
  await clock.advance(5 * SEC);
  await loop.stop();
});

test('a gave-up call that settles with its slot still current wakes the loop (no stall)', async () => {
  const { clock, loop } = setup();
  const t0 = clock.now();
  const gate = hung();
  let fires = 0;
  let nextCalls = 0;
  loop.register({
    id: 'sync:a',
    // The first fire hangs past its timeout; afterwards the source reports a later deadline.
    next: async () => (nextCalls++ === 0 ? t0 + SEC : t0 + 10 * SEC),
    fire: () => (fires++ === 0 ? gate.promise : Promise.resolve()),
  });
  loop.start();
  await clock.advance(FIRE_TIMEOUT_MS + 2 * SEC);
  gate.resolve();
  await clock.flush();
  await clock.advance(11 * SEC);
  assert.ok(fires >= 2, `the source fired again after the hung call settled (fires=${fires})`);
  await loop.stop();
});

test('a within() that throws does not leave the slot inflight forever', async () => {
  const base = fakeClock();
  let failSleep = false;
  const clock: FakeClock = {
    ...base,
    sleep(ms, signal) {
      if (failSleep) {
        failSleep = false;
        throw new Error('sleep unavailable');
      }
      return base.sleep(ms, signal);
    },
  };
  const loop = createTimerLoop({
    clock,
    log: createLogger({ sink: { write: () => {} }, salt: 's', clock }),
  });
  const t0 = clock.now();
  let fires = 0;
  loop.register({
    id: 'jobs',
    next: async () => (fires >= 2 ? undefined : t0 + SEC),
    fire: async () => void fires++,
  });
  loop.start();
  await clock.flush();
  failSleep = true;
  await clock.advance(10 * SEC);
  await loop.idle();
  assert.equal(fires, 2, 'the slot fires again after the failed race');
  await loop.stop();
});

test('a dirty source is re-read, not fired on its stale deadline', async () => {
  const { clock, loop } = setup();
  const t0 = clock.now();
  let aNext: number | undefined = t0;
  const aFires: number[] = [];
  loop.register({
    id: 'a',
    next: async () => aNext,
    async fire(now) {
      aFires.push(now);
      aNext = undefined;
    },
  });
  loop.register({
    id: 'b',
    next: async () => {
      await clock.sleep(SEC);
      return undefined;
    },
    fire: async () => {},
  });
  loop.start();
  await clock.flush();
  // While b's read is in flight, a's deadline moves later.
  aNext = t0 + 100 * SEC;
  loop.changed('a');
  await clock.advance(SEC);
  await loop.idle();
  assert.deepEqual(aFires, [], 'the stale deadline did not fire');
  await clock.advance(100 * SEC);
  assert.equal(aFires.length, 1);
});

test('a log port that throws after a fire does not turn the backoff into an immediate re-fire', async () => {
  const { clock, loop } = setup(log => ({
    event(id, fields) {
      if (id === 'engine.watchdog') throw new Error('log down');
      log.event(id, fields);
    },
    with: ctx => log.with(ctx),
    enabled: level => log.enabled(level),
  }));
  let fires = 0;
  loop.register({ id: 'jobs', next: async () => clock.now() - 1, fire: async () => void fires++ });
  loop.start();
  await clock.advance(0);
  await loop.idle();
  assert.equal(fires, 1, 'one fire at launch, held back for 1 s');
  await clock.advance(5 * SEC);
  assert.ok(fires <= 6, `${fires} fires in 5 s`);
});

test('system clock: a long wait is armed in capped chunks and a wall-clock jump is noticed', () => {
  const realNow = Date.now;
  const realSetTimeout = globalThis.setTimeout;
  let wall = realNow();
  const armed: { run: () => void; ms: number }[] = [];
  Date.now = () => wall;
  globalThis.setTimeout = ((run: () => void, ms: number) => {
    armed.push({ run, ms });
    return { unref() {} };
  }) as unknown as typeof setTimeout;
  let fired = 0;
  let slept = 0;
  try {
    const clock = systemClock();
    clock.timer(wall + 8 * HOUR, () => fired++);
    void clock.sleep(8 * HOUR).then(() => slept++);
    assert.ok(armed.length === 2 && armed.every(a => a.ms <= MAX_SYSTEM_WAIT_MS), 'capped waits');
    // The Mac slept 7 h: libuv's monotonic timers only advance one minute, but the wall clock jumped.
    wall += 7 * HOUR + 30 * 60 * SEC;
    for (const a of armed.splice(0)) a.run();
    assert.equal(fired, 0, 'not yet due: re-armed, never fired early');
    assert.ok(armed.length === 2 && armed.every(a => a.ms <= MAX_SYSTEM_WAIT_MS));
    wall += 31 * 60 * SEC;
    for (const a of armed.splice(0)) a.run();
    assert.equal(fired, 1, 'fires on the first capped turn after the deadline passed');
  } finally {
    Date.now = realNow;
    globalThis.setTimeout = realSetTimeout;
  }
  return Promise.resolve().then(() => assert.equal(slept, 1, 'sleep survives system sleep too'));
});

test('Engine.wake re-reads every deadline source', async () => {
  const t = await testEngine();
  try {
    let reads = 0;
    const source: DeadlineSource = {
      id: 'sync:wake',
      next: async () => (reads++, undefined),
      fire: async () => {},
    };
    t.engine.services.deadlines.register(source);
    const loop = t.engine.services.deadlines as TimerLoop;
    await loop.idle();
    const before = reads;
    t.engine.wake();
    await loop.idle();
    assert.equal(reads, before + 1);
  } finally {
    await t.cleanup();
  }
  assert.doesNotThrow(() => t.engine.wake(), 'a no-op once closed');
});

test('Engine.wake is a no-op when the host injected a registry without wake', async () => {
  const t = await testEngine({
    ports: { deadlines: { register: () => () => {}, changed: () => {} } },
  });
  try {
    assert.doesNotThrow(() => t.engine.wake());
  } finally {
    await t.cleanup();
  }
});

test('a clock whose sleep always throws is logged as a wait failure and does not spin', async () => {
  const base = fakeClock();
  const clock: FakeClock = {
    ...base,
    sleep() {
      throw new Error('sleep unavailable');
    },
  };
  const records: LogRecord[] = [];
  const loop = createTimerLoop({
    clock,
    log: createLogger({ sink: { write: r => records.push(r) }, salt: 's', clock, level: 'debug' }),
  });
  const t0 = clock.now();
  let reads = 0;
  let fires = 0;
  loop.register({
    id: 'jobs',
    next: async () => (reads++, t0),
    fire: async () => void fires++,
  });
  loop.start();
  await clock.advance(SEC);
  await loop.idle();
  assert.ok(reads < 10, `next() read ${reads} times in one second`);
  assert.ok(fires < 10, `fire() ran ${fires} times in one second`);
  const lags = records
    .filter(r => r.event === 'engine.watchdog')
    .map(r => (r.data as { lagMs: number }).lagMs);
  assert.ok(lags.length > 0);
  assert.ok(!lags.includes(FIRE_TIMEOUT_MS), 'a failed wait is not logged as the fire timeout');
  assert.ok(!lags.includes(NEXT_TIMEOUT_MS), 'a failed wait is not logged as the next timeout');
  await loop.stop();
});

test('a clock whose sleep REJECTS is a failed wait, not a timeout, and does not spin', async () => {
  const base = fakeClock();
  const clock: FakeClock = {
    ...base,
    sleep: () => Promise.reject(new Error('sleep rejected')),
  };
  const records: LogRecord[] = [];
  const loop = createTimerLoop({
    clock,
    log: createLogger({ sink: { write: r => records.push(r) }, salt: 's', clock, level: 'debug' }),
  });
  const t0 = clock.now();
  let reads = 0;
  let fires = 0;
  loop.register({
    id: 'jobs',
    next: async () => (reads++, t0),
    fire: async () => void fires++,
  });
  loop.start();
  await clock.advance(SEC);
  await loop.idle();
  assert.ok(reads < 10, `next() read ${reads} times in one second`);
  assert.ok(fires < 10, `fire() ran ${fires} times in one second`);
  const lags = records
    .filter(r => r.event === 'engine.watchdog')
    .map(r => (r.data as { lagMs: number }).lagMs);
  assert.ok(lags.length > 0, 'the failed wait is logged');
  assert.ok(!lags.includes(FIRE_TIMEOUT_MS), 'a rejected sleep is not logged as the fire timeout');
  assert.ok(!lags.includes(NEXT_TIMEOUT_MS), 'a rejected sleep is not logged as the next timeout');
  await loop.stop();
});

test('stall: sleep throws once while next() is hung; when next() settles the source still fires', async () => {
  const base = fakeClock();
  let sleeps = 0;
  const clock: FakeClock = {
    ...base,
    sleep(ms, signal) {
      if (sleeps++ === 0) throw new Error('sleep unavailable once');
      return base.sleep(ms, signal);
    },
  };
  const loop = createTimerLoop({
    clock,
    log: createLogger({ sink: { write: () => undefined }, salt: 's', clock, level: 'debug' }),
  });
  const t0 = clock.now();
  const gate = hung<number>();
  let reads = 0;
  let fires = 0;
  loop.register({
    id: 'jobs',
    // The first read hangs (the wait around it fails at once); every later read says "due now".
    next: () => (reads++ === 0 ? gate.promise : Promise.resolve(t0)),
    fire: async () => void fires++,
  });
  loop.start();
  await clock.advance(SEC);
  assert.equal(fires, 0, 'nothing fires while the first next() is still hung');
  gate.resolve(t0);
  await clock.flush();
  await clock.advance(5 * SEC);
  assert.ok(fires >= 1, `the source fired after the hung next() settled (fires=${fires})`);
  await loop.stop();
});
