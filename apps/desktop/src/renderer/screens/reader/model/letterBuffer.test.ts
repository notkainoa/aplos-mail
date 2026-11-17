/**
 * The reader's "no blank sheet" double buffer: the want/ready/evict rules, the 1.5 s loading line, prefetch
 * targets, and a seeded fuzz of 500 J/K moves with late, missing and out-of-order bodies. Run:
 * `cd apps/desktop && npx tsx --test 'src/renderer/screens/reader/model/*.test.ts'`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { moveCursor, type CursorState } from './threadCursor';
import {
  EMPTY_BUFFER,
  LOAD_LINE_MS,
  prefetchTargets,
  reduce,
  view,
  type LetterState,
} from './letterBuffer';

const ids = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`);
const want = (state: LetterState, id: string, now: number): LetterState =>
  reduce(state, { type: 'want', id, now });
const readyAt = (state: LetterState, id: string, now: number): LetterState =>
  reduce(state, { type: 'ready', id, now });

test('the first letter keeps the sheet blank until its body is ready, and the line waits 1.5 s', () => {
  let state = want(EMPTY_BUFFER, 'a', 1000);
  assert.deepEqual(view(state, 1000), { letter: null, loadingLine: false, blank: true });
  assert.equal(view(state, 1000 + LOAD_LINE_MS - 1).loadingLine, false, 'just under the deadline');
  assert.equal(view(state, 1000 + LOAD_LINE_MS).loadingLine, true, 'at the deadline');
  state = readyAt(state, 'a', 3000);
  assert.deepEqual(view(state, 3000), { letter: 'a', loadingLine: false, blank: false });
});

test('an immediate want puts the letter on paper at once: the first letter, or one that replaces a letter sent away', () => {
  let state = reduce(EMPTY_BUFFER, { type: 'want', id: 'a', now: 0, immediate: true });
  assert.deepEqual(view(state, 0), { letter: 'a', loadingLine: false, blank: false });
  state = readyAt(state, 'a', 10);
  state = reduce(state, { type: 'want', id: 'b', now: 20, immediate: true });
  assert.equal(state.shown, 'b', 'the letter that left is not kept while b loads');
  assert.equal(
    view(state, 20 + LOAD_LINE_MS).loadingLine,
    false,
    'b is on paper: nothing is waited for',
  );
  state = readyAt(state, 'b', 30);
  assert.equal(state.shown, 'b');
});

test('a want told again as immediate (Done pressed while the next letter loads) takes the paper at once', () => {
  let state = readyAt(want(EMPTY_BUFFER, 'a', 0), 'a', 10);
  state = want(state, 'b', 100);
  assert.equal(state.shown, 'a');
  state = reduce(state, { type: 'want', id: 'b', now: 200, immediate: true });
  assert.equal(state.shown, 'b', 'a, which was sent away, leaves the paper');
  assert.equal(state.wantedSince, 100, 'the wait for b is the same one');
});

test('moving on keeps the previous letter on paper until the next body is ready', () => {
  let state = readyAt(want(EMPTY_BUFFER, 'a', 0), 'a', 10);
  state = want(state, 'b', 100);
  assert.equal(state.shown, 'a', 'no blank sheet between letters');
  assert.equal(state.wantedSince, 100);
  state = readyAt(state, 'b', 200);
  assert.equal(state.shown, 'b');
});

test('a stale ready is remembered, never shown, and a later want of it is instant', () => {
  let state = readyAt(want(EMPTY_BUFFER, 'a', 0), 'a', 10);
  state = want(state, 'b', 100);
  const shown = state.shown;
  state = readyAt(state, 'c', 200);
  assert.equal(state.shown, shown, 'a ready for an unwanted id changes nothing on paper');
  assert.equal(state.ready.has('c'), true);
  state = want(state, 'c', 300);
  assert.equal(state.shown, 'c', 'a remembered body shows in the same event');
});

test('a body prefetched before any want is remembered, and the first letter can be instant', () => {
  const state = readyAt(EMPTY_BUFFER, 'a', 5);
  assert.equal(state.ready.has('a'), true);
  assert.deepEqual(view(state, 5), { letter: null, loadingLine: false, blank: true });
  assert.equal(want(state, 'a', 20).shown, 'a');
});

test('the wait deadline resets only when the wanted letter changes', () => {
  let state = readyAt(want(EMPTY_BUFFER, 'a', 0), 'a', 10);
  state = want(state, 'b', 100);
  state = want(state, 'b', 500);
  assert.equal(
    state.wantedSince,
    100,
    'asking for the same letter again does not restart the wait',
  );
  assert.equal(view(state, 100 + LOAD_LINE_MS).loadingLine, true);
  state = want(state, 'd', 2000);
  assert.equal(state.wantedSince, 2000);
  assert.equal(view(state, 2000 + LOAD_LINE_MS - 1).loadingLine, false);
});

test('the line is never up while the wanted letter is on paper', () => {
  const state = readyAt(want(EMPTY_BUFFER, 'a', 0), 'a', 10_000);
  assert.equal(view(state, 10_000 + LOAD_LINE_MS * 10).loadingLine, false);
});

test('evict forgets a held body, and the letter on paper stays', () => {
  let state = readyAt(want(EMPTY_BUFFER, 'a', 0), 'a', 10);
  state = readyAt(state, 'b', 20);
  state = reduce(state, { type: 'evict', id: 'a' });
  assert.equal(state.shown, 'a', 'evicting the shown letter is not a blank sheet');
  assert.equal(state.ready.has('a'), false);
  state = want(state, 'b', 100);
  assert.equal(state.shown, 'b', 'b is still held');
  state = want(state, 'a', 200);
  assert.equal(state.shown, 'b', 'a forgotten body waits again');
  assert.equal(view(state, 200 + LOAD_LINE_MS).loadingLine, true);
});

test('prefetchTargets lists neighbours nearest first, cursor and ready bodies excluded', () => {
  const list = ids(10);
  const none = new Set<string>();
  assert.deepEqual(prefetchTargets(list, 't5', 2, none), ['t6', 't4', 't7', 't3']);
  assert.deepEqual(prefetchTargets(list, 't5', 2, new Set(['t6', 't3'])), ['t4', 't7']);
  assert.deepEqual(prefetchTargets(list, 't0', 2, none), ['t1', 't2'], 'the top has one side');
  assert.deepEqual(prefetchTargets(list, 't9', 3, none), ['t8', 't7', 't6']);
  assert.deepEqual(prefetchTargets(list, 't5', 1, none), ['t6', 't4']);
  assert.deepEqual(prefetchTargets(list, 'gone', 2, none), []);
  assert.deepEqual(prefetchTargets(list, null, 2, none), []);
});

/** A tiny seeded PRNG (mulberry32) so a failing run replays exactly. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 0x100000000;
  };
}

test('fuzz: 500 J/K moves with late, missing and out-of-order bodies never show a blank or wrong letter', () => {
  for (let seed = 1; seed <= 50; seed++) {
    const next = mulberry32(seed);
    const list = ids(40);
    let cursor: CursorState = { ids: list, current: list[0] ?? null };
    let state: LetterState = EMPTY_BUFFER;
    let now = 0;
    const pending: { at: number; id: string }[] = [];
    const everShown = new Set<string>();

    const check = (label: string) => {
      const drawn = view(state, now);
      const allowed = new Set(everShown);
      if (state.wanted !== null && state.ready.has(state.wanted)) allowed.add(state.wanted);
      if (drawn.letter === null) {
        assert.equal(everShown.size, 0, `${label}: the sheet went blank after a letter was shown`);
      } else {
        assert.ok(
          allowed.has(drawn.letter),
          `${label}: paper shows ${drawn.letter}, never shown nor wanted-and-ready`,
        );
        everShown.add(drawn.letter);
      }
      if (state.wanted === state.shown) {
        assert.equal(
          drawn.loadingLine,
          false,
          `${label}: line up while the wanted letter is on paper`,
        );
      }
      if (state.wanted !== state.shown && state.wantedSince !== null) {
        assert.equal(
          view(state, state.wantedSince + LOAD_LINE_MS - 1).loadingLine,
          false,
          `${label}: the line came up before 1.5 s on the same letter`,
        );
        assert.equal(
          view(state, state.wantedSince + LOAD_LINE_MS).loadingLine,
          true,
          `${label}: the line is not up at 1.5 s of continuous wait`,
        );
      }
      assert.equal(
        drawn.blank,
        drawn.letter === null,
        `${label}: blank disagrees with empty paper`,
      );
    };

    for (let move = 0; move < 500; move++) {
      now += Math.floor(next() * 400);
      pending.sort((a, b) => a.at - b.at);
      while (pending.length > 0 && (pending[0]?.at ?? 0) <= now) {
        const body = pending.shift();
        if (body === undefined) break;
        const shownBefore = state.shown;
        const wantedBefore = state.wanted;
        state = reduce(state, { type: 'ready', id: body.id, now: body.at });
        if (body.id !== wantedBefore) {
          assert.equal(
            state.shown,
            shownBefore,
            `seed ${seed}: a stale ready for ${body.id} moved the paper`,
          );
        }
        check(`seed ${seed} ready ${body.id}`);
      }
      cursor = moveCursor(cursor, next() < 0.5 ? 'next' : 'previous');
      if (cursor.current === null) continue;
      state = reduce(state, { type: 'want', id: cursor.current, now });
      const latency = next() < 0.1 ? Number.POSITIVE_INFINITY : next() * 2500;
      if (Number.isFinite(latency)) pending.push({ at: now + latency, id: cursor.current });
      check(`seed ${seed} want ${cursor.current}`);
    }
  }
});
