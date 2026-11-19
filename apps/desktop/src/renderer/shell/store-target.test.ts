import test from 'node:test';
import assert from 'node:assert/strict';
import { addTargetSlot, getTarget, sameTarget } from './store-target';
import type { TargetSummary } from '../commands';

const thread: TargetSummary = { kind: 'thread', id: 't1', title: 'Drew Bell', detail: 'Art' };
const event: TargetSummary = { kind: 'event', id: 'e1', title: 'Lunch' };

test('the latest-mounted setter with a target wins, and leaving restores the one before', () => {
  const outer = addTargetSlot();
  outer.set(thread);
  const inner = addTargetSlot();
  inner.set(event);
  assert.equal(getTarget()?.id, 'e1');
  inner.remove();
  assert.equal(getTarget()?.id, 't1');
  outer.remove();
  assert.equal(getTarget(), null);
});

test('null clears only that setter and keeps its place in the order', () => {
  const outer = addTargetSlot();
  outer.set(thread);
  const inner = addTargetSlot();
  inner.set(event);
  inner.set(null);
  assert.equal(getTarget()?.id, 't1');
  outer.set(null);
  inner.set(event);
  assert.equal(getTarget()?.id, 'e1');
  inner.remove();
  outer.remove();
});

test('targets compare by value: an equal copy keeps the snapshot reference', () => {
  const slot = addTargetSlot();
  slot.set(thread);
  const first = getTarget();
  slot.set({ ...thread });
  assert.equal(getTarget(), first);
  slot.set({ ...thread, detail: 'Other' });
  assert.notEqual(getTarget(), first);
  slot.remove();
  assert.ok(sameTarget(null, null));
  assert.ok(!sameTarget(thread, null));
});
