import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DEDUPE_MS, watchPowerResume } from '../../src/host/power';

function setup(wake: () => void = () => {}) {
  const power = new EventEmitter();
  let wakes = 0;
  const unsubscribe = watchPowerResume(power, {
    wake: () => {
      wakes++;
      wake();
    },
  });
  return { power, unsubscribe, wakes: () => wakes };
}

test('resume calls wake once', () => {
  const { power, wakes } = setup();
  power.emit('resume');
  assert.equal(wakes(), 1);
});

test('unlock-screen calls wake', () => {
  const { power, wakes } = setup();
  power.emit('unlock-screen');
  assert.equal(wakes(), 1);
});

test('other power events do not wake the engine', () => {
  const { power, wakes } = setup();
  for (const event of ['suspend', 'lock-screen', 'on-ac', 'on-battery', 'shutdown'])
    power.emit(event);
  assert.equal(wakes(), 0);
});

test('unsubscribe stops wakes and removes the listeners', () => {
  const { power, unsubscribe, wakes } = setup();
  unsubscribe();
  power.emit('resume');
  power.emit('unlock-screen');
  assert.equal(wakes(), 0);
  assert.equal(power.listenerCount('resume') + power.listenerCount('unlock-screen'), 0);
});

test('a throwing wake does not throw out of the emitter', () => {
  const { power, wakes } = setup(() => {
    throw new Error('engine closed');
  });
  assert.doesNotThrow(() => power.emit('resume'));
  assert.doesNotThrow(() => power.emit('unlock-screen'));
  assert.equal(wakes(), 2);
});

test('a rejecting async wake is swallowed, not an unhandled rejection', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const power = new EventEmitter();
    let wakes = 0;
    watchPowerResume(power, {
      wake: async () => {
        wakes++;
        throw new Error('engine closed');
      },
    });
    assert.doesNotThrow(() => power.emit('resume'));
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(wakes, 1);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

/** A clock whose 1 s ticks run on `advance`, and whose wall time can jump with no ticks (a sleeping Mac). */
function fakeClock() {
  let time = 1_000_000;
  let tick: (() => void) | undefined;
  return {
    now: () => time,
    every: (run: () => void) => {
      tick = run;
      return 1;
    },
    cancel: () => void (tick = undefined),
    advance(ms: number) {
      for (let spent = 0; spent < ms; spent += 1000) {
        time += 1000;
        tick?.();
      }
    },
    /** The Mac slept: wall time moved, then the first tick after waking ran. */
    sleep(ms: number) {
      time += ms;
      tick?.();
    },
    skip: (ms: number) => void (time += ms),
    hasTimer: () => tick !== undefined,
  };
}

function withClock() {
  const clock = fakeClock();
  const power = new EventEmitter();
  let wakes = 0;
  const stop = watchPowerResume(power, { wake: () => void wakes++ }, clock);
  return { clock, power, stop, wakes: () => wakes };
}

test('a 31 s wall-clock jump calls wake once; 30 s and steady ticks do not', () => {
  const { clock, wakes } = withClock();
  clock.advance(10_000);
  clock.sleep(29_000);
  clock.sleep(30_000);
  assert.equal(wakes(), 0);
  clock.sleep(31_000);
  assert.equal(wakes(), 1);
  clock.advance(10_000);
  assert.equal(wakes(), 1);
});

test('a resume event and the clock-jump fallback together are one wake, in either order', () => {
  const resumeFirst = withClock();
  resumeFirst.clock.skip(31_000);
  resumeFirst.power.emit('resume');
  resumeFirst.clock.advance(1000);
  assert.equal(resumeFirst.wakes(), 1);

  const tickFirst = withClock();
  tickFirst.clock.sleep(31_000);
  tickFirst.clock.skip(2000);
  tickFirst.power.emit('resume');
  tickFirst.power.emit('unlock-screen');
  assert.equal(tickFirst.wakes(), 1);
});

test('wakes more than the dedupe window apart are separate wakes', () => {
  const { clock, power, wakes } = withClock();
  power.emit('resume');
  clock.advance(DEDUPE_MS);
  power.emit('unlock-screen');
  assert.equal(wakes(), 2);
});

test('unsubscribe cancels the fallback timer too', () => {
  const { clock, stop, wakes } = withClock();
  assert.equal(clock.hasTimer(), true);
  stop();
  assert.equal(clock.hasTimer(), false);
  clock.sleep(60_000);
  assert.equal(wakes(), 0);
});

test('a clock that moves backwards does not suppress the next wake', () => {
  const { clock, power, wakes } = withClock();
  power.emit('resume');
  clock.skip(-60_000);
  power.emit('unlock-screen');
  assert.equal(wakes(), 2);
});
