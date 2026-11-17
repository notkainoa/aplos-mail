/**
 * "Go one by one" and "Why it's here" on the stand-in engine, in node with no DOM: the walk (`oneByOneSession`) runs
 * over the real data layer with Home's own actions, and the registry runs the view's command table. Covers S on Home,
 * the keys, committing through to the finish, a thread leaving Do now elsewhere, new mail mid-walk (seeded fuzz),
 * a rejected write coming back, and the Why entry. Run:
 * `cd apps/desktop && npx tsx --test 'src/renderer/screens/home/oneByOne.test.ts'`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createFixtureEngine, defaultNow } from '@aplos/contract-fixture';
import { fixtureControl } from '@aplos/contract-fixture/control';
import { createAppRegistry, DEFAULT_KEY_PREFS, type CommandContext } from '../../commands';
import { keydown, prng } from '../../commands/testing';
import { connectDataLayer } from '../../data/connect';
import { createManualScheduler, createManualTimers } from '../../data/scheduler';
import { api, setClock, type ThreadRow } from '../../data';
import { harnessClock } from '../../data/clock';
import { shellRegistryFor } from '../../shell/ShellRegistry';
import { getToasts, resetToasts } from '../../shell/store-toast';
import { dismissToast, pushToast } from '../../shell';
import { createHomeActions, describeHow, type HomeDeps, type HomeSnapshot } from './homeActions';
import { commandsForHome } from './homeCommands';
import { menuEntries } from './HomeMenu';
import { isStaleWhy, restoreListFocus } from './WhyHost';
import { OneByOneFinish } from './OneByOneStates';
import { OneByOneScreen } from './OneByOneScreen';
import { crumbOf } from './useOneByOne';
import { commandsForOneByOne, type OneByOneControls } from './oneByOneCommands';
import { doNowQueue, liveDoNow, type DoNowIds } from './oneByOneQueue';
import {
  beginSession,
  markActed,
  settleSession,
  shownId,
  stepSession,
  type Session,
} from './oneByOneSession';

const nextTask = () => new Promise<void>(resolve => setImmediate(resolve));
const NONE: ReadonlySet<string> = new Set();

async function settle(flush: () => void) {
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
  return { connection, home, control, flush };
}

type World = Awaited<ReturnType<typeof boot>>;

const rowOf = (world: World) => (id: string) =>
  world.home.snapshot().rows.get(id) as ThreadRow | undefined;

/** Do now's ids in the window right now (the `do` section and Back from Later). */
function doNow(world: World): DoNowIds {
  const snapshot = world.home.snapshot();
  const sliceOf = (key: string): string[] => {
    const section = snapshot.sections.find(s => s.key === key);
    if (!section) return [];
    const from = section.start - snapshot.position;
    return snapshot.ids.slice(from, from + section.count);
  };
  return { do: sliceOf('do'), fromLater: sliceOf('fromLater') };
}

/** Deps that do nothing, for a table that is only read. */
function inertDeps(): HomeDeps {
  const nothing = () => undefined;
  return {
    snapshot: () => ({ items: [], key: null, rowOf: () => undefined, state: null }),
    setCursor: nothing,
    act: args => api.thread.act(args),
    push: pushToast,
    dismiss: dismissToast,
    hold: { extend: nothing },
    offerReminder: nothing,
    reminderOffer: () => null,
    openDatePicker: nothing,
    openThread: nothing,
    openLow: nothing,
    oneByOne: nothing,
    openMore: nothing,
    undoLabel: (_id, fallback) => fallback,
    forward: () => undefined,
  };
}

/** The view's logic without React: a session over the live window, and Home's actions on the thread showing. */
function walkerOver(world: World) {
  const log: string[] = [];
  const state: { session: Session; arrived: string[] } = {
    session: beginSession(doNowQueue(doNow(world), rowOf(world))),
    arrived: [],
  };
  const live = () => liveDoNow(doNow(world));
  const shown = () => shownId(state.session, live());
  const deps: HomeDeps = {
    snapshot: (): HomeSnapshot => {
      const id = shown();
      return {
        items: id === null ? [] : [{ kind: 'row', id, section: 'do' }],
        key: id,
        rowOf: rowOf(world),
        state: world.home.snapshot().state,
      };
    },
    setCursor: () => undefined,
    act: args => api.thread.act(args),
    push: pushToast,
    dismiss: dismissToast,
    hold: { extend: () => undefined },
    commit: (_kind, _ids, rowId) => {
      state.session = markActed(state.session, rowId);
    },
    offerReminder: () => undefined,
    reminderOffer: () => null,
    openDatePicker: () => undefined,
    openThread: (id, how) => void log.push(`open:${describeHow(how)}:${id}`),
    openLow: () => undefined,
    oneByOne: () => undefined,
    openMore: () => undefined,
    undoLabel: (_id, fallback) => fallback,
    forward: () => undefined,
  };
  const actions = createHomeActions(deps);
  const settleNow = () => {
    state.session = settleSession(state.session, live(), NONE);
  };
  return {
    state,
    actions,
    log,
    shown: () => {
      settleNow();
      return shown();
    },
    step: (delta: 1 | -1) => {
      state.session = stepSession(state.session, live(), delta);
    },
  };
}

const context: CommandContext = {
  stack: ['global', 'list', 'home'],
  target: null,
  selection: [],
  conditions: {},
  prefs: DEFAULT_KEY_PREFS,
  focus: 'none',
};

test('S on Home goes one by one, and I opens Why it is here', () => {
  const registry = createAppRegistry();
  const calls: string[] = [];
  const noop = () => undefined;
  const actions = createHomeActions(inertDeps());
  const detach = shellRegistryFor(registry).register(
    commandsForHome(actions, {
      oneByOne: () => void calls.push('oneByOne'),
      more: noop,
      why: () => void calls.push('why'),
      undo: noop,
    }),
  );
  for (const key of ['s', 'i']) {
    const resolution = registry.resolve(keydown(key), context);
    assert.ok(resolution, `${key} resolves`);
    assert.equal(registry.run(resolution.commandId, context).status, 'ran');
  }
  assert.deepEqual(calls, ['oneByOne', 'why']);
  detach();
});

test('the one-by-one keys run the right actions: J/K step, E and L commit, Space acts, R and ⇧R open the reply, Esc exits', async () => {
  resetToasts();
  const world = await boot();
  try {
    const walker = walkerOver(world);
    const calls: string[] = [];
    const controls: OneByOneControls = {
      step: delta => void calls.push(`step:${delta}`),
      open: () => void calls.push('open'),
      more: () => void calls.push('more'),
      why: () => void calls.push('why'),
      lane: direction => void calls.push(`lane:${direction}`),
      undo: () => void calls.push('undo'),
      back: () => void calls.push('back'),
    };
    const registry = createAppRegistry();
    const detach = shellRegistryFor(registry).register(
      commandsForOneByOne(walker.actions, controls),
    );
    const press = (key: string, mods = {}) => {
      const resolution = registry.resolve(keydown(key, mods), context);
      assert.ok(resolution, `${key} resolves`);
      return registry.run(resolution.commandId, context).status;
    };
    for (const key of ['j', 'k', 'o', 'i', '.', 'Escape']) assert.equal(press(key), 'ran', key);
    const card = walker.shown()!;
    assert.equal(press('r'), 'ran');
    assert.equal(press('R', { shiftKey: true }), 'ran');
    assert.deepEqual(walker.log, [`open:reply:${card}`, `open:replyAll:${card}`]);
    assert.equal(press('ArrowDown', { altKey: true }), 'ran');
    assert.deepEqual(calls, ['step:1', 'step:-1', 'open', 'why', 'more', 'back', 'lane:down']);
    const first = walker.shown()!;
    assert.equal(press('e'), 'ran');
    assert.ok(!doNow(world).do.includes(first), 'E sent it to Done');
    assert.ok(
      getToasts().some(t => t.kind === 'done'),
      'with Home’s own Done toast',
    );
    const second = walker.shown()!;
    assert.notEqual(second, first, 'and the walk moved on');
    assert.equal(press('l'), 'ran');
    assert.ok(!doNow(world).do.includes(second), 'L set it aside');
    assert.ok(getToasts().some(t => t.kind === 'later'));
    const third = walker.shown();
    assert.notEqual(third, null);
    const before = getToasts().length + walker.log.length;
    assert.equal(press(' '), 'ran');
    assert.ok(getToasts().length + walker.log.length > before, 'Space ran the suggested action');
    detach();
    await world.flush();
  } finally {
    world.connection.close();
  }
});

test('committing every thread walks the queue in order, once each, and finishes', async () => {
  resetToasts();
  const world = await boot();
  try {
    const walker = walkerOver(world);
    const queue = [...walker.state.session.walk.queue];
    assert.ok(queue.length >= 3, 'the demo has Do now threads');
    const seen: string[] = [];
    for (let shown = walker.shown(); shown !== null; shown = walker.shown()) {
      seen.push(shown);
      walker.actions.done();
      assert.ok(seen.length <= queue.length, 'never revisits a committed thread');
    }
    assert.deepEqual(seen, queue);
    assert.equal(walker.shown(), null, 'the walk is over');
    await world.flush();
  } finally {
    world.connection.close();
  }
});

test('a thread that leaves Do now elsewhere is skipped, and Done at the tail goes back', async () => {
  resetToasts();
  const world = await boot();
  try {
    const walker = walkerOver(world);
    const [first, second, third] = walker.state.session.walk.queue;
    assert.equal(walker.shown(), first);
    api.thread.act({ ids: [second!], action: { type: 'lane', lane: 'update' } });
    await world.flush();
    walker.actions.done();
    assert.equal(walker.shown(), third, 'the second one is gone from Do now: skipped');
    // Walk to the last live thread and commit it: with nothing after, the walk goes back to one before it.
    const live = () => liveDoNow(doNow(world));
    while (shownId(walker.state.session, live()) !== walker.state.session.walk.queue.at(-1)) {
      walker.step(1);
    }
    const last = walker.shown()!;
    walker.actions.done();
    const back = walker.shown();
    assert.notEqual(back, null);
    assert.notEqual(back, last);
    assert.ok(live().has(back!), 'the one before it, still in Do now');
    await world.flush();
  } finally {
    world.connection.close();
  }
});

test('fuzz: new mail arriving mid-walk never changes the thread under view or joins the queue', async () => {
  resetToasts();
  const world = await boot();
  try {
    const random = prng(20261103);
    const walker = walkerOver(world);
    const accountId = rowOf(world)(walker.state.session.walk.queue[0]!)!.accountId;
    let arrivals = 0;
    for (let op = 0; op < 300; op++) {
      const shown = walker.shown();
      const roll = random();
      if (shown === null) {
        // The walk ended: open a new one, as the owner pressing S again would, over today's Do now.
        walker.state.session = beginSession(doNowQueue(doNow(world), rowOf(world)));
        walker.state.arrived = [];
        continue;
      }
      if (roll < 0.35) walker.step(1);
      else if (roll < 0.7) walker.step(-1);
      else if (roll < 0.8) {
        walker.actions.done();
        await world.flush();
      } else {
        arrivals += 1;
        const { threadId } = await world.control.deliverMail({
          accountId,
          fromName: `Arrival ${arrivals}`,
          from: `arrival${arrivals}@field.example`,
          subject: `Arrival ${arrivals}`,
          body: 'New mail during the walk.',
          lane: 'do',
        });
        walker.state.arrived.push(threadId);
        await world.flush();
        assert.equal(walker.shown(), shown, `op ${op}: the thread under view did not change`);
      }
      const queue = walker.state.session.walk.queue;
      for (const id of walker.state.arrived)
        assert.ok(!queue.includes(id), `op ${op}: ${id} arrived after the walk began`);
      const now = walker.shown();
      assert.ok(now === null || queue.includes(now), `op ${op}: only queued threads show`);
    }
    assert.ok(arrivals > 10, 'the fuzz delivered mail');
  } finally {
    world.connection.close();
  }
});

test('a committed thread whose write the engine rejected comes back with its error', () => {
  let session = beginSession(['a', 'b', 'c']);
  session = markActed(session, 'a');
  session = settleSession(session, new Set(['b', 'c']), NONE);
  assert.equal(shownId(session, new Set(['b', 'c'])), 'b');
  const live = new Set(['a', 'b', 'c']);
  const back = settleSession(session, live, new Set(['a']));
  assert.equal(shownId(back, live), 'a', 'the failed thread shows again');
  const walkOn = stepSession(back, live, 1);
  assert.equal(shownId(settleSession(walkOn, live, new Set(['a'])), live), 'b', 'once, not again');
});

test('Why it is here: the menu offers it between Bookmark and Trash, and a lane correction runs once', async () => {
  resetToasts();
  const world = await boot();
  try {
    const first = doNow(world).do[0]!;
    const entries = menuEntries(rowOf(world)(first));
    assert.deepEqual(
      entries.map(entry => (entry.kind === 'item' ? entry.id : entry.kind)),
      [
        'suggested',
        'later',
        'done',
        'separator',
        'setDate',
        'bookmark',
        'why',
        'separator',
        'trash',
      ],
    );
    const why = entries.find(entry => entry.kind === 'item' && entry.id === 'why');
    assert.equal(why?.kind === 'item' ? why.commandId : null, 'mail.why');

    const answer = await api.thread.why({ threadId: first });
    assert.ok(answer.sentence.length > 0, 'one sentence');
    assert.equal(answer.lane, 'do');

    const walker = walkerOver(world);
    const lanes = () => getToasts().filter(toast => toast.message.startsWith('Moved to'));
    walker.actions.lane('down');
    assert.equal(lanes().length, 1, 'one operation, one toast');
    assert.equal(rowOf(world)(first)?.rank.lane, 'update');
    await world.flush();
  } finally {
    world.connection.close();
  }
});

test('the finish is one calm line with a quiet way back, and the walk shows nothing before it is live', () => {
  const finished = renderToStaticMarkup(
    createElement(OneByOneFinish, { nothing: false, onBack: () => undefined }),
  );
  assert.match(finished, /That’s everyone(?!\.)/);
  assert.match(finished, /Back to Home/);
  const empty = renderToStaticMarkup(
    createElement(OneByOneFinish, { nothing: true, onBack: () => undefined }),
  );
  assert.match(empty, /Nothing to go through(?!\.)/);
});

test('the view renders the first Do-now thread as one email card, with no list around it', async () => {
  resetToasts();
  const world = await boot();
  try {
    const first = doNowQueue(doNow(world), rowOf(world))[0]!;
    const html = renderToStaticMarkup(
      createElement(OneByOneScreen, { onExit: () => undefined, onOpen: () => undefined }),
    );
    assert.match(html, /class="aplos-one-by-one__card"/, 'the card the menus hang from');
    assert.equal((html.match(/class="aplos-reader__letter"/g) ?? []).length, 1, 'one letter');
    assert.ok(html.includes(`data-thread="${first}"`), 'the first thread’s letter');
    assert.ok(!html.includes('role="option"'), 'no focus letter or list row');
    assert.ok(!html.includes('Do now'), 'no section label');
  } finally {
    world.connection.close();
  }
});

test('Undo on the last committed thread reopens the finished walk on it, and K reaches the one before', () => {
  let session = beginSession(['a', 'b', 'c']);
  session = markActed(session, 'a');
  session = settleSession(session, new Set(['b', 'c']), NONE);
  session = markActed(session, 'b');
  session = settleSession(session, new Set(['c']), NONE);
  session = markActed(session, 'c');
  session = settleSession(session, new Set(), NONE);
  assert.equal(shownId(session, new Set()), null, 'the walk is over');
  const live = new Set(['c']);
  const back = settleSession(session, live, NONE);
  assert.equal(shownId(back, live), 'c', 'Undo brought c back, and it shows');
  const both = new Set(['b', 'c']);
  const stepped = stepSession(settleSession(back, both, NONE), both, -1);
  assert.equal(shownId(stepped, both), 'b', 'K goes to the one before');
  assert.equal(settleSession(stepped, both, NONE), stepped, 'and nothing reopens again');
});

test('Undo on a thread committed mid-walk steps the walk back to it, and a second Undo steps back again', () => {
  let session = beginSession(['a', 'b', 'c', 'd']);
  session = markActed(session, 'a');
  session = settleSession(session, new Set(['b', 'c', 'd']), NONE);
  session = markActed(session, 'b');
  session = settleSession(session, new Set(['c', 'd']), NONE);
  assert.equal(shownId(session, new Set(['c', 'd'])), 'c');
  const withB = new Set(['b', 'c', 'd']);
  const first = settleSession(session, withB, NONE);
  assert.equal(shownId(first, withB), 'b', 'Undo of b shows b');
  assert.equal(settleSession(first, withB, NONE), first, 'and nothing steps again');
  const all = new Set(['a', 'b', 'c', 'd']);
  assert.equal(shownId(settleSession(first, all, NONE), all), 'a', 'Undo of a shows a');
});

test('a committed thread that leaves and comes back with a rejected write is shown once, not stepped to twice', () => {
  let session = beginSession(['a', 'b', 'c']);
  session = markActed(session, 'a');
  session = settleSession(session, new Set(['b', 'c']), NONE);
  const live = new Set(['a', 'b', 'c']);
  const back = settleSession(session, live, new Set(['a']));
  assert.equal(shownId(back, live), 'a', 'the failed thread shows with its error');
  assert.equal(settleSession(back, live, new Set(['a'])), back, 'and nothing steps again');
});

test('a thread Undo brought back ahead of the walk does not pull it back once the walk has passed it', () => {
  let session = beginSession(['a', 'b', 'c', 'd']);
  session = stepSession(session, new Set(['a', 'b', 'c', 'd']), 1);
  session = markActed(session, 'b');
  session = settleSession(session, new Set(['a', 'c', 'd']), NONE);
  const all = new Set(['a', 'b', 'c', 'd']);
  session = stepSession(session, new Set(['a', 'c', 'd']), -1);
  session = settleSession(session, all, NONE);
  assert.equal(shownId(session, all), 'a', 'b is ahead: the walk stays');
  session = stepSession(stepSession(session, all, 1), all, 1);
  session = stepSession(session, all, 1);
  assert.equal(
    shownId(settleSession(session, all, NONE), all),
    'd',
    'and walking past b stays past it',
  );
});

test('a thread still live after a J past it is not mistaken for an undo', () => {
  let session = beginSession(['a', 'b', 'c']);
  session = markActed(session, 'a');
  const live = new Set(['a', 'b', 'c']);
  session = stepSession(session, live, 1);
  assert.equal(shownId(settleSession(session, live, NONE), live), 'b');
});

test('Why closes into the list, and drops when the cursor has left its thread', () => {
  const focused: unknown[] = [];
  const listbox = { focus: (options?: FocusOptions) => void focused.push(options) };
  restoreListFocus(selector => (selector === '[role="listbox"]' ? listbox : null));
  assert.deepEqual(focused, [{ preventScroll: true }], 'focus goes to the listbox, not the option');
  restoreListFocus(() => null);
  const anchor = { id: 'x' } as unknown as HTMLElement;
  assert.equal(isStaleWhy({ id: 'a', anchor }, 'a'), false);
  assert.equal(isStaleWhy({ id: 'a', anchor }, 'b'), true, 'cursor moved while it loaded');
  assert.equal(isStaleWhy({ id: 'a', anchor }, null), true);
});

test('the pane header reads "‹ Home" and carries "1 of 6" apart, to be centred over the card', () => {
  let exits = 0;
  const part = crumbOf({ index: 1, of: 6 }, () => (exits += 1));
  assert.equal(part.lead?.label, 'Back to Home');
  assert.equal(part.crumb?.label, 'Home', 'the back button names where it goes');
  assert.deepEqual(part.crumb?.position, { index: 1, of: 6 });
  assert.equal(
    part.crumb?.centrePosition,
    true,
    'the counter is drawn centred, not after the crumb',
  );
  part.lead?.onPress();
  assert.equal(exits, 1);
  assert.equal(crumbOf(null, () => undefined).crumb?.position, undefined);
});
