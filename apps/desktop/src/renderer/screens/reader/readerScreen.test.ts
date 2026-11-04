/**
 * The reader on the stand-in engine, in node with no DOM: the letter rendered with react-dom/server over windows the
 * test opened first (the pattern of `home/homeScreen.test.ts`), and the actions run against the real data layer.
 * Covers the four parts in order, the off-paper letter, J/K through the registry, Done removing the thread with an
 * Undo toast and the next thread coming up, the refused write, Space and R, and Z.
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
import { shellRegistryFor } from '../../shell/ShellRegistry';
import { setOpenThread } from '../../shell/store-thread';
import { getToasts, resetToasts, runToastAction } from '../../shell/store-toast';
import { createLetterController } from './letterController';
import { createReaderActions, whileOpen, type ReaderDeps } from './readerActions';
import { afterAccepted } from '../undoOperation';
import { settleFocus } from './readerFocus';
import { takeFocus } from './FindBar';
import { commandsForReader } from './readerCommands';
import { ReaderLetter, GONE_COPY } from './ReaderLetter';
import { ReaderScreen, NO_THREAD_COPY } from './ReaderScreen';
import { PLAIN_REPLY, freshUi, reduceUi, type ReaderUi, type ReplyRequest } from './readerUi';

const NO_CONTROLS = {
  suggest: () => undefined,
  later: () => undefined,
  done: () => undefined,
  reply: () => undefined,
  relayKey: () => false,
};

const nextTask = () => new Promise<void>(resolve => setImmediate(resolve));

async function settle(flush: () => void) {
  for (let i = 0; i < 20; i++) {
    await nextTask();
    flush();
  }
}

/** Two earlier messages (a day apart) in front of a demo thread's one message, for the compact cards. */
function seedEarlier(engine: ReturnType<typeof createFixtureEngine>, threadId: string): void {
  const fx = engine.fixture;
  const last = fx.store.get('Message', `${threadId}.m1`);
  if (!last) return;
  const bodies = [
    'Kicking off: here is the brief we agreed on Friday. Please read it before Monday and tell me what is missing from it.',
    'Thanks, that helps. Two things to keep in mind before we start.',
  ];
  bodies.forEach((body, index) => {
    fx.write({ kind: 'Fixture/control' }, tx => {
      tx.put('Message', {
        ...last,
        id: `${threadId}.e${index + 1}`,
        rev: 0,
        snippet: body,
        date: last.date - (bodies.length - index) * 86_400_000,
        seen: true,
        attachments: [],
      });
    });
  });
}

async function boot(seed?: string) {
  const engine = createFixtureEngine({ scenario: 'demo', clock: defaultNow });
  if (seed) seedEarlier(engine, seed);
  const scheduler = createManualScheduler();
  const connection = connectDataLayer({
    session: engine.connect(),
    scheduler,
    timers: createManualTimers(defaultNow),
  });
  const { layer } = connection;
  const home = layer.windows.acquire({ kind: 'home' });
  for (const name of ['accounts', 'counts', 'settings'] as const) layer.session.want(name);
  setClock(harnessClock);
  await settle(() => scheduler.flush());
  const doIds = () => {
    const snap = home.snapshot();
    const section = snap.sections.find(s => s.key === 'do');
    return section
      ? snap.ids.slice(section.start - snap.position, section.start - snap.position + section.count)
      : [];
  };
  const threadWindow = async (threadId: string) => {
    const window = layer.windows.acquire({ kind: 'thread', threadId });
    await settle(() => scheduler.flush());
    return window;
  };
  return { connection, home, doIds, threadWindow, flush: () => settle(() => scheduler.flush()) };
}

type World = Awaited<ReturnType<typeof boot>>;

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** The deps the screen builds, over the real data layer, the home window as the list, and a letter buffer. */
function depsOver(world: World, start: string, readyOnGo = true) {
  const controller = createLetterController(createManualTimers(0));
  const state = {
    open: start,
    left: 0,
    gone: new Set<string>(),
    findOpen: false,
    replies: [] as string[],
    requests: [] as Array<ReplyRequest | undefined>,
    suggested: [] as string[],
  };
  controller.want(start);
  controller.ready(start);
  const go = (id: string) => {
    state.open = id;
    controller.want(id);
    if (readyOnGo) controller.ready(id);
  };
  const deps: ReaderDeps = {
    shown: () => controller.snapshot().letter,
    wanted: () => state.open,
    ids: () => world.home.snapshot().ids,
    rowOf: id => world.home.snapshot().rows.get(id) as ThreadRow | undefined,
    go,
    reopen: go,
    markGone: (id, gone) => void (gone ? state.gone.add(id) : state.gone.delete(id)),
    leave: () => void state.left++,
    closeFind: () => {
      const was = state.findOpen;
      state.findOpen = false;
      return was;
    },
    act: args => api.thread.act(args),
    push: pushToast,
    dismiss: () => undefined,
    undoLabel: (_id, fallback) => fallback,
    reply: (id, request) => {
      state.replies.push(id);
      state.requests.push(request);
    },
    suggested: (id, action) => void state.suggested.push(`${id}:${action.verb}`),
  };
  return { deps, state, controller };
}

const renderLetter = (id: string, over: Partial<ReaderUi> = {}, paper = true) =>
  renderToStaticMarkup(
    createElement(ReaderLetter, {
      threadId: id,
      paper,
      ui: { ...freshUi(id), ...over },
      dispatch: () => undefined,
      controls: NO_CONTROLS,
      onReady: () => undefined,
    }),
  );

test('the letter shows its parts in order inside one column: summary, thread, stub, then the pinned bar; no sender line on top', async () => {
  const world = await boot();
  try {
    const id = world.doIds()[0]!;
    await world.threadWindow(id);
    const html = renderLetter(id);
    const parts = [
      'ui-reader-head__summary',
      'ui-reader-head__rule',
      'aplos-reader__thread',
      'ui-thread-message__head',
      'ui-reply-stub',
      'ui-reader-actions',
    ].map(part => html.indexOf(part));
    assert.ok(
      parts.every(p => p >= 0),
      `all present: ${parts}`,
    );
    assert.deepEqual(
      [...parts].sort((a, b) => a - b),
      parts,
      'summary, hairline, thread, stub, actions',
    );
    assert.doesNotMatch(
      html.slice(0, html.indexOf('aplos-reader__thread')),
      /ui-reader-head__(from|name|to|when)|<time/,
      'no sender or time above the thread: they live in the message cards',
    );
    assert.doesNotMatch(
      html,
      /aplos-reader__subject|[0-9] messages?<\/h2>/,
      'no subject and count line',
    );
    assert.equal(
      html.match(/class="ui-reader-actions"/g)?.length,
      1,
      'the action bar is there once',
    );
    assert.match(html, /data-paper="true"/);
    assert.doesNotMatch(html, /margin-rail|ui-rail|inert/);
    assert.match(html, /<kbd[^>]*>Space<\/kbd>/, 'Space on the main action');
    assert.equal(
      html.match(/data-variant="filled"/g)?.length,
      1,
      'one filled button: the suggestion',
    );
    assert.match(
      html,
      /data-variant="filled"[^>]*title="Reply · Space\. Hold R to dictate a reply"/,
    );
    assert.match(text(html), /Later/);
    assert.match(text(html), /Done|Reply/);
    assert.match(text(html), /Reply to \w+…/);
    assert.doesNotMatch(
      renderLetter(id, {}, false),
      /ui-reader-actions/,
      'an off-paper letter draws no bar, so there is never a second one',
    );
    assert.match(
      renderLetter(id, { replyOpen: true }),
      /ui-reader-actions" data-demoted="true"/,
      'while the reply is open the bar rests under it',
    );
  } finally {
    world.connection.close();
  }
});

const EARLIER_THREAD = 'demo-work:design';

test('earlier messages are compact cards: head and an excerpt ending in an ellipsis; a click or O opens one, aria-expanded says so', async () => {
  const world = await boot(EARLIER_THREAD);
  try {
    const id = EARLIER_THREAD;
    await world.threadWindow(id);
    const ids = [...renderLetter(id).matchAll(/<article id="([^"]+)"/g)].map(m => m[1]!);
    assert.equal(ids.length, 3, 'two earlier messages and the latest');
    const compact = renderLetter(id);
    const first = ids[0]!;
    const card = (html: string, mid: string) =>
      html.slice(html.indexOf(`<article id="${mid}"`)).split('</article>')[0]!;
    assert.match(card(compact, first), /data-fold="folded"/);
    assert.match(card(compact, first), /class="ui-thread-message__toggle" aria-expanded="false"/);
    assert.match(card(compact, first), /ui-thread-message__excerpt" dir="auto">[^<]+…</);
    assert.doesNotMatch(card(compact, first), /ui-thread-message__body|<iframe/);
    assert.doesNotMatch(
      card(compact, ids.at(-1)!),
      /data-fold|ui-thread-message__toggle/,
      'the latest is always open',
    );
    const opened = renderLetter(id, { opened: [first], cursor: first });
    assert.match(card(opened, first), /data-fold="open"/);
    assert.match(card(opened, first), /aria-expanded="true"/);
    assert.doesNotMatch(card(opened, first), /ui-thread-message__excerpt/);
    assert.match(card(opened, first), /ui-thread-message__body/);
    assert.match(card(opened, first), /data-cursor="true"/);
  } finally {
    world.connection.close();
  }
});

test('a letter laying itself out is off paper, hidden from assistive tech and inert', async () => {
  const world = await boot();
  try {
    const id = world.doIds()[0]!;
    await world.threadWindow(id);
    const html = renderToStaticMarkup(
      createElement(ReaderLetter, {
        threadId: id,
        paper: false,
        ui: freshUi(id),
        dispatch: () => undefined,
        controls: NO_CONTROLS,
        onReady: () => undefined,
      }),
    );
    assert.match(html, /data-paper="false"/);
    assert.match(html, /aria-hidden="true"/);
    assert.match(html, /inert/);
  } finally {
    world.connection.close();
  }
});

test('a thread that is gone says so in one plain sentence', async () => {
  const world = await boot();
  try {
    const { layer } = world.connection;
    layer.rows.retain('Thread', ['no-such-thread']);
    layer.fetcher.request('Thread', ['no-such-thread']);
    await world.flush();
    const html = renderToStaticMarkup(
      createElement(ReaderLetter, {
        threadId: 'no-such-thread',
        paper: true,
        ui: freshUi('no-such-thread'),
        dispatch: () => undefined,
        controls: NO_CONTROLS,
        onReady: () => undefined,
      }),
    );
    assert.equal(text(html), GONE_COPY);
    assert.doesNotMatch(html, /ui-reader-head/);
  } finally {
    world.connection.close();
  }
});

test('the screen: no thread open is one plain line; an open thread mounts its letter off paper until it reports', async () => {
  const world = await boot();
  try {
    setOpenThread(null);
    assert.match(
      text(renderToStaticMarkup(createElement(ReaderScreen))),
      new RegExp(NO_THREAD_COPY),
    );
    const id = world.doIds()[0]!;
    await world.threadWindow(id);
    setOpenThread(id);
    const html = renderToStaticMarkup(createElement(ReaderScreen));
    assert.match(html, /class="aplos-reader" data-keyctx="reader"/);
    assert.match(
      html,
      /class="aplos-reader"[^>]*tabindex="-1"/,
      'a root that can take focus when an element leaves',
    );
    assert.match(html, /data-paper="false"/, 'nothing is on paper before the first letter reports');
    assert.doesNotMatch(html, /ui-loading-line/, 'and no loading line before 1.5 s');
    setOpenThread(null);
  } finally {
    world.connection.close();
  }
});

test('J and K go through the registry to the next and previous thread of the list', async () => {
  const world = await boot();
  try {
    const ids = world.home.snapshot().ids;
    const { deps, state } = depsOver(world, ids[1]!);
    const registry = createAppRegistry();
    const detach = shellRegistryFor(registry).register(
      commandsForReader(createReaderActions(deps)),
    );
    const context: CommandContext = {
      stack: ['global', 'list', 'reader'],
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
      return registry.run(resolution.commandId, context);
    };
    assert.equal(press('j').status, 'ran');
    assert.equal(state.open, ids[2]);
    assert.equal(press('j').status, 'ran');
    assert.equal(state.open, ids[3], 'two presses, two threads');
    assert.equal(press('k').status, 'ran');
    assert.equal(state.open, ids[2]);
    detach();
  } finally {
    world.connection.close();
  }
});

test('E removes the thread at once, offers Undo on one toast, and the next thread shows', async () => {
  resetToasts();
  const world = await boot();
  try {
    const ids = world.doIds();
    const first = ids[0]!;
    const second = ids[1]!;
    const { deps, state, controller } = depsOver(world, first, false);
    const actions = createReaderActions(deps);
    actions.done();
    assert.ok(!world.home.snapshot().ids.includes(first), 'the overlay removed it synchronously');
    assert.equal(state.open, second, 'the reader moved to the next thread of the list');
    assert.equal(
      controller.snapshot().letter,
      first,
      'the letter on paper stays until the next reports',
    );
    const toast = getToasts().find(t => t.kind === 'done');
    assert.ok(toast, 'a Done toast');
    assert.equal(toast.undoable, true);
    assert.deepEqual(
      toast.actions?.map(a => a.id),
      ['undo'],
    );
    assert.equal(state.left, 0, 'the list was not left: a thread is still open');
    actions.done();
    assert.equal(
      getToasts().filter(t => t.kind === 'done').length,
      1,
      'a second E before the next letter is on paper does not Done the same thread twice',
    );
    controller.ready(second);
    assert.equal(controller.snapshot().letter, second, 'and then the next letter is on paper');
    undoStack.undoLast();
    assert.ok(world.home.snapshot().ids.includes(first), 'Undo put it back');
    await world.flush();
  } finally {
    world.connection.close();
  }
});

test('Later and Trash leave the same way with their own words', async () => {
  resetToasts();
  const world = await boot();
  try {
    const ids = world.doIds();
    const { deps, state } = depsOver(world, ids[0]!);
    const actions = createReaderActions(deps);
    actions.later();
    assert.equal(state.open, ids[1]);
    actions.trash();
    assert.equal(state.open, ids[2]);
    const messages = getToasts().map(t => t.message);
    assert.ok(messages.includes('Moved to Later'));
    assert.ok(messages.includes('Moved to Trash'));
    await world.flush();
  } finally {
    world.connection.close();
  }
});

test('the last thread of the list goes back to the list when it is done', async () => {
  resetToasts();
  const world = await boot();
  try {
    const only = world.doIds()[0]!;
    const { deps, state } = depsOver(world, only);
    deps.ids = () => [only];
    createReaderActions(deps).done();
    assert.equal(state.left, 1, 'closed the reader');
    assert.equal(state.open, only, 'and opened nothing');
    await world.flush();
  } finally {
    world.connection.close();
  }
});

test('a refused write says what it could not do, once, and keeps the reader where it moved', async () => {
  resetToasts();
  const world = await boot();
  try {
    const ids = world.doIds();
    const { deps, state } = depsOver(world, ids[0]!);
    const dismissed: string[] = [];
    deps.act = () => ({ opId: 'op-refused', receipt: Promise.reject(new Error('no')) }) as never;
    deps.dismiss = id => void dismissed.push(id);
    createReaderActions(deps).done();
    await nextTask();
    assert.deepEqual(dismissed, ['op-refused']);
    const failure = getToasts().find(t => t.id === 'op-refused-failed');
    assert.equal(failure?.message, 'Couldn’t mark it done.');
    assert.equal(state.open, ids[1]);
  } finally {
    world.connection.close();
  }
});

test('Space runs the suggestion and R replies; neither is the reader’s to implement yet', async () => {
  const world = await boot();
  try {
    const ids = world.doIds();
    const { deps, state } = depsOver(world, ids[0]!);
    const actions = createReaderActions(deps);
    actions.reply();
    assert.deepEqual(state.replies, [ids[0]]);
    actions.suggest();
    const row = deps.rowOf(ids[0]!)!;
    const verb = row.summary.action?.label ?? 'Reply';
    const handled =
      state.replies.length === 2 || state.suggested.length === 1 || state.open !== ids[0];
    assert.ok(handled, `Space did something for the "${verb}" suggestion`);
    await world.flush();
  } finally {
    world.connection.close();
  }
});

test('bookmark toggles in place and keeps the reader on the thread', async () => {
  resetToasts();
  const world = await boot();
  try {
    const ids = world.doIds();
    const { deps, state } = depsOver(world, ids[0]!);
    createReaderActions(deps).bookmark();
    assert.equal(state.open, ids[0]);
    assert.ok(
      getToasts().some(t => t.message === 'Bookmarked' || t.message === 'Bookmark removed'),
    );
    await world.flush();
  } finally {
    world.connection.close();
  }
});

test('R, ⇧R and hold R go through the registry to the inline reply, each asking for its own kind', async () => {
  const world = await boot();
  try {
    const { deps, state } = depsOver(world, world.doIds()[0]!);
    const registry = createAppRegistry();
    const detach = shellRegistryFor(registry).register(
      commandsForReader(createReaderActions(deps)),
    );
    const context: CommandContext = {
      stack: ['global', 'list', 'reader'],
      target: null,
      selection: [],
      conditions: {},
      prefs: DEFAULT_KEY_PREFS,
      focus: 'none',
    };
    const key = (k: string, shiftKey = false) => ({
      key: k,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey,
    });
    const press = (k: string, shift = false) => {
      const resolution = registry.resolve(key(k, shift), context);
      assert.ok(resolution, `${k} resolves`);
      return registry.run(resolution.commandId, context);
    };
    assert.equal(press('r').status, 'ran');
    assert.equal(press('R', true).status, 'ran');
    assert.equal(registry.run('mail.dictateReply', context).status, 'ran');
    assert.deepEqual(state.requests, [
      PLAIN_REPLY,
      { replyAll: true, dictate: false },
      { replyAll: false, dictate: true },
    ]);
    detach();
  } finally {
    world.connection.close();
  }
});

test('an open reply replaces the stub and demotes the filled suggestion; closed, the stub is back', async () => {
  const world = await boot();
  try {
    const id = world.doIds()[0]!;
    await world.threadWindow(id);
    const render = (ui: ReturnType<typeof freshUi>) =>
      renderToStaticMarkup(
        createElement(ReaderLetter, {
          threadId: id,
          paper: true,
          ui,
          dispatch: () => undefined,
          controls: NO_CONTROLS,
          onReady: () => undefined,
        }),
      );
    const closed = render(freshUi(id));
    assert.match(closed, /ui-reply-stub/);
    assert.equal(closed.match(/data-variant="filled"/g)?.length, 1);
    assert.doesNotMatch(closed, /data-demoted="true"/);

    let ui = reduceUi(freshUi(id), { type: 'openReply', request: PLAIN_REPLY });
    ui = reduceUi(ui, { type: 'replyOpen', open: true });
    const open = render(ui);
    assert.doesNotMatch(open, /ui-reply-stub/, 'the host stands where the stub was');
    assert.match(open, /data-demoted="true"/);
    assert.equal(
      open.match(/data-variant="filled"/g)?.length ?? 0,
      0,
      'the filled button belongs to the open composer',
    );

    ui = reduceUi(ui, { type: 'closeReply' });
    assert.equal(ui.reply, null);
    assert.equal(ui.replyOpen, false);
    assert.match(render(ui), /ui-reply-stub/, 'Esc closed it: the stub shows again');
  } finally {
    world.connection.close();
  }
});

test('E, J, E before the next letter lands does not run Done on the thread that already left', async () => {
  resetToasts();
  const world = await boot();
  try {
    const ids = world.doIds();
    const { deps, state, controller } = depsOver(world, ids[0]!, false);
    const actions = createReaderActions(deps);
    actions.done();
    actions.step('next');
    actions.done();
    assert.equal(
      getToasts().filter(t => t.kind === 'done').length,
      1,
      'the shown letter is still the one that left: nothing happens, nothing is cleared',
    );
    assert.ok(state.gone.has(ids[0]!));
    controller.ready(state.open);
    actions.done();
    assert.equal(
      getToasts().filter(t => t.kind === 'done').length,
      2,
      'the next letter takes E once it lands',
    );
    await world.flush();
  } finally {
    world.connection.close();
  }
});

test('Undo of a Done brings the reader back to the thread and lets J and K see it again', async () => {
  resetToasts();
  const world = await boot();
  try {
    const ids = world.doIds();
    const first = ids[0]!;
    const { deps, state } = depsOver(world, first);
    const actions = createReaderActions(deps);
    actions.done();
    assert.notEqual(state.open, first);
    assert.ok(state.gone.has(first));
    const toast = getToasts().find(t => t.kind === 'done');
    assert.ok(toast, 'a Done toast');
    runToastAction(toast.id, 'undo');
    await world.flush();
    assert.equal(state.open, first, 'the reader shows the thread that was brought back');
    assert.ok(!state.gone.has(first));
  } finally {
    world.connection.close();
  }
});

test('Esc closes find first, wherever focus is, and only then leaves the reader', async () => {
  const world = await boot();
  try {
    const { deps, state } = depsOver(world, world.doIds()[0]!);
    const actions = createReaderActions(deps);
    state.findOpen = true;
    actions.back();
    assert.equal(state.left, 0, 'find closed, the reader stayed');
    assert.equal(state.findOpen, false);
    actions.back();
    assert.equal(state.left, 1, 'the second Esc leaves');
  } finally {
    world.connection.close();
  }
});

test('find is a bar above the thread that carries its query, only on the letter on paper', async () => {
  const world = await boot();
  try {
    const id = world.doIds()[0]!;
    await world.threadWindow(id);
    const render = (paper: boolean, find: string | null) => renderLetter(id, { find }, paper);
    const open = render(true, 'invoice');
    assert.match(open, /aplos-reader__find/);
    assert.match(open, /value="invoice"/);
    assert.ok(
      open.indexOf('aplos-reader__find') < open.indexOf('ui-reader-head__summary'),
      'above the letter',
    );
    assert.doesNotMatch(render(true, null), /aplos-reader__find/);
    assert.doesNotMatch(
      render(false, 'invoice'),
      /aplos-reader__find/,
      'an off-paper letter has no bar',
    );
  } finally {
    world.connection.close();
  }
});

test('Done then Z brings the thread back into the walk, with or without the reader reopening it', async () => {
  resetToasts();
  const world = await boot();
  try {
    const ids = world.doIds();
    const second = ids[1]!;
    const { deps, state } = depsOver(world, second);
    deps.reopen = () => undefined;
    const actions = createReaderActions(deps);
    actions.done();
    assert.ok(state.gone.has(second));
    assert.equal(state.open, ids[2]);
    actions.undo();
    await world.flush();
    assert.ok(!state.gone.has(second), 'Z clears it, as the toast’s Undo does');
    actions.step('previous');
    assert.equal(state.open, second, 'K lands on the restored thread');
  } finally {
    world.connection.close();
  }
});

test('Z reopens the restored thread; a Z for another operation leaves the departed thread gone', async () => {
  resetToasts();
  const world = await boot();
  try {
    const ids = world.doIds();
    const { deps, state } = depsOver(world, ids[0]!);
    const actions = createReaderActions(deps);
    actions.done();
    actions.bookmark();
    actions.undo();
    await world.flush();
    assert.ok(state.gone.has(ids[0]!), 'the newest change was the bookmark, not the Done');
    actions.undo();
    await world.flush();
    assert.ok(!state.gone.has(ids[0]!));
    assert.equal(state.open, ids[0], 'and the reader went back to it');
  } finally {
    world.connection.close();
  }
});

test('Z closes the toast of the Done, Later or Trash it undid; the toast’s own Undo does too', async () => {
  resetToasts();
  const world = await boot();
  try {
    const ids = world.doIds();
    const { deps } = depsOver(world, ids[0]!);
    deps.dismiss = dismissToast;
    const actions = createReaderActions(deps);
    const toastOf = (kind: string) => getToasts().find(t => t.kind === kind);
    actions.done();
    assert.ok(toastOf('done'), 'a Done toast');
    actions.undo();
    await world.flush();
    assert.equal(toastOf('done'), undefined, 'Z closed the Done toast');
    actions.later();
    assert.ok(toastOf('later'), 'a Later toast');
    actions.undo();
    await world.flush();
    assert.equal(toastOf('later'), undefined, 'Z closed the Later toast');
    actions.trash();
    assert.ok(toastOf('trash'), 'a Trash toast');
    actions.undo();
    await world.flush();
    assert.equal(toastOf('trash'), undefined, 'Z closed the Trash toast');
    actions.done();
    const done = toastOf('done');
    assert.ok(done, 'a second Done toast');
    runToastAction(done.id, 'undo');
    await world.flush();
    assert.equal(toastOf('done'), undefined, 'the toast’s Undo closed it');
  } finally {
    world.connection.close();
  }
});

test('a refused Done puts the thread back into the walk', async () => {
  resetToasts();
  const world = await boot();
  try {
    const ids = world.doIds();
    const { deps, state } = depsOver(world, ids[0]!);
    deps.act = () => ({ opId: 'op-no', receipt: Promise.reject(new Error('no')) }) as never;
    createReaderActions(deps).done();
    assert.ok(state.gone.has(ids[0]!), 'gone while the write is in flight');
    await nextTask();
    assert.ok(!state.gone.has(ids[0]!), 'and back once the engine refuses it');
  } finally {
    world.connection.close();
  }
});

test('an undo runs its follow-up only when the engine accepted it', async () => {
  const ran: string[] = [];
  afterAccepted({ opId: 'u1', receipt: Promise.reject(new Error('no')) } as never, () =>
    ran.push('rejected'),
  );
  afterAccepted({ opId: 'u2', receipt: Promise.resolve({}) } as never, () => ran.push('accepted'));
  await nextTask();
  assert.deepEqual(ran, ['accepted']);
});

test('reopen only acts while the reader is mounted', () => {
  const opened: string[] = [];
  const open = { current: true };
  const reopen = whileOpen(open, id => void opened.push(id));
  reopen('a');
  open.current = false;
  reopen('b');
  assert.deepEqual(opened, ['a']);
});

test('the reader takes focus through settleFocus only when the decision says so', () => {
  const focused: unknown[] = [];
  const root = {
    contains: (other: unknown) => other === root || other === inside,
    focus: (options: unknown) => void focused.push(options),
  };
  const inside = { closest: () => null };
  const body = {};
  const docWith = (active: unknown) => ({ activeElement: active, body }) as unknown as Document;
  const settle = (active: unknown) => settleFocus(root as never, docWith(active));
  assert.equal(settle(body), 'root');
  assert.equal(settle(null), 'root');
  assert.equal(settle({}), 'keep', 'focus elsewhere in the app is left alone');
  assert.equal(settle(inside), 'keep', 'inside the reader but outside a letter');
  assert.deepEqual(focused, [{ preventScroll: true }, { preventScroll: true }]);
});

test('find: a second ⌘F reaches the field as a new key, and the field takes and selects', async () => {
  const world = await boot();
  try {
    const id = world.doIds()[0]!;
    await world.threadWindow(id);
    const render = (findFocus: number) =>
      renderToStaticMarkup(
        createElement(ReaderLetter, {
          threadId: id,
          paper: true,
          ui: { ...freshUi(id), find: '', findFocus },
          dispatch: () => undefined,
          controls: NO_CONTROLS,
          onReady: () => undefined,
        }),
      );
    assert.match(render(1), /data-focus-key="1"/);
    assert.match(render(2), /data-focus-key="2"/);
    const calls: string[] = [];
    takeFocus({ focus: () => void calls.push('focus'), select: () => void calls.push('select') });
    takeFocus(null);
    assert.deepEqual(calls, ['focus', 'select']);
  } finally {
    world.connection.close();
  }
});
