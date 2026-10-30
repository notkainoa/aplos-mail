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
import { dismissToast, pushToast, runToastAction } from '../../shell';
import { getToasts, resetToasts } from '../../shell/store-toast';
import { DoneScreen } from '../done';
import { commandsForDone } from '../done/doneCommands';
import {
  ALL_CONFIG,
  DONE_CONFIG,
  DRAFTS_CONFIG,
  SENT_CONFIG,
  SPAM_CONFIG,
  TRASH_CONFIG,
  viewSpecOf,
  type ListConfig,
} from './listKinds';
import { createListActions, type Confirmation, type ListDeps } from './listActions';
import { commandsForList } from './listCommands';
import { asListRow, listRowPropsFor } from './listRows';
import { ListRow } from '../../ui/list';
import { setFormatClock } from '../../ui/list/internal/format';
import { ListScreen } from './ListScreen';
import { ListEmpty, ListFailed } from './ListStates';
import { shellRegistryFor } from '../../shell/ShellRegistry';

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

/** The deps the screen would build, over the real data layer and a live snapshot of one list's window. */
function depsOver(world: World, config: ListConfig, start: string | null = null) {
  const window = world.windows.get(config.kind)!;
  const cursor = { key: start };
  const state = {
    confirmation: null as Confirmation | null,
    acts: 0,
    held: 0,
    opened: [] as string[],
    destroyed: [] as string[],
    deleted: [] as (readonly string[])[],
  };
  const deps: ListDeps = {
    kind: config.kind,
    snapshot: () => {
      const snap = window.snapshot();
      const ids = snap.ids;
      const key = cursor.key ?? ids[0] ?? null;
      return { ids, key, rowOf: id => asListRow(snap.rows.get(id)) };
    },
    setCursor: key => {
      cursor.key = key;
    },
    act: args => {
      state.acts++;
      return api.thread.act(args);
    },
    discardDraft: async id => void state.destroyed.push(id),
    canDeleteForever: () => true,
    deleteForever: async ids => void state.deleted.push(ids),
    push: pushToast,
    dismiss: dismissToast,
    hold: { extend: () => void state.held++ },
    open: (id, kind) => void state.opened.push(`${kind}:${id}`),
    confirmation: () => state.confirmation,
    setConfirmation: next => {
      state.confirmation = next;
    },
    undoLabel: (_id, fallback) => fallback,
  };
  return { deps, state, cursor, window };
}

test('every list renders its own rows: groups in All mail, recipients in Drafts and Sent, the stamp in Done', async () => {
  const world = await boot();
  try {
    const all = renderToStaticMarkup(createElement(ListScreen, { which: 'all' }));
    assert.match(all, /aria-label="All mail"/);
    assert.match(all, /ui-section-header/, 'date groups use section labels');
    assert.match(text(all), /Today|Yesterday|Earlier/);
    const rows = (html: string) => html.match(/role="option"/g)?.length ?? 0;
    assert.equal(rows(all), world.windows.get('all')!.snapshot().ids.length);

    const drafts = text(renderToStaticMarkup(createElement(ListScreen, { which: 'drafts' })));
    assert.match(drafts, /Jordan Park/);
    assert.match(drafts, /Re: A quieter home for our project/);

    const sent = renderToStaticMarkup(createElement(ListScreen, { which: 'sent' }));
    assert.match(sent, /ui-list-row__sender" dir="auto">Studio team</);
    assert.doesNotMatch(
      sent,
      /ui-list-row__sender" dir="auto">Alex Morgan</,
      'Sent shows who it went to, not the owner',
    );

    const trash = renderToStaticMarkup(createElement(ListScreen, { which: 'trash' }));
    assert.match(trash, /aria-label="Trash"/);
    assert.match(trash, /Restore/);
    const spam = renderToStaticMarkup(createElement(ListScreen, { which: 'spam' }));
    assert.match(spam, /Not spam/);

    const done = renderToStaticMarkup(createElement(DoneScreen));
    assert.match(done, /aria-label="Done mail"/);
    assert.match(text(done), /Done (\w{3} )?\d{1,2}:\d{2} (AM|PM)/, 'rows read "Done <time>"');
    assert.doesNotMatch(done, /id="[^"]* [^"]*"/, 'no DOM id has a space');
    assert.match(done, /Move to Home/);
    assert.doesNotMatch(
      done,
      /aria-label="Later"|aria-label="Done"/,
      'no Done or Later on a done row',
    );
  } finally {
    world.connection.close();
  }
});

test('a row finished today reads "Done 9:41 AM"', () => {
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
  assert.match(text(html), /Done 9:41 AM/);
  assert.deepEqual(
    props.hoverActions.map(action => action.commandId),
    ['done.moveToHome'],
  );
});

test('a Done row with no finish time reads a bare "Done", never a time it was not finished', () => {
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
  assert.equal(props.doneAt, undefined);
  assert.doesNotMatch(text(renderToStaticMarkup(createElement(ListRow, props))), /2:07|Done \d/);
});

test('an empty list is one plain sentence, and first sync is never called empty', () => {
  const calm = { settling: false };
  for (const [config, line] of [
    [ALL_CONFIG, 'No mail here yet.'],
    [DRAFTS_CONFIG, 'No drafts.'],
    [SENT_CONFIG, 'Nothing sent yet.'],
    [TRASH_CONFIG, 'Trash is empty.'],
    [SPAM_CONFIG, 'Spam is empty.'],
    [DONE_CONFIG, 'Nothing done yet.'],
  ] as const) {
    const html = renderToStaticMarkup(
      createElement(ListEmpty, { text: config.empty, state: calm }),
    );
    assert.equal(text(html), line);
    assert.doesNotMatch(html, /ui-list-box/);
  }
  const syncing = text(
    renderToStaticMarkup(
      createElement(ListEmpty, {
        text: 'No drafts.',
        state: { settling: true, reason: 'Importing 3 of 9' },
      }),
    ),
  );
  assert.match(syncing, /Your first mail is on its way\./);
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
