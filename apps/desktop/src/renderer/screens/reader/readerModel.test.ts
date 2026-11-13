/**
 * The reader's pure decisions: J and K over a list that keeps changing, who is next when a thread leaves, which
 * buffered letters are dropped, and the per-letter interface state. Run:
 * `cd apps/desktop && npx tsx --test 'src/renderer/screens/reader/**\/*.test.ts*'`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY_BUFFER, reduce } from './model/letterBuffer';
import {
  NO_MEMORY,
  afterRemoval,
  crumbPlace,
  crumbPosition,
  staleReady,
  stepMessage,
  stepThread,
  walkList,
} from './readerModel';
import { focusDecision, placeOf } from './readerFocus';
import { readerHeader } from './readerHeader';
import { expandEvent, freshUi, reduceFor, reduceUi, uiFor, walkableIds } from './readerUi';

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

test('a thread that is not in the list starts the walk at an end: J the first row, K the last', () => {
  assert.equal(stepThread(IDS, 'zzz', 'previous'), 'd');
  assert.equal(stepThread(IDS, null, 'previous'), 'd');
  assert.equal(stepThread([], 'zzz', 'previous'), null);
});

test('a thread that left the list keeps its place, so J and Done choose its neighbour, not the top row', () => {
  const seen = walkList(NO_MEMORY, IDS, 'c');
  assert.deepEqual(seen.walk, IDS);
  // another device handled c: the list no longer has it
  const gone = walkList(seen.memory, ['a', 'b', 'd'], 'c');
  assert.deepEqual(gone.walk, IDS, 'c is put back where it was');
  assert.equal(stepThread(gone.walk, 'c', 'next'), 'd');
  assert.equal(stepThread(gone.walk, 'c', 'previous'), 'b');
  assert.equal(afterRemoval(gone.walk, 'c'), 'd');
  // the last row left: the row above is the neighbour
  const last = walkList(walkList(NO_MEMORY, IDS, 'd').memory, ['a', 'b', 'c'], 'd');
  assert.equal(stepThread(last.walk, 'd', 'previous'), 'c');
  assert.equal(afterRemoval(last.walk, 'd'), 'c');
  // the whole list went: nothing to step to, so the reader goes back
  const none = walkList(seen.memory, [], 'c');
  assert.equal(afterRemoval(none.walk, 'c'), null);
  assert.equal(stepThread(none.walk, 'c', 'next'), null);
});

test('a thread opened from elsewhere gets no remembered place, and a new open thread starts a new memory', () => {
  const outside = walkList(NO_MEMORY, IDS, 'zzz');
  assert.deepEqual(outside.walk, IDS);
  assert.equal(stepThread(outside.walk, 'zzz', 'next'), 'a');
  const moved = walkList(walkList(NO_MEMORY, IDS, 'c').memory, ['a', 'b', 'd'], 'b');
  assert.deepEqual(moved.walk, ['a', 'b', 'd']);
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

test('the screen counts a thread outside the list as its first, so every reader shows the crumb', () => {
  assert.deepEqual(crumbPlace(IDS, 'c'), { index: 3, of: 4 });
  assert.deepEqual(crumbPlace(IDS, 'zzz'), { index: 1, of: 5 });
  assert.equal(crumbPlace(IDS, null), null);
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

test('the arrow keys walk every message, oldest first: the earlier ones are compact cards, always there', () => {
  assert.deepEqual(walkableIds(['m1', 'm2'], 'm3'), ['m1', 'm2', 'm3']);
  assert.deepEqual(walkableIds([], 'm1'), ['m1']);
  assert.deepEqual(walkableIds([], null), []);
});

test('O folds or opens the earlier card the cursor is on; on the latest message it shows the quoted text', () => {
  const earlier = ['m1', 'm2'];
  assert.deepEqual(expandEvent('m2', earlier), { type: 'toggleMessage', id: 'm2' });
  assert.deepEqual(expandEvent('m3', earlier), { type: 'toggleExpanded' }, 'the latest message');
  assert.deepEqual(
    expandEvent(null, earlier),
    { type: 'toggleExpanded' },
    'no cursor yet: the latest',
  );
  assert.deepEqual(expandEvent(null, []), { type: 'toggleExpanded' }, 'a one-message thread');
  let ui = reduceUi(freshUi('t1'), {
    type: 'moveCursor',
    ids: ['m1', 'm2', 'm3'],
    dir: 'previous',
  });
  assert.equal(
    ui.cursor,
    'm2',
    'ArrowUp from the start (the latest holds the rail) lands on the card above',
  );
  ui = reduceUi(ui, expandEvent(ui.cursor, earlier));
  assert.deepEqual(ui.opened, ['m2'], 'O opens the focused card');
  ui = reduceUi(ui, expandEvent(ui.cursor, earlier));
  assert.deepEqual(ui.opened, [], 'O again folds it');
  const down = reduceUi(freshUi('t1'), {
    type: 'moveCursor',
    ids: ['m1', 'm2', 'm3'],
    dir: 'next',
  });
  assert.equal(down.cursor, 'm3', 'ArrowDown from the start stays on the latest');
});

test('focus moves the cursor to the card, without opening it and without a loop', () => {
  let ui = freshUi('t1');
  ui = reduceUi(ui, { type: 'focusMessage', id: 'm2' });
  assert.equal(ui.cursor, 'm2');
  assert.deepEqual(ui.opened, [], 'focus alone opens nothing');
  assert.equal(
    reduceUi(ui, { type: 'focusMessage', id: 'm2' }),
    ui,
    'the same card again is no new state',
  );
  const stepped = reduceUi(ui, { type: 'moveCursor', ids: ['m1', 'm2', 'm3'], dir: 'previous' });
  assert.equal(stepped.cursor, 'm1', 'an arrow key moves on from the focused card');
  assert.deepEqual(
    reduceUi(ui, expandEvent(ui.cursor, ['m1', 'm2'])).opened,
    ['m2'],
    'O then acts on it',
  );
});

test('the letter state: quoted text, opening and folding a card, find, images, and a new thread starts untouched', () => {
  let ui = freshUi('t1');
  ui = reduceUi(ui, { type: 'toggleExpanded' });
  assert.equal(ui.expanded, true);
  ui = reduceUi(ui, { type: 'toggleMessage', id: 'm1' });
  assert.deepEqual(ui.opened, ['m1'], 'a click opens the compact card');
  assert.equal(ui.cursor, 'm1');
  ui = reduceUi(ui, { type: 'toggleMessage', id: 'm2' });
  ui = reduceUi(ui, { type: 'toggleMessage', id: 'm1' });
  assert.deepEqual(ui.opened, ['m2'], 'a second click on the same card folds it again');
  assert.equal(ui.cursor, 'm1');
  ui = reduceUi(ui, { type: 'toggleMessage', id: 'm2' });
  assert.deepEqual(ui.opened, []);
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

test('focus: the reader root takes focus only when it was dropped or sat on a letter that left the paper', () => {
  assert.equal(focusDecision('dropped'), 'root');
  assert.equal(focusDecision('offPaper'), 'root');
  assert.equal(focusDecision('paper'), 'keep');
  assert.equal(focusDecision('reader'), 'keep');
  assert.equal(
    focusDecision('elsewhere'),
    'keep',
    'the reader never pulls focus back from the sidebar or a dialog',
  );
});

test('focus: where the focused element is, against a reader root', () => {
  const element = (parent: unknown = null, paper?: boolean) => {
    const self = {
      parent,
      paper,
      contains: (other: unknown) => {
        for (let at = other as typeof self | null; at; at = at.parent as typeof self | null) {
          if (at === self) return true;
        }
        return false;
      },
      closest: (_selector: string) => {
        for (let at = self as typeof self | null; at; at = at.parent as typeof self | null) {
          if (at.paper !== undefined) return at;
        }
        return null;
      },
      getAttribute: (_name: string) => (self.paper ? 'true' : 'false'),
    };
    return self as unknown as Element;
  };
  const body = element();
  const root = element();
  const paperLetter = element(root, true);
  const offLetter = element(root, false);
  const place = (active: Element | null) => placeOf({ active, body, root });
  assert.equal(place(null), 'dropped');
  assert.equal(place(body), 'dropped');
  assert.equal(place(element(paperLetter)), 'paper');
  assert.equal(place(element(offLetter)), 'offPaper');
  assert.equal(place(root), 'reader');
  assert.equal(place(element(root)), 'reader');
  assert.equal(place(element()), 'elsewhere');
});

test('find: every ⌘F counts, so a second one refocuses the field; closing it keeps the query out', () => {
  let ui = reduceUi(freshUi('t'), { type: 'openFind' });
  assert.equal(ui.find, '');
  assert.equal(ui.findFocus, 1);
  ui = reduceUi(ui, { type: 'setFind', query: 'invoice' });
  ui = reduceUi(ui, { type: 'openFind' });
  assert.equal(ui.find, 'invoice', 'the query stays');
  assert.equal(ui.findFocus, 2, 'and the field is asked to take focus again');
  assert.equal(reduceUi(ui, { type: 'closeFind' }).find, null);
});
