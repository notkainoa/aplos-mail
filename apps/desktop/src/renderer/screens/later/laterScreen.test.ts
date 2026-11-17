/**
 * Later on the stand-in engine, in node with no DOM: the screen rendered with react-dom/server over a window the test
 * opened first, re-dating through the real data layer (a drop on a group, a picked preset, Someday) with Undo, the
 * registry running L, D and E, and the date presets as the picker draws them.
 * Run: `cd apps/desktop && npx tsx --test 'src/renderer/screens/later/*.test.ts*'`.
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
import { dismissToast, pushToast } from '../../shell';
import { getToasts, resetToasts } from '../../shell/store-toast';
import { createListActions } from '../lists/listActions';
import { LATER_CONFIG, viewSpecOf } from '../lists/listKinds';
import { asListRow } from '../lists/listRows';
import { shellRegistryFor } from '../../shell/ShellRegistry';
import { reschedule } from './laterActions';
import { commandsForLater, type LaterActions } from './laterCommands';
import { CLOSED, pickerReducer } from './laterPickerState';
import { laterPresets } from './laterPresets';
import { LaterPicker } from './LaterPicker';
import { LaterScreen } from './LaterScreen';

const nextTask = () => new Promise<void>(resolve => setImmediate(resolve));

async function settle(flush: () => void) {
  for (let i = 0; i < 20; i++) {
    await nextTask();
    flush();
  }
}

async function boot(scenario: 'demo' | 'empty' = 'demo') {
  const engine = createFixtureEngine({ scenario, clock: defaultNow });
  const scheduler = createManualScheduler();
  const connection = connectDataLayer({
    session: engine.connect(),
    scheduler,
    timers: createManualTimers(defaultNow),
  });
  const { layer } = connection;
  const later = layer.windows.acquire(viewSpecOf(LATER_CONFIG));
  for (const name of ['accounts', 'counts', 'settings'] as const) layer.session.want(name);
  setClock(harnessClock);
  await settle(() => scheduler.flush());
  return { connection, later, flush: () => settle(() => scheduler.flush()) };
}

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const deps = () => ({
  act: (args: Parameters<typeof api.thread.act>[0]) => api.thread.act(args),
  push: pushToast,
  dismiss: dismissToast,
  hold: () => undefined,
});

const untilOf = (world: Awaited<ReturnType<typeof boot>>, id: string) =>
  (world.later.snapshot().rows.get(id) as ThreadRow | undefined)?.workflow.laterUntil;

test('Later shows its groups in order, a Later | Bookmarks switch and no page title', async () => {
  const world = await boot();
  try {
    const html = renderToStaticMarkup(createElement(LaterScreen));
    const labels = ['Overdue', 'This week', 'Someday'];
    const positions = labels.map(label => text(html).indexOf(label));
    assert.ok(
      positions.every(p => p >= 0),
      `all groups present: ${positions}`,
    );
    assert.deepEqual(
      [...positions].sort((a, b) => a - b),
      positions,
      'Overdue, then This week, then Someday',
    );
    assert.doesNotMatch(html, /<h1/, 'no page title');
    assert.match(html, /data-tone="overdue"/, 'Overdue wears its clock and red text');
    assert.match(html, /role="tablist"[^>]*aria-label="Later view"/);
    assert.match(text(html), /Later Bookmarks/);
    assert.match(html, /data-layout="later"/);
    assert.equal(
      html.match(/role="option"/g)?.length,
      world.later.snapshot().ids.length,
      'every row of the window is drawn',
    );
    assert.doesNotMatch(html, /id="[^"]* [^"]*"/);
  } finally {
    world.connection.close();
  }
});

test('an empty Later is one sentence', async () => {
  const world = await boot('empty');
  try {
    const html = text(renderToStaticMarkup(createElement(LaterScreen)));
    assert.match(html, /(Nothing set aside for later|Your first mail is on its way)/);
  } finally {
    world.connection.close();
  }
});

test('a drop on Tomorrow moves the thread at once, says where, and Undo puts it back', async () => {
  resetToasts();
  const world = await boot();
  try {
    const id = world.later.snapshot().ids[0]!;
    const before = untilOf(world, id);
    const tomorrow = new Date(2026, 9, 30, 8).getTime();
    reschedule(deps(), id, tomorrow, 'Tomorrow, 8:00 AM');
    assert.equal(untilOf(world, id), tomorrow, 'the overlay applied the date synchronously');
    const toast = getToasts().find(candidate => candidate.kind === 'later');
    assert.equal(toast?.message, 'Moved to Tomorrow, 8:00 AM');
    assert.equal(toast?.undoable, true);
    assert.deepEqual(
      toast?.actions?.map(action => action.id),
      ['undo'],
    );
    undoStack.undoLast();
    assert.equal(untilOf(world, id), before, 'Undo restored the old date');
    await world.flush();
  } finally {
    world.connection.close();
  }
});

test('a drop on Someday clears the date', async () => {
  resetToasts();
  const world = await boot();
  try {
    const id = world.later.snapshot().ids[0]!;
    reschedule(deps(), id, undefined, 'Someday');
    assert.equal(untilOf(world, id), undefined);
    assert.ok(getToasts().some(toast => toast.message === 'Moved to Someday'));
    await world.flush();
  } finally {
    world.connection.close();
  }
});

test('the registry runs Later: L and D open the date presets, E is Done, the arrows move and archive nothing', async () => {
  resetToasts();
  const world = await boot();
  try {
    const snapshot = () => {
      const snap = world.later.snapshot();
      return {
        ids: snap.ids,
        key: cursor.key ?? snap.ids[0] ?? null,
        rowOf: (id: string) => asListRow(snap.rows.get(id)),
      };
    };
    const cursor = { key: null as string | null };
    let acts = 0;
    const opened: (string | undefined)[] = [];
    const list = createListActions({
      kind: 'later',
      snapshot,
      setCursor: key => {
        cursor.key = key;
      },
      act: args => {
        acts++;
        return api.thread.act(args);
      },
      discardDraft: async () => undefined,
      canDeleteForever: () => false,
      deleteForever: async () => undefined,
      push: pushToast,
      dismiss: dismissToast,
      hold: { extend: () => undefined },
      open: () => undefined,
      confirmation: () => null,
      setConfirmation: () => undefined,
      undoLabel: (_id, fallback) => fallback,
      forward: () => undefined,
    });
    const actions: LaterActions = { ...list, openPicker: key => void opened.push(key) };
    const registry = createAppRegistry();
    const detach = shellRegistryFor(registry).register(commandsForLater(actions));
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
    assert.equal(press('l'), 'ran');
    assert.equal(press('d'), 'ran');
    assert.equal(opened.length, 2, 'both keys open the same date presets');
    assert.equal(acts, 0, 'opening the picker writes nothing');
    assert.equal(press('ArrowDown'), 'ran');
    assert.equal(press('j'), 'ran');
    assert.equal(acts, 0, 'moving writes nothing');
    assert.equal(press('e'), 'ran');
    assert.equal(acts, 1);
    detach();
    await world.flush();
  } finally {
    world.connection.close();
  }
});

test('the date presets draw 1 to 5 and Pick a date, and the month with its confirm when picking', () => {
  const now = new Date(2026, 9, 29, 10).getTime();
  const base = {
    state: pickerReducer(CLOSED, { type: 'open', id: 't', today: '2026-10-29', first: 'evening' }),
    dispatch: () => undefined,
    anchor: null,
    presets: laterPresets(now),
    today: '2026-10-29',
    nowMs: now,
    onChoose: () => undefined,
    nameOf: () => '',
  };
  const closed = renderToStaticMarkup(createElement(LaterPicker, { ...base, state: CLOSED }));
  assert.equal(closed, '');
  const html = text(renderToStaticMarkup(createElement(LaterPicker, base)));
  for (const label of [
    'Later until',
    'Today evening',
    'Tomorrow',
    'This weekend',
    'Next week',
    'Someday',
    'Pick a date',
  ]) {
    assert.ok(html.includes(label), `${label} is on offer`);
  }
  assert.match(html, /1 Today evening/);
  assert.match(html, /5 Someday/);
  const picking = pickerReducer(base.state, { type: 'active', entry: 'date', today: '2026-10-29' });
  const month = text(renderToStaticMarkup(createElement(LaterPicker, { ...base, state: picking })));
  assert.match(month, /October 2026/);
  assert.match(month, /Move to Later/);
});
