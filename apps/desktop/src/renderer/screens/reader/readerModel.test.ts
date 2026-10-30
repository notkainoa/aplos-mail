/**
 * The reader's pure decisions: J and K over a list that keeps changing, who is next when a thread leaves, which
 * buffered letters are dropped, and the per-letter interface state. Run:
 * `cd apps/desktop && npx tsx --test 'src/renderer/screens/reader/**\/*.test.ts*'`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY_BUFFER, reduce } from './model/letterBuffer';
import { afterRemoval, crumbPosition, staleReady, stepMessage, stepThread } from './readerModel';
import { readerHeader } from './readerHeader';
import { freshUi, reduceFor, reduceUi, uiFor, walkableIds } from './readerUi';

const IDS = ['a', 'b', 'c', 'd'];

test('J and K step through the list and stop at the ends', () => {
  assert.equal(stepThread(IDS, 'b', 'next'), 'c');
  assert.equal(stepThread(IDS, 'b', 'previous'), 'a');
  assert.equal(stepThread(IDS, 'd', 'next'), null, 'never wraps');
  assert.equal(stepThread(IDS, 'a', 'previous'), null);
  assert.equal(stepThread([], 'a', 'next'), null);
});

test('a thread that is not in the list goes to the first row on J, and stays put on K', () => {
  assert.equal(stepThread(IDS, 'zzz', 'next'), 'a');
  assert.equal(stepThread(IDS, null, 'next'), 'a');
});

test('five J presses in a row land five threads down, one per press', () => {
  const ids = ['t1', 't2', 't3', 't4', 't5', 't6', 't7'];
  let at: string | null = 't1';
  for (let press = 0; press < 5; press++) at = stepThread(ids, at, 'next');
  assert.equal(at, 't6');
});

test('Done hands the reader to the next thread, else the one above, else back to the list', () => {
  assert.equal(afterRemoval(IDS, 'b'), 'c');
  assert.equal(afterRemoval(IDS, 'd'), 'c', 'the last thread falls back to the one above');
  assert.equal(afterRemoval(['only'], 'only'), null);
  assert.equal(afterRemoval([], 'x'), null);
});

test('the crumb counts from one and is absent for a thread outside the list', () => {
  assert.deepEqual(crumbPosition(IDS, 'c'), { index: 3, of: 4 });
  assert.equal(crumbPosition(IDS, 'zzz'), null);
  assert.equal(crumbPosition(IDS, null), null);
});

test('only letters that are on paper or asked for stay buffered', () => {
  let state = EMPTY_BUFFER;
  state = reduce(state, { type: 'want', id: 'a', now: 0 });
  state = reduce(state, { type: 'ready', id: 'a', now: 1 });
  state = reduce(state, { type: 'ready', id: 'b', now: 2 });
  state = reduce(state, { type: 'ready', id: 'c', now: 3 });
  assert.deepEqual(staleReady(state).sort(), ['b', 'c']);
});

test('the message rail stops at the ends', () => {
  const ids = ['m1', 'm2', 'm3'];
  assert.equal(stepMessage(ids, 'm1', 'next'), 'm2');
  assert.equal(stepMessage(ids, 'm3', 'next'), 'm3');
  assert.equal(stepMessage(ids, 'm1', 'previous'), 'm1');
  assert.equal(stepMessage(ids, null, 'next'), 'm1');
  assert.equal(stepMessage([], null, 'next'), null);
});

test('O walks the earlier messages only while they are expanded', () => {
  assert.deepEqual(walkableIds(['m1', 'm2'], false, 'm3'), ['m3']);
  assert.deepEqual(walkableIds(['m1', 'm2'], true, 'm3'), ['m1', 'm2', 'm3']);
  assert.deepEqual(walkableIds([], true, null), []);
});

test('the letter state: expand, open, find, images, and a new thread starts untouched', () => {
  let ui = freshUi('t1');
  ui = reduceUi(ui, { type: 'toggleExpanded' });
  assert.equal(ui.expanded, true);
  ui = reduceUi(ui, { type: 'openMessage', id: 'm1' });
  ui = reduceUi(ui, { type: 'openMessage', id: 'm1' });
  assert.deepEqual(ui.opened, ['m1']);
  assert.equal(ui.cursor, 'm1');
  ui = reduceUi(ui, { type: 'openFind' });
  assert.equal(ui.find, '');
  ui = reduceUi(ui, { type: 'setFind', query: 'invoice' });
  ui = reduceUi(ui, { type: 'openFind' });
  assert.equal(ui.find, 'invoice', 'opening find again keeps the query');
  ui = reduceUi(ui, { type: 'closeFind' });
  assert.equal(ui.find, null);
  ui = reduceUi(ui, { type: 'loadImages', id: 'm9' });
  assert.deepEqual(ui.imagesLoaded, ['m9']);

  const next = reduceFor(ui, { threadId: 't2', event: { type: 'toggleExpanded' } });
  assert.equal(next.threadId, 't2');
  assert.equal(next.expanded, true, 'the event applies to the fresh state of t2');
  assert.deepEqual(next.opened, []);
  assert.equal(uiFor(next, 't1').expanded, false, 'another thread draws its own untouched state');
});

test('the pane header: back with Esc, "1 of 16", J/K disabled at the ends, at most three tools', () => {
  const header = readerHeader({
    origin: 'Home',
    position: crumbPosition(IDS, 'a'),
    subject: 'A quieter home',
    summaryScrolledAway: false,
    hasPrevious: false,
    hasNext: true,
    back: () => undefined,
  });
  assert.equal(header.lead?.kind, 'back');
  assert.equal(header.lead?.commandId, 'nav.back');
  assert.deepEqual(header.crumb?.position, { index: 1, of: 4 });
  assert.equal(header.tools?.length, 3);
  assert.equal(header.tools?.[0]?.disabled, true);
  assert.equal(header.tools?.[1]?.disabled, false);
});
