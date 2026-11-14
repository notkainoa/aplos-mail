/**
 * The composer's behaviour on the stand-in engine through the real data layer (lane card criterion 6), in node with no
 * DOM: the screens render with react-dom/server and the keys go through the CommandRegistry the way the shell's
 * listener sends them. Covers: the filled button belongs to an open composer; Tab keeps the dim AI text and nothing
 * shows with AI unavailable; hold-to-dictate shows the level meter and "Listening. Release R to keep, Esc to cancel.",
 * and releasing R types what the engine transcribed; Esc closes and keeps the draft; Discard asks first.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createFixtureEngine, defaultNow } from '@aplos/contract-fixture';
import { fixtureControl } from '@aplos/contract-fixture/control';
import { createAppRegistry, DEFAULT_KEY_PREFS, type CommandContext } from '../../commands';
import { connectDataLayer } from '../../data/connect';
import { createManualScheduler, createManualTimers } from '../../data/scheduler';
import { api, getNow } from '../../data';
import { shellRegistryFor } from '../../shell/ShellRegistry';
import { InlineReply } from '../../ui/compose';
import { InlineReplyView } from './InlineReplyHost';
import { ComposePageView } from './ComposeScreen';
import { freshCompose } from './model/composeState';
import { composeView } from './model/composeView';
import { dictationShown } from './model/dictationModel';
import { dataComposeApi } from './runtime/composeApi';
import { composeCommands } from './runtime/composeCommands';
import { createDictation, engineTranscribe } from './runtime/dictation';
import { fakeDictationSource } from './runtime/dictationSource';
import { createComposeSession, type ComposeSession } from './runtime/session';
import { loadSuggestion } from './runtime/suggestion';
import type { ComposeBinding } from './runtime/useComposeSession';
import type { ComposerControls } from './runtime/useComposerControls';
import { useSharedComposerProps } from './views/composerParts';

const nextTask = () => new Promise<void>(resolve => setImmediate(resolve));
const JORDAN = { id: 'jordan@example.com', name: 'Jordan Lee', address: 'jordan@example.com' };

async function boot() {
  const engine = createFixtureEngine({ scenario: 'demo', clock: defaultNow });
  const scheduler = createManualScheduler();
  const connection = connectDataLayer({
    session: engine.connect(),
    scheduler,
    timers: createManualTimers(defaultNow),
  });
  connection.layer.session.want('settings');
  const settle = async () => {
    for (let i = 0; i < 12; i++) {
      await nextTask();
      scheduler.flush();
    }
  };
  await settle();
  const store = engine.fixture.store;
  const account = store.all('Account')[0]!;
  const thread = store.all('Thread').find(t => t.accountId === account.id && t.messageCount > 0)!;
  return { engine, store, connection, settle, accountId: account.id, threadId: thread.id };
}

type World = Awaited<ReturnType<typeof boot>>;

function openReply(world: World): ComposeSession {
  const initial = freshCompose(
    { accountId: world.accountId, mode: 'reply', threadId: world.threadId },
    { to: [JORDAN], cc: [], bcc: [], subject: 'Re: plans', body: '' },
  );
  const timers = {
    now: () => getNow(),
    setTimeout: (callback: () => void, ms: number) => {
      const handle = setTimeout(callback, ms);
      return () => clearTimeout(handle);
    },
  };
  return createComposeSession({ api: dataComposeApi(api), timers }, initial);
}

function bindingOf(session: ComposeSession): ComposeBinding {
  const state = session.getState();
  return { session, state, view: composeView(state, getNow(), true, String), undoSeconds: 8 };
}

function render(element: ReactElement): string {
  return renderToStaticMarkup(element);
}

function reply(session: ComposeSession): string {
  return render(
    createElement(InlineReplyView, {
      binding: bindingOf(session),
      props: { threadId: 't', messageId: 'm', onClose: () => undefined },
    }),
  );
}

const filled = (html: string) => html.match(/data-variant="filled"/g)?.length ?? 0;

/** The registry with the composer's handlers, and a key press resolved in the `compose` context. */
function keys(session: ComposeSession, extra: Partial<Parameters<typeof composeCommands>[0]> = {}) {
  const registry = createAppRegistry();
  shellRegistryFor(registry).register(
    composeCommands({
      send: alsoDone => session.dispatch({ type: 'send', now: getNow(), undoSeconds: 8, alsoDone }),
      keepSuggestion: () => session.dispatch({ type: 'keepSuggestion', now: getNow() }),
      dismissSuggestion: () => session.dispatch({ type: 'dismissSuggestion' }),
      close: () => session.dispatch({ type: 'escape' }),
      discard: () => {
        session.dispatch({ type: 'askDiscard' });
        session.dispatch({ type: 'confirmDiscard' });
      },
      toggleCc: () => undefined,
      dictateStart: () => undefined,
      dictateRelease: () => undefined,
      ...extra,
    }),
  );
  const context = (): CommandContext => ({
    stack: ['global', 'compose'],
    target: null,
    selection: [],
    conditions: bindingOf(session).view.conditions,
    prefs: DEFAULT_KEY_PREFS,
    focus: 'text',
  });
  const press = (key: string, mods: { metaKey?: boolean; shiftKey?: boolean } = {}) => {
    const input = { key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods };
    const resolution = registry.resolve(input, context());
    assert.ok(resolution, `${key} resolves in the composer`);
    return { id: resolution.commandId, result: registry.run(resolution.commandId, context()) };
  };
  return { registry, context, press };
}

async function typeAndSave(world: World, session: ComposeSession, body: string) {
  session.dispatch({ type: 'edit', patch: { body }, now: getNow() });
  session.dispatch({ type: 'flush' });
  await session.settled();
  await world.settle();
}

test('the filled button belongs to the open composer: one while open, none after Esc or Send', async () => {
  const world = await boot();
  try {
    const session = openReply(world);
    await typeAndSave(world, session, 'See you Thursday.');
    const open = reply(session);
    assert.equal(filled(open), 1, 'Send is the one filled button');
    assert.match(open, /aria-label="Reply"/);
    const { press } = keys(session);
    assert.equal(press('Escape').id, 'compose.close');
    const closed = reply(session);
    assert.equal(filled(closed), 0, 'closed: the reader gets its filled suggestion back');
    const draftId = session.getState().save.draftId!;
    assert.ok(world.store.get('Draft', draftId), 'Esc kept the draft');
    session.dispatch({ type: 'reopen' });
    assert.equal(press('Enter', { metaKey: true }).id, 'compose.send');
    await session.settled();
    await world.settle();
    const sent = reply(session);
    assert.equal(filled(sent), 0);
    assert.match(sent, /Sending to Jordan/);
    assert.match(sent, / in 8 s/);
    assert.match(sent, />You</, 'the message arrives in the thread with the tray under it');
    session.dispose();
  } finally {
    world.connection.close();
  }
});

test('the compose page owns the filled button only while open', async () => {
  const world = await boot();
  try {
    const session = openReply(world);
    const props = { onClose: () => undefined };
    const page = render(createElement(ComposePageView, { binding: bindingOf(session), props }));
    assert.equal(filled(page), 1);
    assert.match(page, /aria-label="New message"/);
    assert.match(page, /aria-label="Subject"/);
    session.dispose();
  } finally {
    world.connection.close();
  }
});

test('Tab keeps the dim AI text; it is drawn in the serif after the caret, with the hint line', async () => {
  const world = await boot();
  try {
    const session = openReply(world);
    const suggestion = await loadSuggestion(api.ai, world.threadId, {
      kind: 'draft',
      instruction: 'Say Thursday works',
    });
    assert.ok(suggestion, 'the stand-in drafted a reply');
    session.dispatch({ type: 'suggest', suggestion });
    const shown = reply(session);
    assert.match(shown, /class="aplos-compose-editor__suggestion">[^<]*Thursday works/);
    assert.match(shown, /The gray sentence is a suggestion\./);
    assert.doesNotMatch(shown, /<textarea[^>]*>[^<]*Thursday/, 'not part of the text until kept');
    const { press } = keys(session);
    assert.equal(press('Tab').id, 'compose.keepSuggestion');
    const kept = reply(session);
    assert.doesNotMatch(kept, /aplos-compose-editor__suggestion/);
    assert.match(kept, /<textarea[^>]*>[^<]*Thursday works/);
    assert.equal(session.getState().fields.body.includes('Thursday works'), true);
    assert.ok(session.getState().save.editSeq > 0, 'kept text is an edit, so it saves like typing');
    session.dispose();
  } finally {
    world.connection.close();
  }
});

test('Esc dismisses the dim text before it closes anything; with AI unavailable nothing shows at all', async () => {
  const world = await boot();
  try {
    const session = openReply(world);
    session.dispatch({
      type: 'suggest',
      suggestion: { kind: 'followUp', text: 'Just checking in.' },
    });
    assert.match(reply(session), /Aplos drafted this follow-up from your last email\./);
    const { press } = keys(session);
    assert.equal(press('Escape').id, 'compose.dismissSuggestion');
    assert.equal(session.getState().open, true);
    await fixtureControl(world.engine).failNextAi({
      feature: 'drafts',
      reasonCode: 'ai.missingKey',
    });
    const none = await loadSuggestion(api.ai, world.threadId, {
      kind: 'draft',
      instruction: 'Say yes',
    });
    assert.equal(none, null);
    const html = reply(session);
    assert.doesNotMatch(
      html,
      /aplos-compose-editor__suggestion|ui-suggestion|gray sentence|\bAI\b/,
    );
    session.dispose();
  } finally {
    world.connection.close();
  }
});

test('hold R: the level meter and "Listening. Release R to keep, Esc to cancel."; release types what was heard', async () => {
  const world = await boot();
  try {
    const session = openReply(world);
    await fixtureControl(world.engine).transcribeResult({ text: 'see you Thursday' });
    const source = fakeDictationSource({
      levels: [0.6],
      recording: { bytes: new Uint8Array([1, 2, 3]), mime: 'audio/webm' },
    });
    const controller = createDictation({
      source,
      transcribe: engineTranscribe(api),
      onText: text => session.dispatch({ type: 'dictated', text, now: getNow() }),
      now: () => Date.now(),
    });
    controller.start('R');
    await nextTask();
    const controls = {
      dictation: {
        controller,
        phase: controller.getPhase(),
        shown: dictationShown(controller.getPhase()),
      },
      showCc: false,
      setShowCc: () => undefined,
    } as unknown as ComposerControls;
    function Harness() {
      const shared = useSharedComposerProps(bindingOf(session), controls, {
        label: 'Reply',
        focusTo: false,
      });
      return createElement(InlineReply, {
        ...shared,
        onPopOut: () => undefined,
        onFormat: () => undefined,
        onMore: () => undefined,
      });
    }
    const listening = render(createElement(Harness));
    assert.match(listening, /role="meter"/);
    assert.match(listening, /aria-valuenow="0.6"/);
    assert.match(listening, /Listening\. Release R to keep, Esc to cancel\./);
    assert.doesNotMatch(
      listening,
      /Draft saved|Saving/,
      'the dictation line takes the draft line’s place',
    );
    await controller.release(true);
    await world.settle();
    assert.equal(session.getState().fields.body, 'see you Thursday');
    assert.equal(controller.getPhase().kind, 'idle');
    controller.start('R');
    controller.cancel();
    assert.equal(source.cancelled, 1, 'Esc throws the audio away');
    session.dispose();
  } finally {
    world.connection.close();
  }
});

test('Discard asks "Discard this draft?" first, from ⋯ and from the palette; only the confirmation destroys', async () => {
  const world = await boot();
  try {
    const session = openReply(world);
    await typeAndSave(world, session, 'Never mind.');
    const draftId = session.getState().save.draftId!;
    session.dispatch({ type: 'askDiscard' });
    const asking = reply(session);
    assert.match(asking, /Discard this draft\?/);
    assert.match(asking, /This can’t be undone\./);
    assert.ok(world.store.get('Draft', draftId), 'asking discards nothing');
    session.dispatch({ type: 'cancelDiscard' });
    const { registry, context } = keys(session);
    assert.equal(
      registry.run('compose.discard', context()).status,
      'confirm',
      'the palette asks too',
    );
    assert.ok(world.store.get('Draft', draftId));
    registry.run('compose.discard', context(), { confirmed: true });
    await session.settled();
    await world.settle();
    assert.equal(world.store.get('Draft', draftId), undefined);
    session.dispose();
  } finally {
    world.connection.close();
  }
});
