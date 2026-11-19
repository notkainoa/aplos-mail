/**
 * The bulk pick: X flips, ⇧X picks the run from the anchor, ⌘A picks all, Esc clears; pruning a list whose
 * rows left, and a seeded fuzz over rows arriving and leaving. Run:
 * `cd apps/desktop && npx tsx --test 'src/renderer/screens/lists/selection.test.ts'`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NO_SELECTION,
  clear,
  extendTo,
  isPicking,
  pickedInOrder,
  prune,
  selectAll,
  toggle,
} from './selection';

const ids = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`);

test('toggle flips the row and moves the anchor to it either way', () => {
  const on = toggle(NO_SELECTION, 't1');
  assert.deepEqual([...on.picked], ['t1']);
  assert.equal(on.anchor, 't1');
  const off = toggle(on, 't1');
  assert.equal(off.picked.size, 0);
  assert.equal(off.anchor, 't1', 'unpicking keeps the anchor for ⇧X');
  assert.equal(isPicking(off), false);
});

test('extendTo picks the run either direction and keeps the anchor', () => {
  const list = ids(6);
  let sel = toggle(NO_SELECTION, 't1');
  sel = extendTo(sel, list, 't3');
  assert.deepEqual(pickedInOrder(sel, list), ['t1', 't2', 't3']);
  assert.equal(sel.anchor, 't1', '⇧X pivots on the same row');
  sel = extendTo(sel, list, 't0');
  assert.deepEqual(pickedInOrder(sel, list), ['t0', 't1', 't2', 't3']);
  assert.equal(sel.anchor, 't1');
});

test('extendTo keeps picks outside the run and ignores a cursor outside the list', () => {
  const list = ids(5);
  let sel = toggle(toggle(NO_SELECTION, 't4'), 't0');
  sel = extendTo(sel, list, 't2');
  assert.deepEqual(pickedInOrder(sel, list), ['t0', 't1', 't2', 't4']);
  assert.equal(extendTo(sel, list, 'gone'), sel, 'the same object when the cursor is not a row');
});

test('extendTo without an anchor picks just the cursor and anchors there', () => {
  const list = ids(4);
  const fresh = extendTo(NO_SELECTION, list, 't2');
  assert.deepEqual(pickedInOrder(fresh, list), ['t2']);
  assert.equal(fresh.anchor, 't2');
  const drifted = extendTo({ picked: new Set(['t0']), anchor: 'gone' }, list, 't3');
  assert.deepEqual(pickedInOrder(drifted, list), ['t0', 't3']);
  assert.equal(drifted.anchor, 't3');
});

test('selectAll picks the whole list anchored on the first row, and clear restores nothing', () => {
  const list = ids(3);
  const sel = selectAll(list);
  assert.deepEqual(pickedInOrder(sel, list), list);
  assert.equal(sel.anchor, 't0');
  assert.equal(selectAll([]).anchor, null);
  assert.equal(clear(), NO_SELECTION);
});

test('prune forgets rows that left and is the same object when nothing did', () => {
  const list = ids(5);
  let sel = toggle(toggle(NO_SELECTION, 't3'), 't1');
  assert.equal(prune(sel, list), sel, 'no row left: no new object');
  const shorter = ['t0', 't3', 't4'];
  sel = prune(sel, shorter);
  assert.deepEqual(pickedInOrder(sel, shorter), ['t3'], 't1 left the list');
  assert.equal(sel.anchor, null, 'the anchor row left too');
  const anchored = prune({ picked: new Set(['t0', 't1']), anchor: 't0' }, list);
  assert.equal(anchored.anchor, 't0');
});

test('pickedInOrder reports the pick in list order, not pick order', () => {
  const list = ids(4);
  const sel = toggle(toggle(toggle(NO_SELECTION, 't2'), 't0'), 't3');
  assert.deepEqual(pickedInOrder(sel, list), ['t0', 't2', 't3']);
});

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('fuzz: rows leaving and arriving never corrupt the pick', () => {
  const next = mulberry32(42);
  let list = ids(50);
  let extra = 1000;
  let sel = NO_SELECTION;
  for (let step = 0; step < 2000; step++) {
    const roll = next();
    if (roll < 0.35) {
      const id =
        next() < 0.8 && list.length > 0 ? list[Math.floor(next() * list.length)] : `x${extra++}`;
      sel = toggle(sel, id);
    } else if (roll < 0.55 && list.length > 0) {
      sel = extendTo(sel, list, list[Math.floor(next() * list.length)]);
    } else if (roll < 0.6) {
      sel = selectAll(list);
    } else if (roll < 0.65) {
      sel = clear();
    } else if (roll < 0.7) {
      sel = prune(sel, list);
    } else if (roll < 0.85 && list.length > 0) {
      list = list.filter((_, i) => i !== Math.floor(next() * list.length));
    } else {
      const at = Math.floor(next() * (list.length + 1));
      list = [...list.slice(0, at), `n${extra++}`, ...list.slice(at)];
    }
    const pruned = prune(sel, list);
    for (const id of pruned.picked) {
      assert.ok(list.includes(id), `step ${step}: a picked id is not in the list`);
    }
    const ordered = pickedInOrder(sel, list);
    assert.equal(new Set(ordered).size, ordered.length, `step ${step}: a duplicate pick`);
    let last = -1;
    for (const id of ordered) {
      const at = list.indexOf(id);
      assert.ok(at > last, `step ${step}: pickedInOrder is not in list order`);
      last = at;
    }
    assert.ok(
      pruned.anchor === null || list.includes(pruned.anchor),
      `step ${step}: the anchor is not in the list`,
    );
  }
});
