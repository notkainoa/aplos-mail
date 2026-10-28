/**
 * Home on the stand-in engine, in node with no DOM: the screen rendered with react-dom/server over windows the test
 * opened first (the pattern of `data/hooks.test.ts`), and the actions run against the real data layer. Covers section
 * order and the focus slot, the empty states, Done with its Undo toast, the reminder offer, lane moves, Space on a
 * Follow up row, Clear from Home, and Z. Run: `cd apps/desktop && npx tsx --test 'src/renderer/screens/home/*.test.ts*'`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createFixtureEngine, defaultNow } from '@aplos/contract-fixture';
import { fixtureControl } from '@aplos/contract-fixture/control';
import { createAppRegistry, DEFAULT_KEY_PREFS, type CommandContext } from '../../commands';
import { connectDataLayer } from '../../data/connect';
import { createManualScheduler, createManualTimers } from '../../data/scheduler';
import { api, setClock, undoStack, type ThreadRow } from '../../data';
import { harnessClock } from '../../data/clock';
import { getToasts, resetToasts } from '../../shell/store-toast';
import { pushToast, dismissToast, runToastAction } from '../../shell';
import { createHomeActions, type HomeDeps, type HomeSnapshot, type RunStatus } from './homeActions';
import { commandsForHome } from './homeCommands';
import { shellRegistryFor } from '../../shell/ShellRegistry';
import { buildItems, initialKey, orderLayout, type HomeLayout } from './homeModel';
import { HomeScreen } from './HomeScreen';

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
  const home = layer.windows.acquire({ kind: 'home' });
  layer.windows.acquire({ kind: 'lowSenders' });
  for (const name of ['accounts', 'counts', 'settings'] as const) layer.session.want(name);
  setClock(harnessClock);
  await settle(() => scheduler.flush());
  const control = fixtureControl(engine);
  const flush = async () => {
    await control.advanceClock({ ms: 300 });
    await settle(() => scheduler.flush());
  };
  return { connection, home, scheduler, flush };
}

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function layoutOf(
  snapshot: ReturnType<Awaited<ReturnType<typeof boot>>['home']['snapshot']>,
): HomeLayout {
  const ids = (key: string) =>
    snapshot.sections.find(s => s.key === key)
      ? snapshot.ids.slice(
          snapshot.sections.find(s => s.key === key)!.start - snapshot.position,
          snapshot.sections.find(s => s.key === key)!.start -
            snapshot.position +
            snapshot.sections.find(s => s.key === key)!.count,
        )
      : [];
  return {
    do: ids('do'),
    fromLater: ids('fromLater'),
    update: ids('update'),
    follow: ids('follow'),
    lowCount: snapshot.sections.find(s => s.key === 'low')?.count ?? 0,
  };
}

/** The deps the screen would build, over the real data layer and a live snapshot of the home window. */
function depsOver(world: Awaited<ReturnType<typeof boot>>, key: { current: string | null }) {
  const rowOf = (id: string) => world.home.snapshot().rows.get(id) as ThreadRow | undefined;
  const calls: string[] = [];
  const ran: string[] = [];
  let offer: string | null = null;
  const deps: HomeDeps = {
    snapshot: (): HomeSnapshot => {
      const snap = world.home.snapshot();
      const items = buildItems(orderLayout(layoutOf(snap), rowOf, false));
      return {
        items,
        key: key.current ?? initialKey(items),
        rowOf,
        state: snap.state,
        accountId: undefined,
      };
    },
    setCursor: next => {
      key.current = next;
    },
    act: args => api.thread.act(args),
    push: pushToast,
    dismiss: dismissToast,
    hold: { extend: ids => void calls.push(`hold:${(ids ?? []).length}`) },
    offerReminder: id => {
      offer = id;
    },
    reminderOffer: () => offer,
    runCommand: (id): RunStatus => {
      ran.push(id);
      return 'unhandled';
    },
    openThread: (id, how) => void calls.push(`open:${how}:${id}`),
    openLow: () => void calls.push('low'),
    oneByOne: () => void calls.push('oneByOne'),
    openMore: () => void calls.push('more'),
    openDatePicker: id => void calls.push(`picker:${id}`),
    commit: (kind, _ids, rowId) => void calls.push(`commit:${kind}:${rowId}`),
    undoLabel: (_id, fallback) => fallback,
  };
  return { deps, calls, ran, offer: () => offer };
}

test('Home renders Do now, Important updates, the Low band, Follow up in that order with one fixed focus slot', async () => {
  resetToasts();
  const world = await boot();
  try {
    const html = renderToStaticMarkup(createElement(HomeScreen));
    const labels = ['Do now', 'Important updates', 'Low importance', 'Follow up'];
    const positions = labels.map(label => text(html).indexOf(label));
    assert.ok(
      positions.every(p => p >= 0),
      `all four present: ${positions}`,
    );
    assert.deepEqual(
      [...positions].sort((a, b) => a - b),
      positions,
      'in DESIGN 7.2 order',
    );
    assert.equal(html.match(/class="ui-focus-slot"/g)?.length, 1, 'exactly one focus slot');
    assert.equal(html.match(/class="ui-low-band"/g)?.length, 1);
    assert.equal(
      html.match(/class="ui-focus-letter"/g)?.length,
      1,
      'the cursor row is the focus letter',
    );
    assert.match(html, /class="ui-focus-slot" data-density="comfortable"/);
    const snap = world.home.snapshot();
    const first = layoutOf(snap).do[0];
    assert.ok(first, 'the demo has Do now mail');
    assert.match(html, /aria-activedescendant="home-row-/, 'the cursor starts on a row');
    assert.ok(
      !html.includes('Back from Later') || html.indexOf('Back from Later') > html.indexOf('Do now'),
    );
  } finally {
    world.connection.close();
  }
});

test('an empty mailbox shows the handled line, never a list', async () => {
  const world = await boot('empty');
  try {
    const html = renderToStaticMarkup(createElement(HomeScreen));
    assert.doesNotMatch(html, /ui-list-box/);
    assert.match(
      text(html),
      /(You handled 0 emails\.|Add an account|Your first mail is on its way\.)/,
    );
  } finally {
    world.connection.close();
  }
});

test('Done: the row leaves at once, one toast with the opId offers Undo, and Z brings it back', async () => {
  resetToasts();
  const world = await boot();
  try {
    const key = { current: null as string | null };
    const { deps, calls } = depsOver(world, key);
    const actions = createHomeActions(deps);
    const target = deps.snapshot().key!;
    actions.done();
    assert.ok(!world.home.snapshot().ids.includes(target), 'the overlay removed it synchronously');
    assert.ok(
      calls.some(c => c.startsWith('hold:') || c.startsWith('commit:')),
      'the hold started',
    );
    const toast = getToasts().find(t => t.kind === 'done');
    assert.ok(toast, 'a Done toast');
    assert.equal(toast.message, 'Done');
    assert.equal(toast.undoable, true);
    assert.deepEqual(
      toast.actions?.map(a => a.id),
      toast.actions?.some(a => a.id === 'remind') ? ['remind', 'undo'] : ['undo'],
    );
    assert.equal(undoStack.peek()?.kind, 'operation');
    undoStack.undoLast();
    assert.ok(world.home.snapshot().ids.includes(target), 'Undo put it back');
    await world.flush();
  } finally {
    world.connection.close();
  }
});

test('Done on a Follow up row offers Remind me if no reply, and R sets the reminder', async () => {
  resetToasts();
  const world = await boot();
  try {
    const follow = layoutOf(world.home.snapshot()).follow[0];
    assert.ok(follow, 'the demo has a Follow up row');
    const key = { current: follow as string | null };
    const { deps, offer } = depsOver(world, key);
    const actions = createHomeActions(deps);
    actions.done();
    const toast = getToasts().find(t => t.kind === 'done');
    assert.deepEqual(
      toast?.actions?.map(a => a.id),
      ['remind', 'undo'],
    );
    assert.equal(toast?.actions?.[0]?.commandId, undefined, 'the button acts on its own thread');
    assert.equal(toast?.actions?.[0]?.keysFrom, 'mail.remindIfNoReply', 'R is drawn, not run');
    assert.equal(offer(), follow);
    actions.remind();
    assert.equal(offer(), null);
    assert.ok(getToasts().some(t => t.message === 'Reminder set'));
    await world.flush();
  } finally {
    world.connection.close();
  }
});

test('Option-Down and Option-Up move a thread one lane, with Undo and Always do this for the sender', async () => {
  resetToasts();
  const world = await boot();
  try {
    const first = layoutOf(world.home.snapshot()).do[0]!;
    const key = { current: first as string | null };
    const { deps } = depsOver(world, key);
    const actions = createHomeActions(deps);
    actions.lane('down');
    assert.equal(
      (world.home.snapshot().rows.get(first) as ThreadRow).rank.lane,
      'update',
      'the overlay moved the lane at once',
    );
    await world.flush();
    assert.ok(
      layoutOf(world.home.snapshot()).update.includes(first),
      'now under Important updates',
    );
    const toast = getToasts().find(t => t.message === 'Moved to Important updates');
    assert.ok(toast, 'the lane toast names where it went');
    assert.match(toast.actions?.[0]?.label ?? '', /^Always do this for /);
    assert.equal(toast.actions?.[1]?.label, 'Undo');
    key.current = first;
    actions.lane('up');
    await world.flush();
    assert.ok(layoutOf(world.home.snapshot()).do.includes(first), 'and back to Do now');
    actions.lane('up');
    assert.equal(
      getToasts().filter(t => t.message.startsWith('Moved to')).length,
      2,
      'nothing above Do now',
    );
    await world.flush();
  } finally {
    world.connection.close();
  }
});

test('Space on a Follow up row runs Reply (the nudge), falling back to open-for-reply when nothing handles it', async () => {
  resetToasts();
  const world = await boot();
  try {
    const follow = layoutOf(world.home.snapshot()).follow[0]!;
    const key = { current: follow as string | null };
    const { deps, ran, calls } = depsOver(world, key);
    createHomeActions(deps).suggested();
    assert.deepEqual(ran, ['mail.reply']);
    assert.deepEqual(
      calls.filter(c => c.startsWith('open:')),
      [`open:reply:${follow}`],
    );
  } finally {
    world.connection.close();
  }
});

test('Clear from Home sends Back from Later to Later in one operation with Undo', async () => {
  resetToasts();
  const world = await boot();
  try {
    const before = layoutOf(world.home.snapshot());
    if (before.fromLater.length === 0) return;
    const key = { current: null as string | null };
    const { deps } = depsOver(world, key);
    createHomeActions(deps).clearFromHome();
    assert.equal(layoutOf(world.home.snapshot()).fromLater.length, 0);
    assert.ok(getToasts().some(t => t.kind === 'later' && t.message === 'Moved to Later'));
    await world.flush();
  } finally {
    world.connection.close();
  }
});

test("the registry runs Home's commands: E is Done, Tab jumps a section, Z undoes", async () => {
  resetToasts();
  const world = await boot();
  try {
    const key = { current: null as string | null };
    const { deps } = depsOver(world, key);
    const registry = createAppRegistry();
    const detach = shellRegistryFor(registry).register(
      commandsForHome(createHomeActions(deps), {
        oneByOne: () => undefined,
        more: () => undefined,
        undo: () => void undoStack.undoLast(),
      }),
    );
    const context: CommandContext = {
      stack: ['global', 'list', 'home'],
      target: null,
      selection: [],
      conditions: {},
      prefs: DEFAULT_KEY_PREFS,
      focus: 'none',
    };
    const press = (k: string, mods: Partial<KeyboardEvent> = {}) => {
      const resolution = registry.resolve(
        { key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods },
        context,
      );
      assert.ok(resolution, `${k} resolves`);
      return registry.run(resolution.commandId, context).status;
    };
    const start = deps.snapshot().key!;
    assert.equal(press('Tab'), 'ran');
    assert.notEqual(key.current, start, 'Tab moved to another section');
    key.current = start;
    assert.equal(press('e'), 'ran');
    assert.ok(!world.home.snapshot().ids.includes(start));
    assert.equal(press('z'), 'ran');
    assert.ok(world.home.snapshot().ids.includes(start));
    detach();
    await world.flush();
  } finally {
    world.connection.close();
  }
});

test('a toast Undo undoes its own operation, not the newest one', async () => {
  resetToasts();
  const world = await boot();
  try {
    const [first, second] = layoutOf(world.home.snapshot()).do;
    assert.ok(first && second, 'the demo has two Do now rows');
    const key = { current: first as string | null };
    const { deps } = depsOver(world, key);
    const actions = createHomeActions(deps);
    actions.done();
    const older = getToasts().find(t => t.kind === 'done');
    assert.ok(older, 'the first Done toast');
    key.current = second;
    actions.done();
    runToastAction(older.id, 'undo');
    const ids = world.home.snapshot().ids;
    assert.ok(ids.includes(first), 'the older toast restored its own thread');
    assert.ok(!ids.includes(second), 'and left the newer one done');
    await world.flush();
  } finally {
    world.connection.close();
  }
});

test('every Done that needs a reply carries its own Remind, and Undo withdraws the offer', async () => {
  resetToasts();
  const world = await boot();
  try {
    const follow = layoutOf(world.home.snapshot()).follow;
    const [a, b] = follow;
    if (!a || !b) return;
    const key = { current: a as string | null };
    const { deps, offer } = depsOver(world, key);
    const actions = createHomeActions(deps);
    actions.done();
    const older = getToasts().find(t => t.kind === 'done');
    key.current = b;
    actions.done();
    assert.equal(offer(), b, 'R answers the newest offer');
    runToastAction(older!.id, 'remind');
    const reminded = getToasts().filter(t => t.message === 'Reminder set');
    assert.equal(reminded.length, 1, 'the older toast set its own reminder');
    assert.equal(offer(), b, 'and the newest offer is untouched');
    const newest = getToasts().find(t => t.kind === 'done' && t.id !== older!.id);
    runToastAction(newest!.id, 'undo');
    assert.equal(offer(), null, 'Undo on the offering toast ends the offer');
    await world.flush();
  } finally {
    world.connection.close();
  }
});

test('Later offers Set a date for its own thread, and D opens the picker for the cursor row', async () => {
  resetToasts();
  const world = await boot();
  try {
    const [first, second] = layoutOf(world.home.snapshot()).do;
    assert.ok(first && second);
    const key = { current: first as string | null };
    const { deps, calls } = depsOver(world, key);
    const actions = createHomeActions(deps);
    actions.later();
    const toast = getToasts().find(t => t.kind === 'later');
    assert.deepEqual(
      toast?.actions?.map(a => a.id),
      ['setDate', 'undo'],
    );
    assert.equal(toast?.actions?.[0]?.keysFrom, 'mail.setDate', 'D is drawn, not run');
    key.current = second;
    runToastAction(toast!.id, 'setDate');
    assert.deepEqual(
      calls.filter(c => c.startsWith('picker:')),
      [`picker:${first}`],
    );
    const registry = createAppRegistry();
    const detach = shellRegistryFor(registry).register(
      commandsForHome(actions, { oneByOne: () => {}, more: () => {}, undo: () => {} }),
    );
    const context: CommandContext = {
      stack: ['global', 'list', 'home'],
      target: null,
      selection: [],
      conditions: {},
      prefs: DEFAULT_KEY_PREFS,
      focus: 'none',
    };
    assert.equal(registry.run('mail.setDate', context).status, 'ran');
    assert.ok(calls.includes(`picker:${second}`), 'D re-dates the row under the cursor');
    detach();
    await world.flush();
  } finally {
    world.connection.close();
  }
});

test('the commit animates the row that was acted on, not the one under the cursor', async () => {
  resetToasts();
  const world = await boot();
  try {
    const [first, second] = layoutOf(world.home.snapshot()).do;
    assert.ok(first && second);
    const key = { current: first as string | null };
    const { deps, calls } = depsOver(world, key);
    createHomeActions(deps).done(second);
    assert.deepEqual(
      calls.filter(c => c.startsWith('commit:')),
      [`commit:done:${second}`],
    );
    await world.flush();
  } finally {
    world.connection.close();
  }
});
