/**
 * The bulk pick's edges on the stand-in engine, in node: what ⌘A saw, the hold it starts, the rows a confirmed trash
 * moves, the counts a destructive question names, and a row acted on by itself leaving the pick. Run:
 * `cd apps/desktop && npx tsx --test 'src/renderer/screens/lists/bulkConfirm.test.ts'`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFixtureEngine, defaultNow } from '@aplos/contract-fixture';
import { connectDataLayer } from '../../data/connect';
import { createManualScheduler, createManualTimers } from '../../data/scheduler';
import { harnessClock } from '../../data/clock';
import { api, setClock } from '../../data';
import { dismissToast, pushToast } from '../../shell';
import { getToasts, resetToasts } from '../../shell/store-toast';
import { createAppRegistry, DEFAULT_KEY_PREFS, type CommandContext } from '../../commands';
import { shellRegistryFor } from '../../shell/ShellRegistry';
import { confirmedIds } from './bulkActions';
import { commandsForList } from './listCommands';
import { moreButtonIn } from './useBulkBar';
import { createListActions, type Confirmation, type ListDeps } from './listActions';
import { ALL_CONFIG, TRASH_CONFIG, viewSpecOf, type ListConfig } from './listKinds';
import { asListRow } from './listRows';
import { NO_SELECTION, extendTo, pickedInOrder, selectAll, toggle } from './selection';
import type { Selection } from './selection';
import { settled, threadSpecOf } from './useBulk';

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
  const windows = new Map(
    [ALL_CONFIG, TRASH_CONFIG].map(
      config => [config.kind, connection.layer.windows.acquire(viewSpecOf(config))] as const,
    ),
  );
  for (const name of ['accounts', 'counts', 'settings'] as const) {
    connection.layer.session.want(name);
  }
  setClock(harnessClock);
  await settleAll(() => scheduler.flush());
  return { connection, windows, flush: () => settleAll(() => scheduler.flush()) };
}

type World = Awaited<ReturnType<typeof boot>>;

/** A list's deps over the real data layer, with a stand-in pick. */
function listWorld(world: World, config: ListConfig) {
  const window = world.windows.get(config.kind)!;
  const cursor = { key: null as string | null };
  const state = {
    picks: NO_SELECTION as Selection,
    confirmation: null as Confirmation | null,
    acted: [] as Parameters<typeof api.thread.act>[0][],
    held: 0,
    opened: 0,
    beyond: 0,
  };
  const idsNow = () => window.snapshot().ids;
  const live = () => settled({ selection: state.picks, everything: false }, idsNow());
  const deps: ListDeps = {
    kind: config.kind,
    snapshot: () => {
      const snap = window.snapshot();
      const picked = pickedInOrder(live(), snap.ids);
      const scope = { loadedIds: snap.ids, total: snap.total + state.beyond, allPicked: false };
      const bulk = picked.length === 0 ? undefined : { ...scope, picked, state: snap.state };
      const spec = threadSpecOf(viewSpecOf(config));
      return {
        ids: snap.ids,
        key: cursor.key ?? snap.ids[0] ?? null,
        rowOf: id => asListRow(snap.rows.get(id)),
        bulk: bulk && { ...bulk, spec },
      };
    },
    setCursor: key => {
      cursor.key = key;
    },
    act: args => {
      state.acted.push(args);
      return api.thread.act(args);
    },
    selection: {
      toggle: id => void (state.picks = toggle(live(), id)),
      extendTo: id => void (state.picks = extendTo(live(), idsNow(), id)),
      selectAll: () => void (state.picks = selectAll(idsNow())),
      clear: () => void (state.picks = NO_SELECTION),
    },
    discardDraft: async () => undefined,
    canDeleteForever: () => true,
    deleteForever: async () => undefined,
    push: pushToast,
    dismiss: dismissToast,
    hold: { extend: () => void state.held++ },
    open: () => undefined,
    openMore: () => void state.opened++,
    confirmation: () => state.confirmation,
    setConfirmation: next => {
      state.confirmation = next;
    },
    undoLabel: (_id, fallback) => fallback,
  };
  return { deps, state, cursor, window, actions: createListActions(deps) };
}

test('⌘A keeps the rows it saw: mail that arrives after it is not picked, and a view past the window still follows', () => {
  const frozen = { ids: ['a', 'b'], state: null, total: 2, beyond: false };
  const all = { selection: selectAll(['a', 'b']), everything: true, frozen };
  const after = settled(all, ['new', 'a', 'b']);
  assert.deepEqual([...after.picked], ['a', 'b'], 'the arrival is left out');
  assert.deepEqual([...settled(all, ['new', 'b']).picked], ['b'], 'a row that left is forgotten');
  const past = { ...all, frozen: { ...frozen, total: 500, beyond: true } };
  assert.deepEqual(
    [...settled(past, ['c', 'd']).picked],
    ['c', 'd'],
    'the selector covers a slide',
  );
});

test('⌘A extends the hold, so mail arriving while the view is picked waits', async () => {
  const world = await boot();
  try {
    const list = listWorld(world, ALL_CONFIG);
    list.actions.selectAll();
    assert.equal(list.state.held, 1);
  } finally {
    world.connection.close();
  }
});

test('Move to Trash acts on the rows the owner was asked about, not on whatever is picked by then', async () => {
  resetToasts();
  const world = await boot();
  try {
    const list = listWorld(world, ALL_CONFIG);
    const ids = [...list.window.snapshot().ids];
    list.actions.select();
    list.actions.move(1);
    list.actions.select();
    list.actions.trash();
    assert.deepEqual(list.state.confirmation?.ids, ids.slice(0, 2));
    list.deps.selection?.clear();
    list.cursor.key = ids[5] ?? null;
    list.actions.select();
    list.actions.confirm();
    assert.equal(list.state.acted.length, 1);
    const sent = list.state.acted[0];
    assert.deepEqual(sent && 'ids' in sent && sent.ids, ids.slice(0, 2), 'not the new pick');
    assert.equal(getToasts().find(t => t.kind === 'trash')?.message, 'Moved to Trash · 2 emails');
    await world.flush();
  } finally {
    world.connection.close();
  }
});

test('a confirmed trash keeps only the asked-about rows that are still loaded', () => {
  assert.deepEqual(confirmedIds(['a', 'b', 'c'], ['c', 'x', 'a']), ['a', 'c']);
  assert.deepEqual(confirmedIds(['a', 'b'], ['x']), [], 'nothing left, nothing to move');
});

test('delete forever names the rows it acts on, never the view total', async () => {
  const world = await boot();
  try {
    const list = listWorld(world, TRASH_CONFIG);
    list.state.beyond = 300;
    list.actions.selectAll();
    list.actions.trash();
    const loaded = list.window.snapshot().ids.length;
    assert.equal(list.state.confirmation?.kind, 'deleteForever');
    assert.equal(list.state.confirmation?.count, loaded);
    assert.equal(list.state.confirmation?.ids.length, loaded);
  } finally {
    world.connection.close();
  }
});

test('a row acted on by itself leaves the pick, so a held row is not picked again', async () => {
  resetToasts();
  const world = await boot();
  try {
    const list = listWorld(world, ALL_CONFIG);
    const ids = [...list.window.snapshot().ids];
    list.actions.select();
    list.actions.move(1);
    list.actions.select();
    list.actions.done(ids[0]);
    assert.deepEqual([...list.state.picks.picked], [ids[1]], 'the row done on its own is unpicked');
    await world.flush();
  } finally {
    world.connection.close();
  }
});

test('. opens the bulk More menu while rows are picked and does nothing otherwise', async () => {
  const world = await boot();
  try {
    const list = listWorld(world, ALL_CONFIG);
    const registry = createAppRegistry();
    const detach = shellRegistryFor(registry).register(commandsForList(list.actions));
    const context = (): CommandContext => ({
      stack: ['global', 'list'],
      target: null,
      selection: [],
      conditions: list.state.picks.picked.size > 0 ? { selection: true } : {},
      prefs: DEFAULT_KEY_PREFS,
      focus: 'none',
    });
    const press = (key: string) => {
      const keyEvent = { key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };
      const resolution = registry.resolve(keyEvent, context());
      assert.equal(resolution?.commandId, key === '.' ? 'list.more' : 'list.select');
      return registry.run(resolution!.commandId, context()).status;
    };
    assert.equal(press('.'), 'ran');
    assert.equal(list.state.opened, 0, 'nothing picked: a no-op');
    press('x');
    press('.');
    assert.equal(list.state.opened, 1, 'picked: the bulk menu');
    detach();
  } finally {
    world.connection.close();
  }
});

test('the bar’s More button is found in the pane header, and absent without a bar', () => {
  const button = { id: 'more' };
  const selectors: string[] = [];
  const root = {
    querySelector: (selector: string) => {
      selectors.push(selector);
      return button;
    },
  };
  assert.equal(moreButtonIn(root), button);
  assert.match(selectors[0] ?? '', /ui-pane__bulk.*More/);
  assert.equal(moreButtonIn({ querySelector: () => null }), null);
});
