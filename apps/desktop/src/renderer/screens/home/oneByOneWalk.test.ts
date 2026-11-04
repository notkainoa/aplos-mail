/**
 * The one-by-one walk: committing each thread in turn, J/K moving over rows that left, the "n of m" crumb,
 * and a seeded fuzz of commits and rows leaving. Run:
 * `cd apps/desktop && npx tsx --test 'src/renderer/screens/home/oneByOneWalk.test.ts'`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { afterCommit, currentId, isFinished, progress, startWalk, stepWalk } from './oneByOneWalk';

const ids = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`);

test('a walk commits each thread in turn and finishes', () => {
  const list = ids(5);
  const live = new Set(list);
  let walk = startWalk(list);
  for (let n = 0; n < 5; n++) {
    const current = currentId(walk, live);
    assert.equal(current, `t${n}`);
    live.delete(current);
    walk = afterCommit(walk, live);
  }
  assert.equal(isFinished(walk, live), true);
  assert.equal(currentId(walk, live), null);
  assert.equal(progress(walk, live), null);
});

test('K undoes J, and J at the end leaves the same walk', () => {
  const list = ids(3);
  const live = new Set(list);
  let walk = startWalk(list);
  walk = stepWalk(walk, live, 1);
  assert.equal(currentId(walk, live), 't1');
  walk = stepWalk(walk, live, -1);
  assert.equal(currentId(walk, live), 't0');
  walk = stepWalk(walk, live, 1);
  walk = stepWalk(walk, live, 1);
  assert.equal(stepWalk(walk, live, 1), walk, 'the same object at the tail');
  assert.equal(stepWalk(walk, live, -1) === walk, false, 'K still moves back');
});

test('a row acted elsewhere is skipped over, either way', () => {
  const list = ids(4);
  const live = new Set(['t0', 't2', 't3']);
  let walk = startWalk(list);
  assert.equal(currentId(walk, live), 't0');
  walk = stepWalk(walk, live, 1);
  assert.equal(currentId(walk, live), 't2', 'J hops the gap');
  walk = stepWalk(walk, live, -1);
  assert.equal(currentId(walk, live), 't0', 'K hops it back');
  const mid = { queue: list, index: 1 };
  assert.equal(currentId(mid, live), 't2', 'a dead slot under the index shows the next live');
});

test('afterCommit at the last live row goes back to the previous live one', () => {
  const list = ids(5);
  const walk = afterCommit({ queue: list, index: 4 }, new Set(['t0']));
  assert.equal(walk.index, 0);
  assert.equal(currentId(walk, new Set(['t0'])), 't0');
});

test('progress counts the walked past and the live: 3 of 5 after two commits', () => {
  const list = ids(5);
  const live = new Set(list);
  let walk = startWalk(list);
  live.delete('t0');
  walk = afterCommit(walk, live);
  live.delete('t1');
  walk = afterCommit(walk, live);
  assert.deepEqual(progress(walk, live), { index: 3, of: 5 });
  assert.equal(currentId(walk, live), 't2');
  live.delete('t3');
  assert.deepEqual(progress(walk, live), { index: 3, of: 4 }, 'a row gone ahead shrinks "of"');
});

test('an empty queue is already finished', () => {
  const live = new Set<string>();
  const walk = startWalk([]);
  assert.equal(currentId(walk, live), null);
  assert.equal(isFinished(walk, live), true);
  assert.equal(progress(walk, live), null);
  assert.deepEqual(afterCommit(walk, live), { queue: [], index: 0 });
  assert.equal(stepWalk(walk, live, 1), walk);
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

test('fuzz: the walk always stands on a live queue id or nothing', () => {
  const next = mulberry32(7);
  const queue = ids(40);
  const live = new Set(queue);
  let walk = startWalk(queue);
  for (let step = 0; step < 2000; step++) {
    const roll = next();
    if (roll < 0.3) {
      walk = stepWalk(walk, live, 1);
    } else if (roll < 0.55) {
      walk = stepWalk(walk, live, -1);
    } else if (roll < 0.8) {
      const current = currentId(walk, live);
      if (current !== null) {
        live.delete(current);
        walk = afterCommit(walk, live);
      }
    } else {
      const gone = queue[Math.floor(next() * queue.length)];
      live.delete(gone);
    }
    const current = currentId(walk, live);
    assert.ok(
      current === null || (live.has(current) && queue.includes(current)),
      `step ${step}: the walk stands off the queue or off the live`,
    );
    assert.ok(
      walk.index >= 0 && walk.index <= queue.length,
      `step ${step}: the index left the queue`,
    );
    const crumb = progress(walk, live);
    if (crumb !== null) {
      assert.ok(crumb.index >= 1 && crumb.index <= crumb.of, `step ${step}: a crumb off the count`);
    } else {
      assert.equal(isFinished(walk, live), true);
    }
  }
});
