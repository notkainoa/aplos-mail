/**
 * The reader's thread cursor: J/K clamping, settling under arrivals and removals, de-duplication and position.
 * Run: `cd apps/desktop && npx tsx --test 'src/renderer/screens/reader/model/*.test.ts'`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { moveCursor, positionOf, settleCursor, type CursorState } from './threadCursor';

const ids = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`);
const cursor = (list: readonly string[], current: string | null): CursorState => ({
  ids: list,
  current,
});

test('moveCursor steps one thread, stops at the ends, and never wraps', () => {
  const list = ids(3);
  assert.equal(
    moveCursor(cursor(list, null), 'next').current,
    't0',
    'a null cursor starts at the top',
  );
  assert.equal(moveCursor(cursor(list, 't0'), 'next').current, 't1');
  assert.equal(moveCursor(cursor(list, 't2'), 'next').current, 't2', 'the last row clamps');
  assert.equal(moveCursor(cursor(list, 't0'), 'previous').current, 't0', 'the first row clamps');
  assert.equal(
    moveCursor(cursor(list, 'gone'), 'previous').current,
    't0',
    'off the list starts at the top',
  );
  assert.deepEqual(moveCursor(cursor([], 't0'), 'next'), { ids: [], current: null });
});

test('settleCursor keeps a thread that is still there, wherever it moved', () => {
  const list = ids(5);
  assert.equal(settleCursor(cursor(list, 't2'), ['t9', ...list]).current, 't2', 'an arrival above');
  assert.equal(settleCursor(cursor(list, 't2'), [...list, 't9']).current, 't2', 'an arrival below');
  assert.equal(settleCursor(cursor(list, 't2'), ['t2', 't0', 't1']).current, 't2', 'a re-order');
});

test('settleCursor hands a vanished thread to the surviving row below it, then above, then first', () => {
  const list = ids(5);
  assert.equal(settleCursor(cursor(list, 't2'), ['t0', 't1', 't3', 't4']).current, 't3');
  assert.equal(
    settleCursor(cursor(list, 't2'), ['t0', 't1', 't4']).current,
    't4',
    'the nearest survivor below, skipping one that also left',
  );
  assert.equal(
    settleCursor(cursor(list, 't4'), ['t0', 't1', 't3']).current,
    't3',
    'the last row leaves: the nearest above',
  );
  assert.equal(
    settleCursor(cursor(list, 't1'), ['t0', 't2']).current,
    't2',
    'below wins over above when both survive',
  );
  assert.equal(
    settleCursor(cursor(['a', 'b'], 'a'), ['z']).current,
    'z',
    'no old neighbour survives: the first row',
  );
  assert.equal(settleCursor(cursor(list, 't2'), []).current, null);
  assert.equal(
    settleCursor(cursor([], null), ids(2)).current,
    't0',
    'a null cursor takes the first row',
  );
});

test('duplicate ids are de-duplicated keeping the first occurrence', () => {
  const duped = ['t0', 't1', 't0', 't2', 't1'];
  const settled = settleCursor(cursor([], null), duped);
  assert.deepEqual(settled.ids, ['t0', 't1', 't2']);
  assert.equal(settled.current, 't0');
  const moved = moveCursor(cursor(duped, 't1'), 'next');
  assert.deepEqual(moved.ids, ['t0', 't1', 't2'], 'the stored list is de-duplicated too');
  assert.equal(moved.current, 't2', 'the step counts each id once');
  assert.deepEqual(positionOf(cursor(duped, 't1')), { index: 1, total: 3 });
});

test('positionOf reports a 0-based index and the total, null without a cursor', () => {
  assert.deepEqual(positionOf(cursor(ids(40), 't7')), { index: 7, total: 40 });
  assert.equal(positionOf(cursor(ids(40), null)), null);
  assert.equal(positionOf(cursor([], 't0')), null, 'a cursor off the list has no position');
});
