/**
 * Home's bulk pick on the stand-in engine, in node with no DOM: X, ⇧X, ⌘A and Esc through the registry, the focus
 * letter's neighbours (the Low band is never picked), one `act` and one Undo toast for a bulk Done, the trash question,
 * and a cursor that mail arriving cannot move. Run: `cd apps/desktop && npx tsx --test 'src/renderer/screens/home/*.test.ts*'`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createFixtureEngine, defaultNow } from '@aplos/contract-fixture';
import { createAppRegistry, DEFAULT_KEY_PREFS, type CommandContext } from '../../commands';
import { connectDataLayer } from '../../data/connect';
import { createManualScheduler, createManualTimers } from '../../data/scheduler';
import { api, setClock, type ThreadRow } from '../../data';
import { harnessClock } from '../../data/clock';
import { getToasts, resetToasts } from '../../shell/store-toast';
import { dismissToast, pushToast, runToastAction } from '../../shell';
import { shellRegistryFor } from '../../shell/ShellRegistry';
import { ListRow } from '../../ui/list';
import { MAX_FLYING } from '../lists/bulkActions';
import type { Confirmation } from '../lists/listActions';
import {
  NO_SELECTION,
  clear,
  extendTo,
  pickedInOrder,
  selectAll,
  toggle,
} from '../lists/selection';
import { settled, type RawPick } from '../lists/useBulk';
import { createHomeActions, type HomeDeps } from './homeActions';
import { homeBarActions, commandsForHome } from './homeCommands';
import {
  LOW_KEY,
  buildItems,
  orderLayout,
  pickableIds,
  settleCursor,
  suggestedCommand,
  type HomeItem,
  type HomeLayout,
} from './homeModel';
import { listRowProps } from './homeRows';

const nextTask = () => new Promise<void>(resolve => setImmediate(resolve));

async function settleAll(flush: () => void) {
  for (let i = 0; i < 20; i++) {
    await nextTask();
    flush();
  }
}

async function boot() {
  const engine = createFixtureEngine({ scenario: 'demo', clock: defaultNow });
  const scheduler = createManualScheduler();
  const connection = connectDataLayer({
    session: engine.connect(),
    scheduler,
    timers: createManualTimers(defaultNow),
  });
  const home = connection.layer.windows.acquire({ kind: 'home' });
  for (const name of ['accounts', 'counts', 'settings'] as const) {
    connection.layer.session.want(name);
  }
  setClock(harnessClock);
  await settleAll(() => scheduler.flush());
  return { connection, home };
}

type World = Awaited<ReturnType<typeof boot>>;
type Snap = ReturnType<World['home']['snapshot']>;

function sectionIds(snap: Snap, key: string): string[] {
  const section = snap.sections.find(s => s.key === key);
  if (!section) return [];
  const from = section.start - snap.position;
  return snap.ids.slice(from, from + section.count);
}

function layoutOf(snap: Snap): HomeLayout {
  return {
    do: sectionIds(snap, 'do'),
    fromLater: sectionIds(snap, 'fromLater'),
    update: sectionIds(snap, 'update'),
    follow: sectionIds(snap, 'follow'),
    lowCount: snap.sections.find(s => s.key === 'low')?.count ?? 0,
  };
}

/** Home's deps with a stand-in pick (the real one is `useBulk`, which needs React state). */
function bulkHome(world: World, start: string | null = null) {
  const cursor = { key: start };
  const state = {
    raw: { selection: NO_SELECTION, everything: false } as RawPick,
    confirmation: null as Confirmation | null,
    acted: [] as Parameters<typeof api.thread.act>[0][],
    committed: [] as string[],
    held: 0,
    more: [] as string[],
    departed: [] as (string | undefined)[],
  };
  const rowOf = (id: string) => world.home.snapshot().rows.get(id) as ThreadRow | undefined;
  const itemsNow = (): HomeItem[] =>
    buildItems(orderLayout(layoutOf(world.home.snapshot()), rowOf, false));
  const idsNow = () => pickableIds(itemsNow());
  const setPick = (selection: typeof NO_SELECTION, everything = false) => {
    state.raw = { selection, everything };
  };
  const live = () => settled(state.raw, idsNow());
  const deps: HomeDeps = {
    snapshot: () => {
      const items = itemsNow();
      const picked = pickedInOrder(live(), pickableIds(items));
      const key = cursor.key ?? pickableIds(items)[0] ?? null;
      const snap = world.home.snapshot();
      return {
        items,
        key,
        rowOf,
        state: snap.state,
        picked: picked.length > 0 ? picked : undefined,
      };
    },
    setCursor: (key, departed) => {
      cursor.key = key;
      state.departed.push(departed);
    },
    act: args => {
      state.acted.push(args);
      return api.thread.act(args);
    },
    push: pushToast,
    dismiss: dismissToast,
    hold: { extend: () => void state.held++ },
    bulk: {
      selection: {
        toggle: id => setPick(toggle(live(), id)),
        extendTo: id => setPick(extendTo(live(), idsNow(), id)),
        selectAll: () => setPick(selectAll(idsNow()), true),
        clear: () => setPick(clear()),
      },
      confirmation: () => state.confirmation,
      setConfirmation: next => {
        state.confirmation = next;
      },
    },
    commit: (kind, _hold, rowId) => void state.committed.push(`${kind}:${rowId}`),
    offerReminder: () => undefined,
    reminderOffer: () => null,
    openDatePicker: () => undefined,
    openThread: () => undefined,
    openLow: () => undefined,
    oneByOne: () => undefined,
    openMore: () => void state.more.push('row'),
    openBulkMore: () => void state.more.push('bulk'),
    undoLabel: (_id, fallback) => fallback,
    forward: () => undefined,
  };
  const picked = () => pickedInOrder(live(), idsNow());
  return { deps, state, cursor, picked, itemsNow, idsNow, actions: createHomeActions(deps) };
}

type Bulk = ReturnType<typeof bulkHome>;

/** Keys through the real registry, on Home's stack, with `selection` set while rows are picked. */
function keyboardFor(bulk: Bulk) {
  const registry = createAppRegistry();
  const extra = {
    oneByOne: () => {},
    more: () => bulk.actions.more(),
    why: () => {},
    undo: () => {},
  };
  const detach = shellRegistryFor(registry).register(commandsForHome(bulk.actions, extra));
  const context = (): CommandContext => ({
    stack: ['global', 'list', 'home'],
    target: null,
    selection: [],
    conditions: bulk.picked().length > 0 ? { selection: true } : {},
    prefs: DEFAULT_KEY_PREFS,
    focus: 'none',
  });
  const resolve = (key: string, mods: { shiftKey?: boolean; metaKey?: boolean } = {}) =>
    registry.resolve(
      { key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods },
      context(),
    );
  const press = (key: string, mods: { shiftKey?: boolean; metaKey?: boolean } = {}) => {
    const resolution = resolve(key, mods);
    assert.ok(resolution, `${key} resolves`);
    return registry.run(resolution.commandId, context()).status;
  };
  return { press, resolve, detach };
}

const onHome = (world: World, id: string) => world.home.snapshot().ids.includes(id);

test('X, ⇧X, ⌘A and Esc pick, extend, pick everything and clear; arrows only move the cursor', async () => {
  resetToasts();
  const world = await boot();
  try {
    const bulk = bulkHome(world);
    const keys = keyboardFor(bulk);
    const ids = bulk.idsNow();
    assert.equal(keys.resolve('Escape')?.commandId, undefined, 'Esc is not Clear with no picks');
    keys.press('x');
    assert.deepEqual(bulk.picked(), [ids[0]], 'X picks the row under the cursor');
    assert.equal(bulk.cursor.key, null, 'and the cursor stays');
    keys.press('j');
    keys.press('ArrowDown');
    assert.equal(bulk.cursor.key, ids[2]);
    assert.deepEqual(bulk.picked(), [ids[0]], 'arrows add nothing to the pick');
    assert.equal(bulk.state.acted.length, 0, 'and archive nothing, even with picks');
    keys.press('x', { shiftKey: true });
    assert.deepEqual(bulk.picked(), ids.slice(0, 3), '⇧X picks the run from the anchor');
    assert.equal(keys.resolve('Escape')?.commandId, 'list.clearSelection');
    keys.press('Escape');
    assert.deepEqual(bulk.picked(), [], 'Esc clears');
    keys.press('a', { metaKey: true });
    assert.deepEqual(bulk.picked(), ids, '⌘A picks every loaded row');
    assert.equal(bulk.state.acted.length, 0);
    keys.detach();
  } finally {
    world.connection.close();
  }
});

test('the Low band is never picked: X on it does nothing, ⇧X steps over it, ⌘A leaves it out', async () => {
  resetToasts();
  const world = await boot();
  try {
    const bulk = bulkHome(world, LOW_KEY);
    const items = bulk.itemsNow();
    assert.ok(
      items.some(item => item.kind === 'low'),
      'the demo has a band',
    );
    bulk.actions.select();
    bulk.actions.selectRange();
    assert.deepEqual(bulk.picked(), [], 'X and ⇧X on the band pick nothing');
    const layout = layoutOf(world.home.snapshot());
    const from = layout.update[0];
    const to = layout.follow[0];
    assert.ok(from && to, 'the demo has updates and a follow-up');
    bulk.cursor.key = from;
    bulk.actions.select();
    bulk.cursor.key = to;
    bulk.actions.selectRange();
    const ids = bulk.idsNow();
    assert.deepEqual(
      bulk.picked(),
      ids.slice(ids.indexOf(from), ids.indexOf(to) + 1),
      'the run crosses the band and holds only threads',
    );
    bulk.actions.selectAll();
    assert.equal(bulk.picked().length, items.filter(item => item.kind === 'row').length);
    assert.ok(!bulk.picked().includes(LOW_KEY));
  } finally {
    world.connection.close();
  }
});

test('Done on a pick sends one act and one toast; Undo brings every row back', async () => {
  resetToasts();
  const world = await boot();
  try {
    const bulk = bulkHome(world);
    const before = bulk.idsNow();
    const picked = before.slice(0, 3);
    bulk.actions.select();
    bulk.actions.move(1);
    bulk.actions.select();
    bulk.actions.move(1);
    bulk.actions.select();
    assert.deepEqual(bulk.picked(), picked);
    bulk.actions.done();
    assert.equal(bulk.state.acted.length, 1, 'one act for three rows');
    assert.deepEqual(
      bulk.state.acted[0] && 'ids' in bulk.state.acted[0] && bulk.state.acted[0].ids,
      picked,
    );
    const toasts = getToasts().filter(toast => toast.kind === 'done');
    assert.equal(toasts.length, 1, 'one toast');
    assert.equal(toasts[0]?.message, 'Done · 3 emails');
    assert.deepEqual(
      toasts[0]?.actions?.map(action => action.id),
      ['undo'],
    );
    assert.deepEqual(bulk.picked(), [], 'the pick clears');
    assert.equal(bulk.cursor.key, before[3], 'the cursor lands on the nearest surviving row');
    assert.deepEqual(
      bulk.state.committed,
      picked.map(id => `done:${id}`),
      'the rows leaving fly',
    );
    assert.ok(
      picked.every(id => !onHome(world, id)),
      'the three rows left Home at once',
    );
    runToastAction(toasts[0]!.id, 'undo');
    assert.ok(
      picked.every(id => onHome(world, id)),
      'Undo restored all three',
    );
    await settleAll(() => undefined);
  } finally {
    world.connection.close();
  }
});

test('a bulk Done that includes the card names the card as the row that left, so Undo can hand it back', async () => {
  resetToasts();
  const world = await boot();
  try {
    const bulk = bulkHome(world);
    const before = bulk.idsNow();
    bulk.actions.select();
    bulk.actions.move(1);
    bulk.actions.select();
    bulk.actions.move(-1);
    assert.equal(bulk.cursor.key, before[0], 'the card is on the first picked mail');
    bulk.state.departed.length = 0;
    bulk.actions.done();
    assert.deepEqual(
      bulk.state.departed,
      [before[0]],
      'the cursor moved because the card mail left',
    );
  } finally {
    world.connection.close();
  }
});

test('a bulk Done that leaves the card alone names no departed row', async () => {
  resetToasts();
  const world = await boot();
  try {
    const bulk = bulkHome(world);
    const before = bulk.idsNow();
    bulk.actions.move(1);
    bulk.actions.move(1);
    bulk.actions.select();
    bulk.actions.move(1);
    bulk.actions.select();
    bulk.actions.move(-1);
    bulk.actions.move(-1);
    bulk.actions.move(-1);
    bulk.state.departed.length = 0;
    bulk.actions.done();
    assert.ok(before.length > 3);
    assert.deepEqual(bulk.state.departed, [undefined], 'the card was not among the picks');
  } finally {
    world.connection.close();
  }
});

test('a bulk commit flies at most six rows', async () => {
  resetToasts();
  const world = await boot();
  try {
    const bulk = bulkHome(world);
    assert.ok(bulk.idsNow().length > MAX_FLYING, 'the demo has more rows than the motion flies');
    bulk.actions.selectAll();
    bulk.actions.later();
    assert.equal(bulk.state.acted.length, 1);
    assert.equal(bulk.state.committed.length, MAX_FLYING);
    assert.equal(getToasts().filter(t => t.kind === 'later').length, 1);
  } finally {
    world.connection.close();
  }
});

test('a keyed Done (the letter or a hover button) is its own row even while others are picked', async () => {
  resetToasts();
  const world = await boot();
  try {
    const bulk = bulkHome(world);
    const [first, second] = bulk.idsNow();
    assert.ok(first && second);
    bulk.cursor.key = second;
    bulk.actions.select();
    bulk.cursor.key = first;
    bulk.actions.done(first);
    const sent = bulk.state.acted[0];
    assert.deepEqual(sent && 'ids' in sent && sent.ids, [first]);
    assert.deepEqual(bulk.picked(), [second], 'and the pick is untouched');
  } finally {
    world.connection.close();
  }
});

test('Space on an update keeps its meaning with picks: it acts on the cursor row only', async () => {
  resetToasts();
  const world = await boot();
  try {
    const bulk = bulkHome(world);
    const layout = layoutOf(world.home.snapshot());
    const update = layout.update[0];
    const other = layout.do[0];
    assert.ok(update && other, 'the demo has an update and a Do now row');
    // The demo's updates suggest nothing; make this one suggest Done, the way a delivery notice does.
    const rowOf = bulk.deps.snapshot;
    const patched: HomeDeps = {
      ...bulk.deps,
      snapshot: () => ({
        ...rowOf(),
        rowOf: id => {
          const row = rowOf().rowOf(id);
          const action = { kind: 'done', label: 'Done' };
          return row && id === update ? { ...row, summary: { ...row.summary, action } } : row;
        },
      }),
    };
    const actions = createHomeActions(patched);
    assert.equal(suggestedCommand(patched.snapshot().rowOf(update)!, 'update'), 'mail.done');
    bulk.cursor.key = other;
    actions.select();
    bulk.cursor.key = update;
    actions.suggested();
    assert.equal(bulk.state.acted.length, 1, 'one act');
    const sent = bulk.state.acted[0];
    assert.deepEqual(sent && 'ids' in sent && sent.ids, [update], 'on the cursor row alone');
    assert.deepEqual(bulk.picked(), [other], 'the pick is untouched');
  } finally {
    world.connection.close();
  }
});

test('Trash on a pick asks first; nothing moves until the owner answers, and Cancel changes nothing', async () => {
  resetToasts();
  const world = await boot();
  try {
    const bulk = bulkHome(world);
    const keys = keyboardFor(bulk);
    const before = bulk.idsNow();
    keys.press('x');
    keys.press('j');
    keys.press('x');
    keys.press('#', { shiftKey: true });
    assert.equal(bulk.state.confirmation?.kind, 'trashPicked');
    assert.equal(bulk.state.confirmation?.count, 2);
    assert.equal(bulk.state.acted.length, 0, 'nothing moved while it asks');
    bulk.actions.cancelConfirm();
    assert.equal(bulk.state.confirmation, null);
    assert.equal(bulk.picked().length, 2, 'Cancel keeps the pick');
    assert.equal(bulk.state.acted.length, 0);
    bulk.actions.trash();
    bulk.actions.confirm();
    assert.equal(bulk.state.acted.length, 1);
    assert.equal(getToasts().find(t => t.kind === 'trash')?.message, 'Moved to Trash · 2 emails');
    assert.deepEqual(bulk.picked(), []);
    assert.ok(before.slice(0, 2).every(id => !onHome(world, id)));
    keys.detach();
    await settleAll(() => undefined);
  } finally {
    world.connection.close();
  }
});

test('the bar names Done, Later and Trash, and a keyed Trash from the menu stays on its row', async () => {
  const world = await boot();
  try {
    const bulk = bulkHome(world);
    const bar = homeBarActions(bulk.actions);
    assert.deepEqual(
      bar.map(action => action.label),
      ['Done', 'Later', 'Trash'],
    );
    assert.deepEqual(
      bar.map(action => action.commandId),
      ['mail.done', 'mail.later', 'mail.trash'],
    );
    const [first, second] = bulk.idsNow();
    bulk.actions.select();
    bulk.actions.trash(second);
    assert.equal(bulk.state.confirmation, null, 'the menu on a row does not ask about the pick');
    assert.deepEqual(
      bulk.state.acted[0] && 'ids' in bulk.state.acted[0] && bulk.state.acted[0].ids,
      [second],
    );
    assert.deepEqual(bulk.picked(), [first]);
  } finally {
    world.connection.close();
  }
});

test('mail arriving above a pick never moves the cursor row, and the pick keeps its rows', () => {
  const row = (id: string): HomeItem => ({ kind: 'row', id, section: 'do' });
  const before = [row('a'), row('b'), row('c'), { kind: 'low' } as HomeItem];
  const after = [row('new'), ...before];
  assert.equal(settleCursor(before, after, 'b'), 'b', 'the cursor stays on its row');
  const raw: RawPick = { selection: toggle(NO_SELECTION, 'c'), everything: false };
  assert.deepEqual(
    [...settled(raw, pickableIds(after)).picked],
    ['c'],
    'the pick keeps its row when one arrives',
  );
  assert.deepEqual(
    [...settled(raw, pickableIds(before.slice(0, 2))).picked],
    [],
    'and forgets one that left',
  );
});

test('picked rows carry the pick state without a new row box', async () => {
  const world = await boot();
  try {
    const id = layoutOf(world.home.snapshot()).do[1]!;
    const row = world.home.snapshot().rows.get(id) as ThreadRow;
    const base = {
      domId: 'x',
      layout: 'home' as const,
      density: 'comfortable' as const,
      cursor: false,
      accounts: [],
      handlers: { onSelect: () => undefined, onOpen: () => undefined, onAction: () => undefined },
    };
    const plain = listRowProps(row, base);
    assert.equal(plain.picked, false);
    assert.equal(plain.picking, false);
    const picked = listRowProps(row, { ...base, picked: true, picking: true });
    assert.equal(picked.picked, true);
    assert.equal(picked.picking, true);
    const html = renderToStaticMarkup(createElement(ListRow, picked));
    assert.match(html, /data-picked="true"/);
    assert.match(html, /aria-selected="true"/);
    assert.doesNotMatch(renderToStaticMarkup(createElement(ListRow, plain)), /data-picked/);
  } finally {
    world.connection.close();
  }
});

test('Move to Trash acts on the rows Home asked about, and a single Done unpicks its row', async () => {
  resetToasts();
  const world = await boot();
  try {
    const bulk = bulkHome(world);
    const ids = bulk.idsNow();
    bulk.actions.select();
    bulk.actions.move(1);
    bulk.actions.select();
    bulk.actions.trash();
    assert.deepEqual(bulk.state.confirmation?.ids, ids.slice(0, 2));
    bulk.deps.bulk?.selection.clear();
    bulk.cursor.key = ids[4] ?? null;
    bulk.actions.select();
    bulk.actions.confirm();
    assert.equal(bulk.state.acted.length, 1);
    const sent = bulk.state.acted[0];
    assert.deepEqual(sent && 'ids' in sent && sent.ids, ids.slice(0, 2), 'not the new pick');
    // A single act on a picked row drops it from the pick.
    bulk.actions.done(ids[4]);
    assert.deepEqual(bulk.picked(), [], 'the row done on its own is unpicked');
    await settleAll(() => undefined);
  } finally {
    world.connection.close();
  }
});

test('⌘A on Home extends the hold, and the arrows run the bulk Done and Later while rows are picked', async () => {
  resetToasts();
  const world = await boot();
  try {
    const bulk = bulkHome(world);
    const keys = keyboardFor(bulk);
    keys.press('a', { metaKey: true });
    assert.equal(bulk.state.held, 1, 'the hold waits for arrivals');
    assert.equal(keys.resolve('ArrowRight')?.commandId, 'mail.done');
    assert.equal(keys.press('ArrowRight'), 'ran');
    assert.equal(bulk.state.acted.length, 1, '→ with picks is one bulk Done');
    keys.detach();
    await settleAll(() => undefined);
  } finally {
    world.connection.close();
  }
});

test('. opens the bulk More menu while rows are picked, else the cursor row’s menu', async () => {
  const world = await boot();
  try {
    const bulk = bulkHome(world);
    const keys = keyboardFor(bulk);
    assert.equal(keys.press('.'), 'ran');
    assert.deepEqual(bulk.state.more, ['row'], 'no picks: the row menu, as before');
    keys.press('x');
    keys.press('.');
    assert.deepEqual(bulk.state.more, ['row', 'bulk'], 'with picks: the bulk menu');
    keys.detach();
  } finally {
    world.connection.close();
  }
});
