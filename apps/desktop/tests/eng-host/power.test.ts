import test from 'node:test';
import assert from 'node:assert/strict';
import { createPowerWatch, DEDUPE_MS, type WakeReason } from '../../src/host/power';

/** A clock whose 1 s ticks run on `advance`, and whose wall time can jump without ticks (a sleeping Mac). */
function fakeClock() {
  let time = 1_000_000;
  let tick: (() => void) | undefined;
  const wakes: WakeReason[] = [];
  const watch = createPowerWatch({
    now: () => time,
    every: run => {
      tick = run;
      return 1;
    },
    cancel: () => void (tick = undefined),
    wake: reason => void wakes.push(reason),
  });
  return {
    watch,
    wakes,
    advance(ms: number) {
      for (let spent = 0; spent < ms; spent += 1000) {
        time += 1000;
        tick?.();
      }
    },
    sleep(ms: number) {
      time += ms;
      tick?.();
    },
    set: (ms: number) => void (time += ms),
  };
}

test('a 31 s clock jump wakes the engine exactly once; 29 s and steady ticks do not', () => {
  const clock = fakeClock();
  clock.watch.start();
  clock.advance(10_000);
  clock.sleep(29_000);
  assert.deepEqual(clock.wakes, []);
  clock.sleep(31_000);
  assert.deepEqual(clock.wakes, ['clock-jump']);
  clock.advance(10_000);
  assert.equal(clock.wakes.length, 1);
});

test('a resume event plus the fallback is one wake, in either order', () => {
  const resumeFirst = fakeClock();
  resumeFirst.watch.start();
  resumeFirst.set(31_000);
  resumeFirst.watch.noteSystemEvent('resume');
  resumeFirst.advance(1000);
  assert.deepEqual(resumeFirst.wakes, ['resume']);

  const tickFirst = fakeClock();
  tickFirst.watch.start();
  tickFirst.sleep(31_000);
  tickFirst.set(2000);
  tickFirst.watch.noteSystemEvent('resume');
  assert.deepEqual(tickFirst.wakes, ['clock-jump']);
});

test('resume and unlock-screen are separate wakes once the dedupe window has passed', () => {
  const clock = fakeClock();
  clock.watch.start();
  clock.watch.noteSystemEvent('resume');
  clock.advance(DEDUPE_MS);
  clock.watch.noteSystemEvent('unlock-screen');
  assert.deepEqual(clock.wakes, ['resume', 'unlock-screen']);
});

test('stop ends the fallback', () => {
  const clock = fakeClock();
  clock.watch.start();
  clock.watch.stop();
  clock.sleep(60_000);
  assert.deepEqual(clock.wakes, []);
});
