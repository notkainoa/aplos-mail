// The frame deadline (html-4 host prerequisite): a frame that never reports times out to the failed state, a report
// after the timeout is refused, unmount cancels, and a new letter (or Try again) starts a fresh wait. Fake clock.
// Run: cd apps/desktop && npx tsx --test src/renderer/mailframe/deadline.test.ts

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createFrameDeadline, FRAME_TIMEOUT_MS, type DeadlineClock } from './deadline';

/** A clock that only moves when the test says so. */
function fakeClock() {
  let now = 0;
  let next = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const clock: DeadlineClock = {
    setTimeout(run, ms) {
      next += 1;
      timers.set(next, { at: now + ms, run });
      return next;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
  };
  const advance = (ms: number) => {
    now += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.at > now) continue;
      timers.delete(id);
      timer.run();
    }
  };
  return { clock, advance, pending: () => timers.size };
}

function setup(timeoutMs?: number) {
  const { clock, advance, pending } = fakeClock();
  const expired: string[] = [];
  const deadline = createFrameDeadline(key => void expired.push(key), timeoutMs, clock);
  return { deadline, expired, advance, pending };
}

describe('createFrameDeadline', () => {
  test('a frame that never reports expires after the default 10 s, not before', () => {
    const { deadline, expired, advance } = setup();
    assert.equal(FRAME_TIMEOUT_MS, 10_000);
    deadline.watch('m1');
    advance(9_999);
    assert.deepEqual(expired, []);
    advance(1);
    assert.deepEqual(expired, ['m1']);
    assert.equal(deadline.expired('m1'), true);
  });

  test('the timeout is configurable', () => {
    const { deadline, expired, advance } = setup(300);
    deadline.watch('m1');
    advance(300);
    assert.deepEqual(expired, ['m1']);
  });

  test('a report in time is accepted and stops the clock', () => {
    const { deadline, expired, advance, pending } = setup();
    deadline.watch('m1');
    advance(5_000);
    assert.equal(deadline.settle('m1'), true);
    assert.equal(pending(), 0);
    advance(60_000);
    assert.deepEqual(expired, []);
  });

  test('a report that arrives after the timeout is refused', () => {
    const { deadline, advance } = setup();
    deadline.watch('m1');
    advance(10_000);
    assert.equal(deadline.settle('m1'), false);
    assert.equal(deadline.settle('m1'), false, 'and stays refused');
  });

  test('unmount cancels: nothing expires afterwards', () => {
    const { deadline, expired, advance, pending } = setup();
    deadline.watch('m1');
    deadline.cancel();
    assert.equal(pending(), 0);
    advance(60_000);
    assert.deepEqual(expired, []);
  });

  test('a new letter resets the clock and drops the old wait', () => {
    const { deadline, expired, advance, pending } = setup();
    deadline.watch('m1');
    advance(9_000);
    deadline.watch('m2');
    assert.equal(pending(), 1);
    advance(9_000);
    assert.deepEqual(expired, []);
    advance(1_000);
    assert.deepEqual(expired, ['m2']);
  });

  test('Try again watches the same letter afresh and accepts its report', () => {
    const { deadline, expired, advance } = setup();
    deadline.watch('m1');
    advance(10_000);
    deadline.watch('m1');
    assert.equal(deadline.expired('m1'), false);
    advance(2_000);
    assert.equal(deadline.settle('m1'), true);
    assert.deepEqual(expired, ['m1']);
  });

  test('a letter that was never watched (plain text) settles at once', () => {
    const { deadline } = setup();
    assert.equal(deadline.settle('text'), true);
  });
});
