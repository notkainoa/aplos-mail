/**
 * The shared list on the stand-in engine, in node with no DOM: each list rendered with react-dom/server over windows the
 * test opened first (the pattern of `home/homeScreen.test.ts`), and the actions run against the real data layer.
 * Covers the per-list rows and empty lines, arrows moving the cursor and archiving nothing, Restore and Not spam,
 * the Confirm for delete forever and discard, and the Done place with E and L inactive.
 * Run: `cd apps/desktop && npx tsx --test 'src/renderer/screens/lists/*.test.ts*'`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createFixtureEngine, defaultNow } from '@aplos/contract-fixture';
import { createAppRegistry, DEFAULT_KEY_PREFS, type CommandContext } from '../../commands';
import { connectDataLayer } from '../../data/connect';
import { createManualScheduler, createManualTimers } from '../../data/scheduler';
import { harnessClock } from '../../data/clock';
import { api, setClock, undoStack, type ThreadRow } from '../../data';
import { dismissToast, navigate, pushToast, runToastAction } from '../../shell';
import { getToasts, resetToasts } from '../../shell/store-toast';
import { DoneScreen } from '../done';
import { commandsForDone } from '../done/doneCommands';
import {
  ALL_CONFIG,
  BOOKMARKS_CONFIG,
  DONE_CONFIG,
  DRAFTS_CONFIG,
  SENT_CONFIG,
  SPAM_CONFIG,
  TRASH_CONFIG,
  viewSpecOf,
  type ListConfig,
} from './listKinds';
import { createListActions, type Confirmation, type ListDeps } from './listActions';
import { bulkTargetOf } from './bulkTarget';
import { survivorKey } from './listModel';
import { NO_SELECTION, clear, extendTo, pickedInOrder, selectAll, toggle } from './selection';
import type { Selection } from './selection';
import { settled, threadSpecOf } from './useBulk';
import { commandsForList } from './listCommands';
import { asListRow, listRowPropsFor } from './listRows';
import { ListRow } from '../../ui/list';
import { setFormatClock } from '../../ui/list/internal/format';
import { ListScreen } from './ListScreen';
import { ListEmpty, ListFailed } from './ListStates';
import { shellRegistryFor } from '../../shell/ShellRegistry';
import { getComposeRequest } from '../../shell/store-compose';
import { getScreen } from '../../shell/store-route';
import { getOpenThread, getOpenThreadContext, setOpenThread } from '../../shell/store-thread';
import { listOpener } from '../../App';

const nextTask = () => new Promise<void>(resolve => setImmediate(resolve));

async function settle(flush: () => void) {
  for (let i = 0; i < 20; i++) {
    await nextTask();
    flush();
  }
}

const CONFIGS = [ALL_CONFIG, DRAFTS_CONFIG, SENT_CONFIG, TRASH_CONFIG, SPAM_CONFIG, DONE_CONFIG];

async function boot(scenario: 'demo' | 'empty' = 'demo') {
  const engine = createFixtureEngine({ scenario, clock: defaultNow });
  const scheduler = createManualScheduler();
  const connection = connectDataLayer({
    session: engine.connect(),
    scheduler,
    timers: createManualTimers(defaultNow),
  });
  const { layer } = connection;
  const windows = new Map(
    CONFIGS.map(config => [config.kind, layer.windows.acquire(viewSpecOf(config))] as const),
  );
  for (const name of ['accounts', 'counts', 'settings'] as const) layer.session.want(name);
  setClock(harnessClock);
  await settle(() => scheduler.flush());
  const flush = async () => settle(() => scheduler.flush());
  return { connection, windows, flush };
}

type World = Awaited<ReturnType<typeof boot>>;

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const NONE_OF = (state: { picks: Selection; everything: boolean }) => ({
  selection: state.picks,
  everything: state.everything,
});

/** The deps the screen would build, over the real data layer and a live snapshot of one list's window. */
function depsOver(world: World, config: ListConfig, start: string | null = null) {
  const window = world.windows.get(config.kind)!;
  const cursor = { key: start };
  const state = {
    confirmation: null as Confirmation | null,
    acts: 0,
    held: 0,
    opened: [] as string[],
    listIds: [] as (readonly string[] | undefined)[],
    destroyed: [] as string[],
    deleted: [] as (readonly string[])[],
    acted: [] as Parameters<typeof api.thread.act>[0][],
    committed: [] as string[],
    picks: NO_SELECTION as Selection,
    everything: false,
    // Rows the view holds beyond the window: the demo fits in one window, so a test pretends it does not.
    beyondWindow: 0,
  };
  const idsNow = () => window.snapshot().ids;
  const setPicks = (picks: Selection, everything = false) => {
    state.picks = picks;
    state.everything = everything;
  };
  const deps: ListDeps = {
    kind: config.kind,
    snapshot: () => {
      const snap = window.snapshot();
      const ids = snap.ids;
      const key = cursor.key ?? ids[0] ?? null;
      const picked = pickedInOrder(
        settled({ selection: state.picks, everything: state.everything }, ids),
        ids,
      );
      const bulk =
        picked.length === 0
          ? undefined
          : {
              picked,
              loadedIds: ids,
              total: snap.total + state.beyondWindow,
              spec: threadSpecOf(viewSpecOf(config)),
              state: snap.state,
              allPicked: state.everything,
            };
      return { ids, key, rowOf: id => asListRow(snap.rows.get(id)), bulk };
    },
    setCursor: key => {
      cursor.key = key;
    },
    act: args => {
      state.acts++;
      state.acted.push(args);
      return api.thread.act(args);
    },
    selection: {
      toggle: id => setPicks(toggle(settled(NONE_OF(state), idsNow()), id)),
      extendTo: id => setPicks(extendTo(settled(NONE_OF(state), idsNow()), idsNow(), id)),
      selectAll: () => setPicks(selectAll(idsNow()), true),
      clear: () => setPicks(clear()),
    },
    commit: (kind, _hold, rows) => void state.committed.push(`${kind}:${rows.join(',')}`),
    discardDraft: async id => void state.destroyed.push(id),
    canDeleteForever: () => true,
    deleteForever: async ids => void state.deleted.push(ids),
    push: pushToast,
    dismiss: dismissToast,
    hold: { extend: () => void state.held++ },
    open: (id, kind, listIds) => {
      state.opened.push(`${kind}:${id}`);
      state.listIds.push(listIds);
    },
    confirmation: () => state.confirmation,
    setConfirmation: next => {
      state.confirmation = next;
    },
    undoLabel: (_id, fallback) => fallback,
  };
  return { deps, state, cursor, window };
}

test('every list renders its own rows: groups in All mail, recipients in Drafts and Sent, the stamp in Done', async () => {
  // The Done stamp compares the row's day with "today" (format.ts keeps its own clock, which the
  // data-layer harness clock does not reach): pin it to the fixture's day, or the stamp turns into
  // "Done Oct 26" the moment the real date moves on. Restored in the finally below.
  setFormatClock(() => harnessClock.now());
  const world = await boot();
  try {
    const all = renderToStaticMarkup(createElement(ListScreen, { which: 'all' }));
    assert.match(all, /aria-label="All mail"/);
    assert.match(all, /ui-section-header/, 'date groups use section labels');
    assert.match(text(all), /Today|Yesterday|Earlier/);
    const rows = (html: string) => html.match(/role="option"/g)?.length ?? 0;
    assert.equal(rows(all), world.windows.get('all')!.snapshot().ids.length);

    const draftsHtml = renderToStaticMarkup(createElement(ListScreen, { which: 'drafts' }));
    const drafts = text(draftsHtml);
    assert.match(draftsHtml, /ui-section-header/, 'Drafts has date groups');
    assert.match(drafts, /To: Jordan Park/);
    assert.match(drafts, /Re: A quieter home for our project/);

    const sent = renderToStaticMarkup(createElement(ListScreen, { which: 'sent' }));
    assert.match(
      sent,
      /ui-list-row__sender" dir="auto" title="To: Studio team[^"]*">To: Studio team</,
    );
    assert.match(sent, /ui-section-header/, 'Sent has date groups');
    assert.doesNotMatch(sent, />To: Alex Morgan</, 'Sent shows who it went to, not the owner');

    const trash = renderToStaticMarkup(createElement(ListScreen, { which: 'trash' }));
    assert.match(trash, /aria-label="Trash"/);
    assert.match(trash, /Restore/);
    const spam = renderToStaticMarkup(createElement(ListScreen, { which: 'spam' }));
    assert.match(spam, /Not spam/);

    const done = renderToStaticMarkup(createElement(DoneScreen));
    assert.match(done, /aria-label="Done mail"/);
    assert.match(done, /ui-section-header/, 'Done has date groups');
    assert.match(done, /<time dateTime="[^"]+">[^<]+<\/time><\/span>/, 'rows show the date');
    assert.match(done, /role="img" aria-label="Done"/, 'the quiet check is named Done');
    assert.doesNotMatch(done, /id="[^"]* [^"]*"/, 'no DOM id has a space');
    assert.match(done, /Move to Home/);
    assert.doesNotMatch(
      done,
      /<button[^>]*aria-label="(Later|Done)"/,
      'no Done or Later on a done row',
    );
  } finally {
    setFormatClock(null);
    world.connection.close();
  }
});

test('a row finished today shows its time beside the Done check', () => {
  const doneAt = new Date(2026, 9, 29, 9, 41).getTime();
  const row = {
    id: 'd',
    accountId: 'a1',
    subject: 'Receipt',
    snippet: '',
    fromName: 'Cedar Market',
    participants: [],
    lastDate: doneAt,
    unread: false,
    hasAttachments: false,
    workflow: { bookmarked: false, status: 'done', hiddenFromHome: false, doneAt },
    rank: { lane: 'do', importance: 'normal', dueBand: 3, source: 'heuristic' },
    summary: { state: 'none' },
  } as unknown as ThreadRow;
  setFormatClock(() => new Date(2026, 9, 29, 10, 0).getTime());
  const props = listRowPropsFor(row, {
    config: DONE_CONFIG,
    domId: 'x',
    density: 'comfortable',
    cursor: false,
    accounts: [],
    handlers: { onSelect: () => undefined, onOpen: () => undefined, onAction: () => undefined },
  });
  const html = renderToStaticMarkup(createElement(ListRow, props));
  setFormatClock(null);
  assert.match(text(html), /9:41 AM/);
  assert.doesNotMatch(text(html), /Done/, 'the check carries the name, not the text');
  assert.deepEqual(
    props.hoverActions.map(action => action.commandId),
    ['done.moveToHome'],
  );
});

test('a Done row with no finish time shows the date of its last message, not the word', () => {
  const row = {
    id: 'd',
    accountId: 'a1',
    subject: 'Receipt',
    snippet: '',
    fromName: 'Cedar Market',
    participants: [],
    lastDate: new Date(2026, 9, 28, 14, 7).getTime(),
    unread: false,
    hasAttachments: false,
    workflow: { bookmarked: false, status: 'done', hiddenFromHome: false },
    rank: { lane: 'do', importance: 'normal', dueBand: 3, source: 'heuristic' },
    summary: { state: 'none' },
  } as unknown as ThreadRow;
  const props = listRowPropsFor(row, {
    config: DONE_CONFIG,
    domId: 'x',
    density: 'comfortable',
    cursor: false,
    accounts: [],
    handlers: { onSelect: () => undefined, onOpen: () => undefined, onAction: () => undefined },
  });
  assert.match(props.doneAt ?? '', /^2026-10-28T14:07:00/);
  setFormatClock(() => new Date(2026, 9, 29, 10, 0).getTime());
  const html = text(renderToStaticMarkup(createElement(ListRow, props)));
  setFormatClock(null);
  assert.match(html, /Yesterday/);
  assert.doesNotMatch(html, /Done/);
});

test('an empty list is one plain sentence centred in the pane, and first sync is never called empty', () => {
  const calm = { settling: false };
  for (const [config, line, icon] of [
    [ALL_CONFIG, 'No mail here yet', 'tray'],
    [DRAFTS_CONFIG, 'No drafts Messages you start and leave are saved here', 'file'],
    [SENT_CONFIG, 'Nothing sent yet', 'send'],
    [TRASH_CONFIG, 'Trash is empty', 'trash'],
    [SPAM_CONFIG, 'Spam is empty', 'spam'],
    [DONE_CONFIG, 'Nothing done yet', 'check-circle'],
  ] as const) {
    const html = renderToStaticMarkup(
      createElement(ListEmpty, {
        text: config.empty,
        icon: config.emptyIcon,
        detail: config.emptyDetail,
        state: calm,
      }),
    );
    assert.equal(text(html), line);
    assert.match(html, /data-placement="pane"/, 'centres in the pane');
    assert.match(html, new RegExp(`data-icon="${icon}"`), 'wears the place’s mark');
    assert.doesNotMatch(html, /ui-list-box/);
  }
  const bookmarks = renderToStaticMarkup(
    createElement(ListEmpty, {
      text: BOOKMARKS_CONFIG.empty,
      icon: BOOKMARKS_CONFIG.emptyIcon,
      detail: BOOKMARKS_CONFIG.emptyDetail,
      state: calm,
    }),
  );
  assert.equal(text(bookmarks), 'No bookmarks Press B on any email');
  const syncing = text(
    renderToStaticMarkup(
      createElement(ListEmpty, {
        text: 'No drafts',
        state: { settling: true, reason: 'Importing 3 of 9' },
      }),
    ),
  );
  assert.match(syncing, /Your first mail is on its way(?!\.)/);
  assert.match(syncing, /Importing 3 of 9/);
});

test('arrows on All mail move the cursor and archive nothing', async () => {
  resetToasts();
  const world = await boot();
  try {
    const { deps, state, cursor, window } = depsOver(world, ALL_CONFIG);
    const before = [...window.snapshot().ids];
    const actions = createListActions(deps);
    actions.move(1);
    actions.move(1);
    actions.move(1);
    assert.equal(cursor.key, before[3], 'three steps down');
    actions.move(-1);
    assert.equal(cursor.key, before[2]);
    assert.equal(state.acts, 0, 'no thread action ran');
    assert.ok(state.held >= 4, 'each key extends the hold around the cursor');
    assert.deepEqual(window.snapshot().ids, before, 'the list is unchanged');
    assert.equal(getToasts().length, 0, 'and nothing was announced');
    actions.open();
    assert.deepEqual(state.opened, [`thread:${before[2]}`], 'Return opens through onOpen');
    assert.deepEqual(
      state.listIds,
      [before],
      'and hands over the ids the list shows, in order, for J and K',
    );
  } finally {
    world.connection.close();
  }
});

test('the registry runs the list: arrows and J K move, E is Done, # is Trash, and nothing else', async () => {
  resetToasts();
  const world = await boot();
  try {
    const { deps, state, cursor, window } = depsOver(world, ALL_CONFIG);
    const registry = createAppRegistry();
    const detach = shellRegistryFor(registry).register(commandsForList(createListActions(deps)));
    const context: CommandContext = {
      stack: ['global', 'list'],
      target: null,
      selection: [],
      conditions: {},
      prefs: DEFAULT_KEY_PREFS,
      focus: 'none',
    };
    const press = (key: string) => {
      const resolution = registry.resolve(
        { key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false },
        context,
      );
      assert.ok(resolution, `${key} resolves`);
      return registry.run(resolution.commandId, context).status;
    };
    const first = window.snapshot().ids[0];
    assert.equal(press('ArrowDown'), 'ran');
    assert.equal(press('j'), 'ran');
    assert.equal(press('ArrowUp'), 'ran');
    assert.equal(state.acts, 0);
    cursor.key = first!;
    assert.equal(press('e'), 'ran');
    assert.equal(state.acts, 1);
    assert.ok(getToasts().some(toast => toast.kind === 'done' && toast.undoable === true));
    detach();
    await world.flush();
  } finally {
    world.connection.close();
  }
});

test('Trash restores and Spam says not spam, each with one Undo toast', async () => {
  resetToasts();
  const world = await boot();
  try {
    for (const config of [TRASH_CONFIG, SPAM_CONFIG]) {
      const { deps, window } = depsOver(world, config);
      const target = window.snapshot().ids[0]!;
      createListActions(deps).restore();
      assert.ok(!window.snapshot().ids.includes(target), `${config.kind}: the row left at once`);
      undoStack.undoLast();
      assert.ok(window.snapshot().ids.includes(target), `${config.kind}: Undo brought it back`);
      await world.flush();
    }
    assert.equal(getToasts().filter(toast => toast.undoable).length, 2);
    const trash = depsOver(world, ALL_CONFIG);
    const row = trash.window.snapshot().ids[0]!;
    createListActions(trash.deps).restore();
    assert.ok(
      trash.window.snapshot().ids.includes(row),
      'Restore does nothing outside Trash and Spam',
    );
    await world.flush();
  } finally {
    world.connection.close();
  }
});

test('delete forever and discard ask first with a Confirm, and cancel changes nothing', async () => {
  resetToasts();
  const world = await boot();
  try {
    const trash = depsOver(world, TRASH_CONFIG);
    const actions = createListActions(trash.deps);
    const row = trash.window.snapshot().ids[0]!;
    actions.trash();
    assert.deepEqual(trash.state.confirmation, { kind: 'deleteForever', ids: [row] });
    assert.equal(trash.state.acts, 0, 'nothing is deleted before the owner answers');
    actions.cancelConfirm();
    assert.equal(trash.state.confirmation, null);
    assert.deepEqual(trash.state.deleted, []);
    actions.trash();
    actions.confirm();
    await nextTask();
    assert.deepEqual(trash.state.deleted, [[row]]);
    assert.ok(getToasts().some(toast => toast.message === 'Deleted forever'));

    const drafts = depsOver(world, DRAFTS_CONFIG);
    const draftActions = createListActions(drafts.deps);
    draftActions.trash();
    assert.equal(drafts.state.confirmation?.kind, 'discardDraft');
    draftActions.confirm();
    await nextTask();
    assert.deepEqual(drafts.state.destroyed, drafts.state.destroyed.slice(0, 1));
    assert.equal(drafts.state.destroyed.length, 1);

    const unavailable = depsOver(world, SPAM_CONFIG);
    createListActions({ ...unavailable.deps, canDeleteForever: () => false }).trash();
    assert.equal(unavailable.state.confirmation, null, 'no delete without the contract action');
  } finally {
    world.connection.close();
  }
});

test('Done: H moves a row back to Home with Undo, and E and L do nothing', async () => {
  resetToasts();
  const world = await boot();
  try {
    const { deps, window, state } = depsOver(world, DONE_CONFIG);
    const actions = createListActions(deps);
    const target = window.snapshot().ids[0]!;
    const registry = createAppRegistry();
    const detach = shellRegistryFor(registry).register(commandsForDone(actions));
    const context: CommandContext = {
      stack: ['global', 'list', 'done'],
      target: null,
      selection: [],
      conditions: {},
      prefs: DEFAULT_KEY_PREFS,
      focus: 'none',
    };
    const resolve = (key: string) =>
      registry.resolve(
        { key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false },
        context,
      );
    assert.equal(resolve('e'), null, 'E does nothing on a done row');
    assert.equal(resolve('l'), null, 'L does nothing on a done row');
    actions.done();
    actions.later();
    assert.equal(state.acts, 0, 'even called directly, Done and Later do not act here');
    const h = resolve('h');
    assert.equal(h?.commandId, 'done.moveToHome');
    assert.equal(registry.run('done.moveToHome', context).status, 'ran');
    assert.ok(!window.snapshot().ids.includes(target), 'the row left Done at once');
    const toast = getToasts().find(candidate => candidate.kind === 'home');
    assert.equal(toast?.message, 'Moved to Home');
    assert.deepEqual(
      toast?.actions?.map(a => a.id),
      ['undo'],
    );
    undoStack.undoLast();
    assert.ok(window.snapshot().ids.includes(target), 'Undo put it back in Done');
    detach();
    await world.flush();
  } finally {
    world.connection.close();
  }
});

test('a list toast Undo undoes its own operation, not the newest one', async () => {
  resetToasts();
  const world = await boot();
  try {
    const { deps, cursor, window } = depsOver(world, ALL_CONFIG);
    const [first, second] = window.snapshot().ids;
    assert.ok(first && second);
    const actions = createListActions(deps);
    cursor.key = first;
    actions.done();
    const older = getToasts().find(toast => toast.kind === 'done');
    assert.ok(older);
    assert.equal(older.actions?.[0]?.commandId, undefined);
    assert.equal(older.actions?.[0]?.keysFrom, 'app.undo', 'Z is drawn, not run');
    cursor.key = second;
    actions.done();
    const newer = getToasts().find(toast => toast.kind === 'done' && toast.id !== older.id);
    assert.ok(newer);
    runToastAction(older.id, 'undo');
    const top = undoStack.peek();
    assert.ok(
      top?.kind === 'operation' && top.opId === newer.id,
      'the older operation was undone and the newer one is still the newest to undo',
    );
    await world.flush();
  } finally {
    world.connection.close();
  }
});

test('a list that failed with nothing to show says so in one sentence, with Try again', () => {
  const html = renderToStaticMarkup(createElement(ListFailed));
  assert.match(html, /Couldn’t load this list\./);
  assert.match(html, /Try again/);
});

// ---------------------------------------------------------------------------
// Bulk pick (DESIGN 7.4): X, ⇧X, ⌘A, Esc and the bulk verbs
// ---------------------------------------------------------------------------

type BulkDeps = ReturnType<typeof depsOver>;

/** The registry with the list's handlers attached, and a `press` that resolves a key the way the shell does. */
function keyboardFor(bulk: BulkDeps) {
  const registry = createAppRegistry();
  const detach = shellRegistryFor(registry).register(commandsForList(createListActions(bulk.deps)));
  const context = (): CommandContext => ({
    stack: ['global', 'list'],
    target: null,
    selection: [],
    conditions: bulk.state.picks.picked.size > 0 ? { selection: true } : {},
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

const pickedIds = (bulk: BulkDeps) => [...bulk.state.picks.picked];

test('X picks the cursor row, ⇧X the run, ⌘A the list, Esc clears; arrows only move the cursor', async () => {
  resetToasts();
  const world = await boot();
  try {
    const bulk = depsOver(world, ALL_CONFIG);
    const keys = keyboardFor(bulk);
    const ids = bulk.window.snapshot().ids;
    assert.equal(keys.resolve('Escape')?.commandId, undefined, 'Esc is not Clear with no picks');
    keys.press('x');
    assert.deepEqual(pickedIds(bulk), [ids[0]], 'X picks the row under the cursor');
    assert.equal(bulk.cursor.key, null, 'and the cursor stays where it was');
    keys.press('j');
    keys.press('ArrowDown');
    assert.equal(bulk.cursor.key, ids[2]);
    assert.deepEqual(pickedIds(bulk), [ids[0]], 'arrows add nothing to the pick');
    assert.equal(bulk.state.acts, 0, 'and archive nothing, even with picks');
    keys.press('x', { shiftKey: true });
    assert.deepEqual(pickedIds(bulk), ids.slice(0, 3), '⇧X picks the run from the anchor');
    assert.equal(keys.resolve('Escape')?.commandId, 'list.clearSelection');
    keys.press('Escape');
    assert.equal(bulk.state.picks.picked.size, 0, 'Esc clears');
    keys.press('a', { metaKey: true });
    assert.equal(bulk.state.picks.picked.size, ids.length, '⌘A picks every loaded row');
    assert.equal(bulk.state.acts, 0);
    keys.detach();
  } finally {
    world.connection.close();
  }
});

test('E on a pick sends one act and one toast whose Undo brings every row back', async () => {
  resetToasts();
  const world = await boot();
  try {
    const bulk = depsOver(world, ALL_CONFIG);
    const keys = keyboardFor(bulk);
    const before = [...bulk.window.snapshot().ids];
    keys.press('x');
    keys.press('j');
    keys.press('x');
    keys.press('j');
    keys.press('x');
    const picked = before.slice(0, 3);
    assert.equal(keys.press('e'), 'ran');
    assert.equal(bulk.state.acts, 1, 'one act for the three rows');
    assert.deepEqual(bulk.state.acted[0]?.ids, picked);
    const toasts = getToasts().filter(toast => toast.kind === 'done');
    assert.equal(toasts.length, 1, 'one toast');
    assert.equal(toasts[0]?.message, 'Done · 3 emails');
    assert.equal(toasts[0]?.undoable, true);
    assert.deepEqual(
      toasts[0]?.actions?.map(action => action.id),
      ['undo'],
    );
    assert.equal(bulk.state.picks.picked.size, 0, 'the pick clears');
    assert.equal(bulk.cursor.key, before[3], 'the cursor lands on the nearest surviving row');
    assert.deepEqual(
      bulk.state.committed,
      [`done:${picked.join(',')}`],
      'the motion flies the rows',
    );
    const statusOf = (id: string) =>
      (bulk.window.snapshot().rows.get(id) as ThreadRow).workflow.status;
    assert.ok(
      picked.every(id => statusOf(id) === 'done'),
      'every picked row is done at once',
    );
    runToastAction(toasts[0]!.id, 'undo');
    assert.ok(
      picked.every(id => statusOf(id) !== 'done'),
      'Undo restored all three',
    );
    await world.flush();
    keys.detach();
  } finally {
    world.connection.close();
  }
});

test('a hover button acts on its own row even while others are picked', async () => {
  resetToasts();
  const world = await boot();
  try {
    const bulk = depsOver(world, ALL_CONFIG);
    const ids = bulk.window.snapshot().ids;
    const actions = createListActions(bulk.deps);
    actions.select();
    actions.done(ids[4]);
    assert.deepEqual(bulk.state.acted[0]?.ids, [ids[4]]);
    assert.equal(pickedIds(bulk).length, 1, 'the pick is untouched');
    await world.flush();
  } finally {
    world.connection.close();
  }
});

test('# on a pick asks first; nothing moves until the owner answers, and Cancel changes nothing', async () => {
  resetToasts();
  const world = await boot();
  try {
    const bulk = depsOver(world, ALL_CONFIG);
    const keys = keyboardFor(bulk);
    const ids = [...bulk.window.snapshot().ids];
    const actions = createListActions(bulk.deps);
    keys.press('x');
    keys.press('j');
    keys.press('x');
    keys.press('#', { shiftKey: true });
    assert.deepEqual(bulk.state.confirmation, {
      kind: 'trashPicked',
      ids: ids.slice(0, 2),
      count: 2,
    });
    assert.equal(bulk.state.acts, 0, 'blocked until the owner answers');
    assert.deepEqual(bulk.window.snapshot().ids, ids);
    actions.cancelConfirm();
    assert.equal(bulk.state.confirmation, null);
    assert.equal(bulk.state.picks.picked.size, 2, 'Cancel keeps the pick');
    keys.press('#', { shiftKey: true });
    actions.confirm();
    assert.equal(bulk.state.acts, 1, 'confirming sends one act');
    assert.equal(
      getToasts().find(toast => toast.kind === 'trash')?.message,
      'Moved to Trash · 2 emails',
    );
    assert.equal(bulk.state.picks.picked.size, 0);
    undoStack.undoLast();
    assert.ok(ids.slice(0, 2).every(id => bulk.window.snapshot().ids.includes(id)));
    await world.flush();
    keys.detach();
  } finally {
    world.connection.close();
  }
});

test('Restore on a Trash pick sends one act; Drafts and Trash ask before discarding or deleting', async () => {
  resetToasts();
  const world = await boot();
  try {
    const trash = depsOver(world, TRASH_CONFIG);
    const count = trash.window.snapshot().ids.length;
    const actions = createListActions(trash.deps);
    actions.selectAll();
    actions.restore();
    assert.equal(trash.state.acts, 1);
    const restored = getToasts().find(toast => toast.kind === 'info')?.message;
    assert.equal(restored, `Restored · ${count === 1 ? '1 email' : `${count} emails`}`);
    actions.done();
    assert.equal(trash.state.acts, 1, 'Done is not a Trash verb, picks or not');
    await world.flush();

    const drafts = depsOver(world, DRAFTS_CONFIG);
    const draftActions = createListActions(drafts.deps);
    draftActions.selectAll();
    draftActions.trash();
    assert.equal(drafts.state.confirmation?.kind, 'discardDraft');
    assert.equal(drafts.state.confirmation?.ids.length, drafts.window.snapshot().ids.length);
  } finally {
    world.connection.close();
  }
});

test('⌘A past the window sends a selector over the whole view at the state the owner saw', async () => {
  resetToasts();
  const world = await boot();
  try {
    const bulk = depsOver(world, ALL_CONFIG);
    bulk.state.beyondWindow = 300;
    const snap = bulk.window.snapshot();
    const actions = createListActions(bulk.deps);
    actions.selectAll();
    actions.done();
    const sent = bulk.state.acted[0];
    assert.equal(sent?.ids, undefined, 'the ids are not listed');
    assert.deepEqual(sent?.selector?.atState, snap.state);
    assert.deepEqual(sent?.selector?.spec, viewSpecOf(ALL_CONFIG), 'the list\u2019s own view');
    assert.equal(bulk.state.acted.length, 1);
    const message = getToasts().find(toast => toast.kind === 'done')?.message;
    assert.equal(message, `Done · ${snap.total + 300} emails`);
    await world.flush();
  } finally {
    world.connection.close();
  }
});

test('a picked row that leaves is forgotten, and ⌘A follows a window that slides', () => {
  const kept = { selection: toggle(toggle(NO_SELECTION, 'a'), 'b'), everything: false };
  assert.deepEqual([...settled(kept, ['b', 'c']).picked], ['b'], 'a left, so a is dropped');
  const all = { selection: selectAll(['a', 'b']), everything: true };
  assert.deepEqual(
    [...settled(all, ['c', 'd']).picked],
    ['c', 'd'],
    'after ⌘A the pick is whatever is loaded',
  );
  assert.equal(threadSpecOf({ kind: 'drafts' } as never), null, 'Drafts cannot be selected whole');
});

test('where the cursor lands after rows leave, and the target for a short pick', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  assert.equal(survivorKey(ids, 'b', ['a', 'b', 'c']), 'd', 'below first');
  assert.equal(survivorKey(ids, 'e', ['d', 'e']), 'c', 'else above');
  assert.equal(survivorKey(ids, 'c', ['a']), 'c', 'a surviving cursor stays');
  assert.equal(survivorKey(ids, 'a', ids), null, 'nothing survives');
  const scope = { loadedIds: ids, total: 5, spec: null, state: null, allPicked: false };
  assert.deepEqual(bulkTargetOf({ ...scope, picked: ['a', 'c'] }), { ids: ['a', 'c'] });
});

test('picked rows carry the pick state, and the list draws it without a new row box', () => {
  const world = { picked: true, picking: true };
  const row = {
    id: 't1',
    accountId: 'a1',
    subject: 'Receipt',
    snippet: '',
    fromName: 'Cedar Market',
    participants: [],
    lastDate: Date.now(),
    unread: false,
    hasAttachments: false,
    workflow: { bookmarked: false, status: 'inbox', hiddenFromHome: false },
    rank: { lane: 'do', importance: 'normal', dueBand: 3, source: 'heuristic' },
    summary: { state: 'none' },
  } as unknown as ThreadRow;
  const base = {
    config: ALL_CONFIG,
    domId: 'x',
    density: 'comfortable' as const,
    cursor: false,
    accounts: [],
    handlers: { onSelect: () => undefined, onOpen: () => undefined, onAction: () => undefined },
  };
  const plain = listRowPropsFor(row, base);
  assert.equal(plain.picked, false);
  assert.equal(plain.picking, false);
  const picked = listRowPropsFor(row, { ...base, ...world });
  assert.equal(picked.picked, true);
  assert.equal(picked.picking, true);
  assert.match(renderToStaticMarkup(createElement(ListRow, picked)), /data-picked="true"/);
});

test('Enter on a draft opens it in the compose page, coming from Drafts', async () => {
  const world = await boot();
  try {
    const { deps, state } = depsOver(world, DRAFTS_CONFIG);
    navigate('drafts');
    const open = listOpener('drafts');
    createListActions({ ...deps, open }).open();
    assert.deepEqual(state.opened, [], 'the opener of the screen got it, not the test double');
    assert.deepEqual(getScreen(), { label: 'compose' });
    const request = getComposeRequest();
    assert.ok(request?.draftId, 'the draft row is the one opened');
    assert.equal(request?.from, 'drafts');
  } finally {
    navigate('home');
    world.connection.close();
  }
});

test('a list opens a thread in the reader with its own ids, so J and K walk that list and the crumb counts it', () => {
  const open = listOpener('later');
  open('t2', 'thread', ['t1', 't2', 't3']);
  assert.equal(getOpenThread(), 't2');
  assert.deepEqual(getOpenThreadContext().listIds, ['t1', 't2', 't3']);
  assert.equal(getOpenThreadContext().from, 'later');
  setOpenThread(null);
  navigate('later');
  open('t9', 'thread');
  assert.equal(
    getOpenThreadContext().listIds,
    null,
    'without ids the reader falls back to Home order',
  );
  setOpenThread(null);
  navigate('home');
});
