// The Low-importance sheet's Done key: a tap is one done, a hold is all done.
// Run: cd apps/desktop && npx tsx --test src/renderer/ui/list/internal/doneHold.test.ts

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createDoneHold } from './doneHold';

/** A hold over a clock the test advances by hand. */
function rig() {
  const log: string[] = [];
  let now = 0;
  let pending: { at: number; run: () => void } | null = null;
  const hold = createDoneHold({
    holdMs: 600,
    onOne: () => log.push('one'),
    onAll: () => log.push('all'),
    onHolding: on => log.push(on ? 'holding' : 'idle'),
    setTimer: (run, ms) => (pending = { at: now + ms, run }),
    clearTimer: () => (pending = null),
  });
  const advance = (ms: number) => {
    now += ms;
    const due = pending;
    if (due && due.at <= now) {
      pending = null;
      due.run();
    }
  };
  return { hold, log, advance, armed: () => pending !== null };
}

describe('Done key hold', () => {
  test('a tap marks one row done', () => {
    const { hold, log, advance } = rig();
    hold.press();
    advance(120);
    hold.release();
    assert.deepEqual(log, ['holding', 'idle', 'one']);
  });

  test('holding for the full time marks all done once; the keyup after it does nothing', () => {
    const { hold, log, advance } = rig();
    hold.press();
    advance(599);
    assert.deepEqual(log, ['holding']);
    advance(1);
    hold.release();
    assert.deepEqual(log, ['holding', 'idle', 'all']);
  });

  test('key repeat does not restart the clock', () => {
    const { hold, log, advance } = rig();
    hold.press();
    advance(400);
    hold.press();
    advance(200);
    assert.deepEqual(log, ['holding', 'idle', 'all']);
  });

  test('stop (Esc, blur, unmount) marks nothing, and the next keyup is ignored', () => {
    const { hold, log, advance, armed } = rig();
    hold.press();
    advance(300);
    hold.stop();
    assert.equal(armed(), false);
    hold.release();
    advance(1000);
    assert.deepEqual(log, ['holding', 'idle']);
  });

  test('a keyup without a keydown (the sheet opened with the key down) does nothing', () => {
    const { hold, log } = rig();
    hold.release();
    assert.deepEqual(log, []);
  });
});
