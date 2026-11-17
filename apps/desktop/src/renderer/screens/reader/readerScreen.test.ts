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
import { createAppRegistry, DEFAULT_KEY_PREFS, type CommandContext } from '../../commands';
import { undoStack } from '../../data';
import { dismissToast } from '../../shell';
import { shellRegistryFor } from '../../shell/ShellRegistry';
import { setOpenThread } from '../../shell/store-thread';
import { getToasts, resetToasts, runToastAction } from '../../shell/store-toast';
import { createReaderActions, whileOpen } from './readerActions';
import { afterAccepted } from '../undoOperation';
import { settleFocus } from './readerFocus';
import { takeFocus } from './FindBar';
import { commandsForReader } from './readerCommands';
import { ReaderLetter, GONE_COPY } from './ReaderLetter';
import { ReaderScreen, NO_THREAD_COPY } from './ReaderScreen';
import { PLAIN_REPLY, freshUi, reduceUi, type ReaderUi } from './readerUi';

const NO_CONTROLS = {
  suggest: () => undefined,
  later: () => undefined,
  done: () => undefined,
  reply: () => undefined,
  replyAll: () => undefined,
  bookmark: () => undefined,
  trash: () => undefined,
  lane: () => undefined,
  relayKey: () => false,
};

import { boot, depsOver, nextTask, text } from './readerTestKit';

const renderLetter = (
  id: string,
  over: Partial<ReaderUi> = {},
  paper = true,
  cards?: 'a' | 'off',
) =>
  renderToStaticMarkup(
    createElement(ReaderLetter, {
      threadId: id,
      paper,
      ui: { ...freshUi(id), ...over },
      dispatch: () => undefined,
      controls: NO_CONTROLS,
      cards,
      onReady: () => undefined,
    }),
  );

test('the letter is the email card, then the stub and the pinned bar: no summary, due chip or subject above or inside it (owner sketch 2026-11-10)', async () => {
  const world = await boot();
  try {
    const id = world.doIds()[0]!;
    await world.threadWindow(id);
    const html = renderLetter(id);
    const parts = [
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
      'thread, stub, actions',
    );
    assert.doesNotMatch(
      html,
      /ui-reader-head|ui-summary|ui-thread-message__subject|data-kind="due"/,
      'nothing sits above the card: no summary, due chip or subject row',
    );
    assert.doesNotMatch(
      html.slice(0, html.indexOf('aplos-reader__thread')),
      /<time/,
      'no sender or time above the thread: they live in the message card',
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

test('earlier messages are compact cards; a short one shown whole has no chevron, and O still opens it, aria-expanded says so', async () => {
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
    // The demo's earlier messages are short: the folded card shows each whole, so it has nothing to open (owner call
    // 2026-11-14): no chevron, no "…".
    assert.match(card(compact, first), /data-complete="true"/);
    assert.doesNotMatch(card(compact, first), /ui-thread-message__toggle/);
    assert.match(card(compact, first), /ui-thread-message__excerpt" dir="auto">[^<]+[.!?]</);
    assert.doesNotMatch(card(compact, first), /…</);
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
      second,
      'the thread that left is not kept on paper: the next one shows at once',
    );
    const toast = getToasts().find(t => t.kind === 'done');
    assert.ok(toast, 'a Done toast');
    assert.equal(toast.undoable, true);
    assert.deepEqual(
      toast.actions?.map(a => a.id),
      ['undo'],
    );
    assert.equal(state.left, 0, 'the list was not left: a thread is still open');
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

test('E, J, E before the next letter lands: each E acts on the letter on paper, never the one that left', async () => {
  resetToasts();
  const world = await boot();
  try {
    const ids = world.doIds();
    const { deps, state, controller } = depsOver(world, ids[0]!, false);
    const actions = createReaderActions(deps);
    actions.done();
    assert.equal(controller.snapshot().letter, ids[1], 'the next thread is on paper at once');
    actions.step('next');
    actions.done();
    const doneToasts = () => getToasts().filter(t => t.kind === 'done').length;
    assert.equal(doneToasts(), 2, 'the second E took the thread on paper');
    assert.ok(state.gone.has(ids[0]!) && state.gone.has(ids[1]!));
    assert.ok(!state.gone.has(ids[2]!), 'the thread J walked to is untouched');
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
      open.indexOf('aplos-reader__find') < open.indexOf('aplos-reader__thread'),
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

test('the Importance menu moves the thread one end to the other with Home’s toast, and the reader stays on it', async () => {
  resetToasts();
  const world = await boot();
  try {
    const first = world.doIds()[0]!;
    const { deps, state } = depsOver(world, first);
    createReaderActions(deps).lane('low');
    assert.equal(state.open, first, 'the reader stays on the thread it moved');
    assert.equal(state.left, 0);
    const toast = getToasts().find(t => t.message === 'Moved to Low importance');
    assert.ok(toast, 'the move is told in plain words');
    assert.equal(toast.undoable, true);
    assert.deepEqual(
      toast.actions?.map(a => a.id),
      ['always', 'undo'],
    );
    assert.match(toast.actions?.[0]?.label ?? '', /^Always do this for /);
    await world.flush();
  } finally {
    world.connection.close();
  }
});

test('the summary head shows only in the card-less column (cards off); the default card has nothing above it', async () => {
  const world = await boot();
  try {
    const id = world.doIds()[0]!;
    await world.threadWindow(id);
    assert.doesNotMatch(renderLetter(id), /ui-reader-head/, 'the default card: nothing above');
    assert.match(
      renderLetter(id, {}, true, 'off'),
      /ui-reader-head__summary/,
      'off keeps the summary',
    );
  } finally {
    world.connection.close();
  }
});

test('F goes through the registry to a forward of the thread on paper', async () => {
  const world = await boot();
  try {
    const id = world.doIds()[0]!;
    const { deps, state } = depsOver(world, id);
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
    const resolution = registry.resolve(
      { key: 'f', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false },
      context,
    );
    assert.equal(resolution?.commandId, 'mail.forward', 'F is Forward in the reader');
    assert.equal(registry.run('mail.forward', context).status, 'ran');
    assert.deepEqual(state.forwards, [id]);
    assert.equal(state.left, 0, 'the reader stays on the thread');
    detach();
  } finally {
    world.connection.close();
  }
});

test('Mark unread returns to the list with one toast; Mark read stays on the thread', async () => {
  resetToasts();
  const world = await boot();
  try {
    const id = world.doIds()[0]!;
    const { deps, state } = depsOver(world, id);
    // The demo thread starts either way: make it read, then walk both directions.
    const row = () => deps.rowOf(id)!;
    if (row().unread) {
      createReaderActions(deps).toggleRead();
      await world.flush();
      assert.equal(state.left, 0, 'marking a thread read keeps the reader on it');
    }
    const actions = createReaderActions(deps);
    actions.toggleRead();
    assert.ok(getToasts().some(t => t.message === 'Marked unread'));
    assert.equal(state.left, 1, 'marking a read thread unread goes back to the list');
    await world.flush();
    assert.equal(row().unread, true, 'the thread is unread');
    actions.toggleRead();
    assert.ok(getToasts().some(t => t.message === 'Marked read'));
    assert.equal(state.left, 1, 'marking it read again does not leave');
    await world.flush();
  } finally {
    world.connection.close();
  }
});
