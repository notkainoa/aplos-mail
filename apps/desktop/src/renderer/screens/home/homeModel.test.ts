/**
 * Home's pure logic: the order inside each section, the cursor stops, section jumps, the cursor under leaving and
 * arriving rows (a seeded fuzz of a triage burst with mail arriving), lanes and the suggested command.
 * Run: `cd apps/desktop && npx tsx --test 'src/renderer/screens/home/*.test.ts*'`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ThreadRow } from '../../data';
import { LIST_WINDOW } from '../lists/listModel';
import { primaryOf, secondaryOf, senderOf, subjectOf, summaryOf } from './homeRows';
import {
  LOW_KEY,
  buildItems,
  layoutOf as layoutOfView,
  showsLowBand,
  compareDoNow,
  compareFollow,
  compareUpdate,
  initialKey,
  jumpSection,
  keyOf,
  laneOf,
  neighbourIds,
  offersReminder,
  orderLayout,
  pageRequest,
  settleCursor,
  stepCursor,
  stepLane,
  suggestedCommand,
  type HomeItem,
  type HomeLayout,
  movedHome,
  settleHome,
} from './homeModel';

interface RowInit {
  id: string;
  dueBand?: number;
  importance?: 'important' | 'normal';
  dueDate?: string;
  at?: number;
  lane?: string;
  action?: string;
  replyStatus?: string;
  since?: number;
}

function row(init: RowInit): ThreadRow {
  return {
    id: init.id,
    lastDate: init.at ?? 1_000,
    rank: {
      lane: init.lane ?? 'do',
      importance: init.importance ?? 'normal',
      dueBand: init.dueBand ?? 3,
      source: 'heuristic',
    },
    workflow: { dueDate: init.dueDate, replyStatus: init.replyStatus, bookmarked: false },
    summary: {
      state: 'ready',
      action: init.action ? { kind: init.action, label: 'x' } : undefined,
    },
    follow: init.since === undefined ? undefined : { since: init.since },
  } as unknown as ThreadRow;
}

const layoutOf = (parts: Partial<HomeLayout>): HomeLayout => ({
  do: [],
  fromLater: [],
  update: [],
  follow: [],
  lowCount: 0,
  ...parts,
});

const lookup = (rows: ThreadRow[]) => {
  const byId = new Map(rows.map(r => [r.id, r]));
  return (id: string) => byId.get(id);
};

test('Do now orders by due band, then importance, then soonest due, then newest', () => {
  const rows = [
    row({ id: 'newest-undated', at: 900 }),
    row({ id: 'older-undated', at: 100 }),
    row({ id: 'band1-normal', dueBand: 1, dueDate: '2026-10-30' }),
    row({ id: 'band1-important', dueBand: 1, importance: 'important', dueDate: '2026-10-31' }),
    row({ id: 'overdue', dueBand: 0, dueDate: '2026-10-20' }),
    row({ id: 'band3-sooner', dueBand: 3, dueDate: '2026-11-04' }),
    row({ id: 'band3-later', dueBand: 3, dueDate: '2026-11-09' }),
  ];
  const sorted = [...rows].sort(compareDoNow).map(r => r.id);
  assert.deepEqual(sorted, [
    'overdue',
    'band1-important',
    'band1-normal',
    'band3-sooner',
    'band3-later',
    'newest-undated',
    'older-undated',
  ]);
});

test('Important updates sort important first then newest; Follow up the longest wait first', () => {
  const updates = [
    row({ id: 'u-new', at: 500 }),
    row({ id: 'u-imp-old', importance: 'important', at: 100 }),
    row({ id: 'u-old', at: 200 }),
  ];
  assert.deepEqual(
    [...updates].sort(compareUpdate).map(r => r.id),
    ['u-imp-old', 'u-new', 'u-old'],
  );
  const follows = [
    row({ id: 'f-6d', since: 20 }),
    row({ id: 'f-3d', since: 80 }),
    row({ id: 'f-9d', since: 5 }),
  ];
  assert.deepEqual(
    [...follows].sort(compareFollow).map(r => r.id),
    ['f-9d', 'f-6d', 'f-3d'],
  );
});

test('orderLayout sorts when free, returns the layout untouched while held, and keeps uncached ids last', () => {
  const rows = [row({ id: 'a', at: 1 }), row({ id: 'b', at: 9 })];
  const layout = layoutOf({ do: ['a', 'ghost', 'b'], fromLater: ['a'] });
  assert.deepEqual(orderLayout(layout, lookup(rows), false).do, ['b', 'a', 'ghost']);
  assert.equal(orderLayout(layout, lookup(rows), true), layout);
});

test('cursor stops run Do now, Back from Later, Important updates, the Low band, Follow up', () => {
  const items = buildItems(
    layoutOf({ do: ['d'], fromLater: ['l'], update: ['u'], follow: ['f'], lowCount: 4 }),
  );
  assert.deepEqual(items.map(keyOf), ['d', 'l', 'u', LOW_KEY, 'f']);
});

const homeOf = (total: number, low: number) => ({
  total,
  low: { count: low, names: [], moreSenders: 0 },
  sections: [],
});

test('the Low band shows at zero while the view has mail, judged on the view totals, not on the windowed ids', () => {
  // The owner saw one mixed list with no way into Low importance; an empty band still opens the sheet's empty state.
  // `sections: []` is a window that holds no ids yet: the totals still say Home has mail.
  assert.equal(showsLowBand(layoutOfView(homeOf(5, 0))), true);
  assert.equal(showsLowBand(layoutOfView(homeOf(0, 3))), true);
  assert.equal(
    showsLowBand(layoutOfView(homeOf(0, 0))),
    false,
    'an empty Home is the handled line',
  );
});

test('an empty band is a cursor stop to walk onto, but the cursor never settles on it', () => {
  const shown = (ids: string[]) => ({ ...layoutOf({ do: ids }), lowShown: true });
  const before = buildItems(shown(['a', 'u']));
  assert.deepEqual(before.map(keyOf), ['a', 'u', LOW_KEY]);
  assert.equal(before.at(-1)?.kind === 'low' && before.at(-1)?.kind === 'low', true);
  const after = buildItems(shown(['a']));
  assert.equal(settleCursor(before, after, 'u'), 'a', 'the row above, not the empty band');
  assert.equal(stepCursor(after, 'a', 1), LOW_KEY, 'but J reaches it, and Return opens the sheet');
  assert.deepEqual(buildItems(layoutOf({ lowCount: 2, do: ['a'] })).map(keyOf), ['a', LOW_KEY]);
});

test('the cursor starts on Do now, else Important updates, else Follow up, else the band', () => {
  assert.equal(initialKey(buildItems(layoutOf({ do: ['d'], update: ['u'] }))), 'd');
  assert.equal(
    initialKey(buildItems(layoutOf({ update: ['u'], follow: ['f'], lowCount: 2 }))),
    'u',
  );
  assert.equal(initialKey(buildItems(layoutOf({ follow: ['f'], lowCount: 2 }))), 'f');
  assert.equal(initialKey(buildItems(layoutOf({ lowCount: 2 }))), LOW_KEY);
  assert.equal(initialKey([]), null);
});

test('arrows stop at the ends and land on the band', () => {
  const items = buildItems(layoutOf({ do: ['d'], update: ['u'], follow: ['f'], lowCount: 1 }));
  assert.equal(stepCursor(items, 'd', -1), 'd');
  assert.equal(stepCursor(items, 'u', 1), LOW_KEY);
  assert.equal(stepCursor(items, LOW_KEY, 1), 'f');
  assert.equal(stepCursor(items, 'f', 1), 'f');
  assert.equal(stepCursor(items, 'gone', 1), 'd');
});

test('Tab and Shift-Tab jump between present sections, skip empty ones and wrap', () => {
  const all = buildItems(
    layoutOf({
      do: ['d1', 'd2'],
      fromLater: ['l'],
      update: ['u1', 'u2'],
      follow: ['f'],
      lowCount: 3,
    }),
  );
  assert.equal(jumpSection(all, 'd2', 1), 'u1');
  assert.equal(jumpSection(all, 'l', 1), 'u1', 'Back from Later is part of Do now');
  assert.equal(jumpSection(all, 'u2', 1), 'f', 'the band is not a Tab stop');
  assert.equal(jumpSection(all, 'f', 1), 'd1', 'wraps to Do now');
  assert.equal(jumpSection(all, 'd1', -1), 'f');
  assert.equal(jumpSection(all, LOW_KEY, 1), 'f');
  assert.equal(jumpSection(all, LOW_KEY, -1), 'u1');
  const noUpdates = buildItems(layoutOf({ do: ['d'], follow: ['f'] }));
  assert.equal(jumpSection(noUpdates, 'd', 1), 'f');
  assert.equal(jumpSection(buildItems(layoutOf({ lowCount: 2 })), LOW_KEY, 1), LOW_KEY);
});

test('a row that leaves hands the cursor to its neighbour; the rest of the list changes nothing', () => {
  const before = buildItems(layoutOf({ do: ['a', 'b', 'c'], update: ['u'] }));
  assert.equal(
    settleCursor(before, buildItems(layoutOf({ do: ['a', 'c'], update: ['u'] })), 'b'),
    'c',
  );
  assert.equal(
    settleCursor(before, buildItems(layoutOf({ do: ['a', 'b'], update: [] })), 'u'),
    'b',
  );
  assert.equal(
    settleCursor(before, buildItems(layoutOf({ do: ['new', 'a', 'b', 'c'] })), 'b'),
    'b',
  );
  assert.equal(settleCursor(before, [], 'b'), null);
  assert.equal(settleCursor([], before, null), 'a');
});

test('neighbours around the cursor, skipping the band, are what the hold pins', () => {
  const items = buildItems(layoutOf({ do: ['a', 'b'], update: ['u'], lowCount: 1, follow: ['f'] }));
  assert.deepEqual(neighbourIds(items, 'u', 1), ['b', 'u']);
  assert.deepEqual(neighbourIds(items, 'a', 2), ['a', 'b', 'u']);
  assert.deepEqual(neighbourIds(items, 'nope', 2), []);
});

test('lanes step one at a time and stop at the ends; an unknown lane has no controls', () => {
  assert.equal(stepLane('do', 'down'), 'update');
  assert.equal(stepLane('update', 'down'), 'low');
  assert.equal(stepLane('low', 'down'), null);
  assert.equal(stepLane('low', 'up'), 'update');
  assert.equal(stepLane('do', 'up'), null);
  assert.equal(laneOf(row({ id: 'x', lane: 'do' })), 'do');
  assert.equal(laneOf(row({ id: 'x', lane: 'someNewLane' })), null);
});

test('Space runs Reply on Follow up, Done on an update, and the summary action elsewhere', () => {
  assert.equal(suggestedCommand(row({ id: 'f', since: 1 }), 'follow'), 'mail.reply');
  assert.equal(suggestedCommand(row({ id: 'u', lane: 'update' }), 'update'), 'mail.done');
  assert.equal(suggestedCommand(row({ id: 'd', action: 'reply' }), 'do'), 'mail.reply');
  assert.equal(suggestedCommand(row({ id: 'd', action: 'link' }), 'do'), 'mail.open');
  assert.equal(suggestedCommand(row({ id: 'd', action: 'done' }), 'do'), 'mail.done');
});

test('Done offers the reminder on Follow up and on a thread awaiting a reply, never on one that needs yours', () => {
  assert.equal(offersReminder(row({ id: 'f' }), 'follow'), true);
  assert.equal(offersReminder(row({ id: 'n', replyStatus: 'needsReply' }), 'do'), false);
  assert.equal(offersReminder(row({ id: 'w', replyStatus: 'awaitingReply' }), 'update'), true);
  assert.equal(offersReminder(row({ id: 'p', replyStatus: 'none' }), 'do'), false);
});

// ---------------------------------------------------------------------------
// Fuzz: a triage burst with mail arriving never moves the row under the cursor
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface World {
  rows: Map<string, ThreadRow>;
  layout: HomeLayout;
  waiting: ThreadRow[];
  key: string | null;
  held: boolean;
  items: HomeItem[];
}

function build(world: World, layout: HomeLayout): void {
  world.layout = layout;
  world.items = buildItems(layout);
}

function arrive(world: World, rand: () => number, serial: number): void {
  const fresh = row({
    id: `new${serial}`,
    dueBand: Math.floor(rand() * 4),
    importance: rand() < 0.3 ? 'important' : 'normal',
    at: Math.floor(rand() * 10_000),
  });
  world.rows.set(fresh.id, fresh);
  if (world.held) {
    world.waiting.push(fresh);
    return;
  }
  const next = { ...world.layout, do: [...world.layout.do, fresh.id] };
  build(
    world,
    orderLayout(next, id => world.rows.get(id), false),
  );
}

function release(world: World): void {
  const merged = { ...world.layout, do: [...world.layout.do, ...world.waiting.map(r => r.id)] };
  world.waiting = [];
  world.held = false;
  build(
    world,
    orderLayout(merged, id => world.rows.get(id), false),
  );
}

function triage(world: World): void {
  const at = world.items.findIndex(item => keyOf(item) === world.key);
  const item = world.items[at];
  if (!item || item.kind !== 'row') return;
  const gone = (ids: readonly string[]) => ids.filter(id => id !== item.id);
  const before = world.items;
  build(world, {
    ...world.layout,
    do: gone(world.layout.do),
    fromLater: gone(world.layout.fromLater),
    update: gone(world.layout.update),
    follow: gone(world.layout.follow),
  });
  world.key = settleCursor(before, world.items, world.key);
}

test('fuzz: mail arriving during a triage burst never moves the row under the cursor', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const rand = mulberry32(seed);
    const initial = Array.from({ length: 6 + Math.floor(rand() * 8) }, (_, i) =>
      row({ id: `r${i}`, dueBand: Math.floor(rand() * 4), at: Math.floor(rand() * 10_000) }),
    );
    const world: World = {
      rows: new Map(initial.map(r => [r.id, r])),
      layout: layoutOf({}),
      waiting: [],
      key: null,
      held: false,
      items: [],
    };
    build(
      world,
      orderLayout(
        layoutOf({ do: initial.map(r => r.id), lowCount: 2 }),
        id => world.rows.get(id),
        false,
      ),
    );
    world.key = initialKey(world.items);
    for (let step = 0; step < 60; step++) {
      const before = { key: world.key, order: world.items.map(keyOf) };
      const roll = rand();
      let arrived = false;
      if (roll < 0.35) {
        arrived = true;
        arrive(world, rand, seed * 1000 + step);
      } else if (roll < 0.6) {
        world.held = true;
        triage(world);
      } else if (roll < 0.8) {
        world.held = true;
        world.key = stepCursor(world.items, world.key, rand() < 0.5 ? 1 : -1);
      } else if (roll < 0.9) {
        world.key = jumpSection(world.items, world.key, rand() < 0.5 ? 1 : -1);
      } else {
        release(world);
      }
      if (arrived) {
        assert.equal(world.key, before.key, `seed ${seed} step ${step}: arrival moved the cursor`);
        if (world.held)
          assert.deepEqual(
            world.items.map(keyOf),
            before.order,
            `seed ${seed} step ${step}: arrival reordered a held list`,
          );
      }
      const keys = world.items.map(keyOf);
      assert.equal(new Set(keys).size, keys.length, 'no duplicate stops');
      if (world.key !== null)
        assert.ok(keys.includes(world.key), `seed ${seed} step ${step}: cursor left the list`);
      else assert.equal(keys.length, 0);
    }
  }
});

test('pageRequest asks for the window around the cursor only when a view is longer than one window and the cursor nears its edge', () => {
  const total = 600;
  const window = { position: 0, loaded: LIST_WINDOW, total };
  assert.equal(pageRequest({ ...window, total: LIST_WINDOW, at: 199 }), null, 'one window fits');
  assert.equal(pageRequest({ ...window, at: -1 }), null, 'the cursor is not a loaded row');
  assert.equal(pageRequest({ ...window, at: 50 }), null, 'well inside');
  assert.equal(pageRequest({ ...window, at: 5 }), null, 'near the top of the whole view');
  const down = pageRequest({ ...window, at: 190 });
  assert.deepEqual(
    down,
    { start: 90, end: 290 },
    'near the end of the loaded rows: 200 around row 190',
  );
  const later = { position: 400, loaded: LIST_WINDOW, total };
  assert.equal(pageRequest({ ...later, at: 190 }), null, 'the window already reaches the end');
  assert.deepEqual(
    pageRequest({ ...later, at: 10 }),
    { start: 310, end: 510 },
    'near the top: back up',
  );
  const centred = pageRequest({ ...later, at: 10 });
  assert.ok(
    centred &&
      pageRequest({ position: centred.start, loaded: LIST_WINDOW, total, at: 100 }) === null,
  );
});

/** Walks a cursor down the whole view, answering each page request the way the engine does (a window of `LIST_WINDOW`). */
function walkWindow(total: number): { reached: number; asked: number } {
  let position = 0;
  let asked = 0;
  let reached = 0;
  for (let index = 0; index < total; index++) {
    for (let guard = 0; guard < 5; guard++) {
      const loaded = Math.min(LIST_WINDOW, total - position);
      const range = pageRequest({ position, loaded, total, at: index - position });
      if (!range) break;
      asked++;
      position = range.start;
    }
    if (index >= position && index < position + Math.min(LIST_WINDOW, total - position)) reached++;
  }
  return { reached, asked };
}

test('the Low importance sheet pages: every one of 230 and of 1000 threads is reached by stepping the cursor', () => {
  const small = walkWindow(230);
  assert.equal(
    small.reached,
    230,
    'all 230 threads were inside the window when the cursor was on them',
  );
  assert.ok(small.asked > 0, 'a second window was requested past the first 200');
  const large = walkWindow(1000);
  assert.equal(large.reached, 1000);
  assert.ok(large.asked >= 4 && large.asked < 100, 'a few pages, not one request per row');
  const fits = walkWindow(LIST_WINDOW);
  assert.deepEqual(fits, { reached: LIST_WINDOW, asked: 0 }, 'one window never asks');
});

test('a pending summary keeps the placeholder until the engine settles the row, then the subject alone', () => {
  const pending = {
    ...row({ id: 'p' }),
    subject: 'Print run',
    summary: { state: 'pending' },
  } as ThreadRow;
  // Pending means live or queued work: the card waits on the engine, never a clock (owner rule 2026-11-16).
  assert.deepEqual(summaryOf(pending), { state: 'pending', subject: 'Print run' });
  const failed = { ...pending, summary: { state: 'failed' } } as ThreadRow;
  assert.equal(summaryOf(failed).state, 'absent');
  const none = { ...pending, summary: { state: 'none' } } as ThreadRow;
  assert.equal(summaryOf(none).state, 'absent');
});

test('a row with no sender name and no subject still reads something', () => {
  const blank = { ...row({ id: 'b' }), subject: '', fromName: '', participants: [] } as ThreadRow;
  assert.equal(senderOf(blank), 'No sender');
  assert.equal(primaryOf(blank), 'No subject');
  assert.equal(subjectOf(blank), 'No subject');
  assert.deepEqual(summaryOf(blank), { state: 'absent', subject: 'No subject' });
  const named = { ...blank, subject: '  Lunch ', fromName: 'Ada' } as ThreadRow;
  assert.equal(senderOf(named), 'Ada');
  assert.equal(primaryOf(named), 'Lunch');
});

test("every list row's main line is the subject; a written summary follows it, muted", () => {
  // The one row rule for every list (owner decision 2026-11-16, DECISIONS; it replaces "summary or subject"):
  // `primaryOf` is always the subject, and `secondaryOf` is a ready or stale summary's text, else nothing.
  const base = { ...row({ id: 'r' }), subject: 'Print run' } as ThreadRow;
  for (const state of ['ready', 'stale'] as const) {
    const withSummary = {
      ...base,
      summary: { state, text: 'Ada asked about\n the invoice.' },
    } as ThreadRow;
    assert.equal(primaryOf(withSummary), 'Print run', `${state} never replaces the subject`);
    assert.equal(
      secondaryOf(withSummary),
      'Ada asked about the invoice.',
      'one line, whitespace folded',
    );
  }
  for (const state of ['pending', 'failed', 'none'] as const) {
    const without = { ...base, summary: { state, text: 'old words' } } as ThreadRow;
    assert.equal(primaryOf(without), 'Print run');
    assert.equal(secondaryOf(without), undefined, `${state} shows the subject alone`);
  }
  const empty = { ...base, summary: { state: 'ready', text: '  ' } } as ThreadRow;
  assert.equal(secondaryOf(empty), undefined, 'a ready row with no text shows the subject alone');
  assert.equal(secondaryOf({}), undefined, 'a row with no summary field shows the subject alone');
});

test('a bulk action that includes the card moves the cursor on, and Undo hands the card back', () => {
  const ids = ['a', 'b', 'c', 'd'];
  const before = buildItems(layoutOf({ do: ids }));
  const after = buildItems(layoutOf({ do: ['a', 'd'] }));
  // The card is on b; the pick is b and c; the survivor the bulk path chooses is d.
  const notes = movedHome([], 'b', 'd', 'b', 0);
  assert.deepEqual(notes, [{ key: 'b', to: 'd', at: 0 }]);
  const gone = settleHome(before, after, 'd', notes, 1_000);
  assert.equal(gone.key, 'd', 'the pick leaving does not disturb the cursor');
  assert.deepEqual(gone.displaced, notes, 'the note is kept while the mail is away');
  const back = settleHome(after, before, 'd', gone.displaced, 2_000);
  assert.equal(back.key, 'b', 'Undo puts the card back on the mail it was on');
  assert.deepEqual(back.displaced, []);
});

test('moving the cursor by hand, or waiting out the undo window, forgets the way back', () => {
  const before = buildItems(layoutOf({ do: ['a', 'b', 'c', 'd'] }));
  const after = buildItems(layoutOf({ do: ['a', 'd'] }));
  const notes = movedHome([], 'b', 'd', 'b', 0);
  assert.deepEqual(movedHome(notes, 'd', 'a', undefined, 1), [], 'a hand move clears the notes');
  assert.equal(movedHome(notes, 'd', 'd', undefined, 1), notes, 'a bump that stays put keeps them');
  const late = settleHome(after, before, 'd', notes, 31_000);
  assert.equal(late.key, 'd', 'a mail that returns after the window came back for another reason');
});
