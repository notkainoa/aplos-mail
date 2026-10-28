// ui-ask: the Ask dock's model (DESIGN §7.7, §8 Ask, §9; plan 30 U7 acceptance 4).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Conversation, ProgressFrame } from '../../src/renderer/data';
import {
  advance,
  arrow,
  decide,
  decided,
  dockView,
  editQueued,
  escape,
  escRung,
  initialAsk,
  newChat,
  otherProviders,
  provenance,
  pruneDecisions,
  retry,
  runRefused,
  runStarted,
  sendNow,
  setField,
  stop,
  submit,
  toParagraphs,
  undone,
  type AskEffect,
  type AskInputs,
  type AskState,
  type DockView,
  type TurnView,
} from '../../src/renderer/screens/ask/ask.model';
import { AskPanel } from '../../src/renderer/screens/ask/AskPanel';
import type { TodayCalendar } from '../../src/renderer/screens/today/today.model';
import { frame, message, SCRIPTS, type Script } from './ask-script';

const calendars = new Map<string, TodayCalendar>([['cal-hollow', { id: 'cal-hollow', name: 'Hollow Creek', color: 'ember' }]]);
const providers = [
  { id: 'groq', label: 'Groq', local: false, status: 'ready' },
  { id: 'openai', label: 'OpenAI', local: false, status: 'missingKey' },
  { id: 'ollama', label: 'Ollama', local: true, status: 'ready' },
  { id: 'anthropic', label: 'Claude', local: false, status: 'ready' },
] as const;

function inputs(extra: Partial<AskInputs> = {}): AskInputs {
  return {
    frames: [],
    providers: [...providers],
    askReady: true,
    askModel: { provider: 'groq', model: 'demo-model' },
    calendars,
    accountNames: new Map([['acc-work', 'Work']]),
    suggestions: ['What needs a reply from me today?', 'When am I free tomorrow afternoon?', 'What did I miss this week?'],
    recents: [
      { id: 'c1', title: 'When is the design review?', updatedAt: Date.now() - 60_000 },
      { id: 'c2', title: 'Invoices from Drew', updatedAt: Date.now() - 86_400_000 },
    ],
    ...extra,
  };
}

/** Drives one scripted answer through the model the way the container does. */
function play(script: Script, onPrefix?: (view: DockView, state: AskState, frames: ProgressFrame[]) => void) {
  let state = setField(initialAsk, script.question);
  const asked = submit(state, dockView(state, inputs()), 'ask');
  assert.equal(asked.effects[0]?.kind, 'run');
  const run = asked.effects[0] as Extract<AskEffect, { kind: 'run' }>;
  state = runStarted(asked.state, run.clientId, 'r', 'conv-1').state;
  const all = script.frames('r', 'turn-1');
  const seen: ProgressFrame[] = [];
  let effects: AskEffect[] = [];
  for (const f of all) {
    seen.push(f);
    if (script.stopAfter !== undefined && seen.length === script.stopAfter + 1) {
      const stopped = stop(state);
      state = stopped.state;
      effects = [...effects, ...stopped.effects];
    }
    const stepped = advance(state, seen);
    state = stepped.state;
    effects = [...effects, ...stepped.effects];
    onPrefix?.(dockView(state, inputs({ frames: seen })), state, seen);
  }
  const stored = script.stored ? { id: 'conv-1', rev: 1, title: script.question, updatedAt: Date.now(), turns: [script.stored('turn-1')] } : undefined;
  return { state, frames: seen, effects, view: dockView(state, inputs({ frames: seen, conversation: stored })), liveView: dockView(state, inputs({ frames: seen })) };
}

function chips(turn: TurnView): number[] {
  return (turn.answer ?? []).flatMap(p => p.flatMap(s => (s.kind === 'cite' ? [s.index] : [])));
}

function strongCount(turn: TurnView): number {
  return (turn.answer ?? []).flatMap(p => p.filter(s => s.kind === 'text' && s.strong)).length;
}

function renderTurns(view: DockView): string {
  return renderToStaticMarkup(
    createElement(AskPanel, {
      view,
      tab: 'ask',
      width: 360,
      today: null,
      handlers: {
        onTabChange: () => undefined,
        onClose: () => undefined,
        onWidthChange: () => undefined,
        onOpenSettings: () => undefined,
        onChange: () => undefined,
        onSubmit: () => undefined,
        onStop: () => undefined,
        onQueuedChange: () => undefined,
        onSendQueuedNow: () => undefined,
        onPickSuggestion: () => undefined,
        onOpenRecent: () => undefined,
        onToggleSteps: () => undefined,
        onOpenCitation: () => undefined,
        onOpenEventCitation: () => undefined,
        onRetry: () => undefined,
        onUseAnotherProvider: () => undefined,
        onConfirmProposal: () => undefined,
        onDismissProposal: () => undefined,
      },
    }),
  );
}

describe('ui-ask: Ask invariants over 20 scripted answers (U7 acc. 4)', () => {
  test('there are twenty scripts', () => assert.equal(SCRIPTS.length, 20));

  for (const script of SCRIPTS) {
    test(`${script.name}: cites or says "No source in your mail"; input never disabled; follow-ups queue`, () => {
      const { view, liveView, state, effects } = play(script, (prefix, prefixState) => {
        // The field is never disabled, and a question typed while an answer streams becomes a queued, editable card.
        const html = renderTurns(prefix);
        assert.doesNotMatch(html, /<textarea[^>]*disabled/);
        assert.ok((html.match(/ui-ask-turn__caret/g) ?? []).length <= 1, 'one caret at most');
        if (prefix.working) {
          const typed = submit(setField(prefixState, 'And is Mina free then?'), prefix, 'ask');
          assert.deepEqual(typed.effects, []);
          assert.equal(typed.state.queued.at(-1)?.text, 'And is Mina free then?');
          assert.equal(typed.state.field, '');
          const edited = editQueued(typed.state, typed.state.queued.at(-1)!.id, 'And is Mina free at 3?');
          assert.equal(edited.queued.at(-1)?.text, 'And is Mina free at 3?');
        }
        for (const turn of prefix.turns) {
          for (const n of chips(turn)) assert.ok(turn.citations.some(c => c.index === n), `chip [${n}] has a source`);
          assert.ok(strongCount(turn) <= 1, 'one decisive span at most');
        }
      });
      for (const v of [liveView, view]) {
        if (script.ends === 'noProvider') {
          assert.equal(v.providerReady, false);
          assert.equal(state.field, script.question, 'the question goes back in the field');
          continue;
        }
        const turn = v.turns.at(-1)!;
        assert.equal(v.working, false);
        if (script.ends === 'failed') {
          assert.equal(turn.state, 'failed');
          assert.equal(turn.provider, 'Groq');
          continue;
        }
        assert.equal(turn.state, script.ends === 'stopped' ? 'stopped' : 'answered');
        assert.ok(turn.answer && turn.answer.length > 0);
        const cited = turn.citations.length > 0;
        assert.equal(turn.sourceLine, cited ? 'cited' : 'noSource');
        const html = renderTurns(v);
        assert.equal(html.includes('No source in your mail'), !cited);
        if (cited) assert.ok(chips(turn).length + (html.match(/ui-citation__chip/g) ?? []).length > 0);
        for (const n of chips(turn)) assert.ok(turn.citations.some(c => c.index === n));
        assert.ok(strongCount(turn) <= 1);
      }
      if (script.ends === 'stopped') {
        assert.ok(effects.some(e => e.kind === 'cancel'), 'Esc asked the engine to stop');
        assert.equal(liveView.turns.at(-1)!.proposal, undefined, 'a stopped answer offers nothing');
      }
    });
  }

  test('a queued follow-up runs after the final frame, in order', () => {
    const script = SCRIPTS[0];
    let state = setField(initialAsk, script.question);
    let stepped = submit(state, dockView(state, inputs()), 'ask');
    const clientId = (stepped.effects[0] as Extract<AskEffect, { kind: 'run' }>).clientId;
    state = runStarted(stepped.state, clientId, 'r', 'conv-1').state;
    const frames = script.frames('r', 'turn-1');
    const head = frames.slice(0, 4);
    const working = dockView(state, inputs({ frames: head }));
    assert.equal(working.working, true);
    stepped = submit(setField(state, 'And is Mina free then?'), working, 'ask');
    stepped = submit(setField(stepped.state, 'Book the room too'), working, 'ask');
    state = stepped.state;
    assert.deepEqual(state.queued.map(q => q.text), ['And is Mina free then?', 'Book the room too']);
    assert.deepEqual(advance(state, head).effects, [], 'nothing runs while the answer streams');
    const done = advance(state, frames);
    assert.deepEqual(
      done.effects.map(e => (e.kind === 'run' ? e.question : e.kind)),
      ['And is Mina free then?'],
    );
    assert.equal(done.state.queued.length, 1);
    assert.equal(done.state.run?.question, 'And is Mina free then?');
    assert.equal(done.state.past.length, 1, 'the answered run stays drawn until stored');
  });

  test('ask cmd return in queued card – sends that card now and stops the running answer, keeping its text', () => {
    const script = SCRIPTS[0];
    let state = setField(initialAsk, script.question);
    const asked = submit(state, dockView(state, inputs()), 'ask');
    state = runStarted(asked.state, (asked.effects[0] as { clientId: string }).clientId, 'r', 'conv-1').state;
    const frames = script.frames('r', 'turn-1').slice(0, 9);
    const view = dockView(state, inputs({ frames }));
    state = submit(setField(state, 'And is Mina free then?'), view, 'ask').state;
    const now = sendNow(state, view, state.queued[0].id);
    assert.deepEqual(now.effects.map(e => e.kind), ['cancel', 'run']);
    const after = dockView(now.state, inputs({ frames }));
    const old = after.turns.find(t => t.question === script.question)!;
    assert.equal(old.state, 'stopped');
    assert.ok(old.answer && old.answer.length > 0, 'the partial answer stays');
    assert.equal(after.turns.at(-1)!.question, 'And is Mina free then?');
  });

  test('ask cmd return search all – ⌘Return asks with searchAllMail; while streaming it sends the queue now', () => {
    const state = setField(initialAsk, 'Where is the lease?');
    const ran = submit(state, dockView(state, inputs()), 'searchAll');
    assert.equal(ran.effects[0].kind === 'run' && ran.effects[0].searchAll, true);
    const script = SCRIPTS[0];
    let live = runStarted(ran.state, (ran.effects[0] as { clientId: string }).clientId, 'r', 'conv-1').state;
    const view = dockView(live, inputs({ frames: script.frames('r', 'turn-1').slice(0, 3) }));
    live = setField(live, 'Is it signed?');
    const sent = submit(live, view, 'searchAll');
    assert.deepEqual(sent.effects.map(e => e.kind), ['cancel', 'run']);
    assert.equal((sent.effects[1] as { searchAll: boolean }).searchAll, true);
  });

  test('a run stopped before Ask/run answered is cancelled as soon as its id arrives', () => {
    const state = setField(initialAsk, 'Anything urgent?');
    const asked = submit(state, dockView(state, inputs()), 'ask');
    const stopped = stop(asked.state);
    assert.deepEqual(stopped.effects, [], 'no run id yet');
    const started = runStarted(stopped.state, (asked.effects[0] as { clientId: string }).clientId, 'r9', 'conv-1');
    assert.deepEqual(started.effects, [{ kind: 'cancel', runId: 'r9' }]);
  });
});

describe('ui-ask: Ask keys and states', () => {
  test('ask esc ladder – Esc stops a run, then clears text, then dismisses a pending proposal, then closes; never navigates', () => {
    const kinds = new Set<string>();
    // While an answer streams, the first Esc stops it, whatever else is on screen.
    const script = SCRIPTS[0];
    let state = setField(initialAsk, script.question);
    const asked = submit(state, dockView(state, inputs()), 'ask');
    state = runStarted(asked.state, (asked.effects[0] as { clientId: string }).clientId, 'r', 'conv-1').state;
    state = setField(state, 'and the room');
    const streaming = dockView(state, inputs({ frames: script.frames('r', 'turn-1').slice(0, 8) }));
    assert.equal(escRung(state, streaming, false), 'stop');
    const stopped = escape(state, streaming, false);
    stopped.effects.forEach(e => kinds.add(e.kind));
    assert.equal(stopped.state.run?.stopped, true);
    assert.equal(stopped.state.field, 'and the room', 'stopping keeps what you typed');
    // A finished answer with a proposal: clear, then the proposal, then close.
    const done = play(SCRIPTS[2]);
    const frames = done.frames;
    const conversation = storedOf(SCRIPTS[2]);
    let after: AskState = setField(done.state, 'and the room');
    const rungs: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const view = dockView(after, inputs({ frames, conversation }));
      rungs.push(escRung(after, view, false));
      const stepped = escape(after, view, false);
      stepped.effects.forEach(e => kinds.add(e.kind));
      after = stepped.state;
      if (stepped.effects.some(e => e.kind === 'close')) break;
    }
    assert.deepEqual(rungs, ['clear', 'dismissProposal', 'close']);
    for (const kind of kinds) assert.ok(['cancel', 'decide', 'close'].includes(kind), `Esc did ${kind}`);
  });

  test('a focused proposal takes Esc first, even while an answer streams (registry priority)', () => {
    const script = SCRIPTS[2];
    let state = initialAsk;
    const asked = submit(setField(state, script.question), dockView(state, inputs()), 'ask');
    state = runStarted(asked.state, (asked.effects[0] as { clientId: string }).clientId, 'r', 'conv-1').state;
    const view = dockView(state, inputs({ frames: script.frames('r', 'turn-1').slice(0, -1) }));
    assert.equal(view.working, true);
    assert.equal(escRung(state, view, true), 'declineProposal');
  });

  test('ask proposal accept applies once – Return on an empty field accepts; the card shows its receipt; Undo restores it', () => {
    const { state, view, frames } = play(SCRIPTS[2]);
    assert.equal(view.pendingProposal?.kicker, 'Add to Calendar');
    assert.equal(view.pendingProposal?.consequence, 'Thu 2:00–2:30 PM · Hollow Creek');
    assert.equal(view.pendingProposal?.color, 'ember');
    const accepted = submit(state, view, 'ask');
    assert.deepEqual(accepted.effects, [
      { kind: 'decide', proposalId: 'p-event', turnId: 'turn-1', conversationId: 'conv-1', accept: true },
    ]);
    const shown = dockView(accepted.state, inputs({ frames, conversation: storedOf(SCRIPTS[2]) }));
    assert.equal(shown.turns.at(-1)!.proposal?.state, 'applied');
    assert.equal(shown.turns.at(-1)!.proposal?.appliedText, 'Added to Calendar · Thu 2:00–2:30 PM · Hollow Creek');
    // A second Return has nothing pending to apply.
    assert.deepEqual(submit(accepted.state, shown, 'ask').effects, []);
    const confirmed = decided(accepted.state, 'p-event', { ok: true, eventId: 'e-new' });
    const back = undone(confirmed, 'p-event');
    assert.equal(dockView(back, inputs({ frames, conversation: storedOf(SCRIPTS[2]) })).pendingProposal?.proposalId, 'p-event');
  });

  test('an Undo in the engine brings the card back once the store has the decision', () => {
    const { state, view, frames } = play(SCRIPTS[2]);
    const accepted = decided(decide(state, view, true).state, 'p-event', { ok: true, eventId: 'e-new' });
    const stored = storedOf(SCRIPTS[2]);
    const acceptedInStore = { ...stored, turns: [{ ...stored.turns[0], proposals: [{ ...stored.turns[0].proposals[0], state: 'accepted' }] }] };
    const pruned = pruneDecisions(accepted, acceptedInStore);
    assert.deepEqual(pruned.decisions, {});
    assert.equal(dockView(pruned, inputs({ frames, conversation: acceptedInStore })).turns.at(-1)!.proposal?.state, 'applied');
    // Undo reopens it in the engine.
    assert.equal(dockView(pruned, inputs({ frames, conversation: stored })).pendingProposal?.proposalId, 'p-event');
  });

  test('ask proposal nothing applied without confirm – no decide effect until Add or Return; a refusal reverts the card', () => {
    const { state, view, effects, frames } = play(SCRIPTS[2]);
    assert.ok(!effects.some(e => e.kind === 'decide'));
    const accepted = decide(state, view, true);
    const refused = decided(accepted.state, 'p-event', { ok: false });
    assert.equal(dockView(refused, inputs({ frames, conversation: storedOf(SCRIPTS[2]) })).pendingProposal?.state, 'pending');
  });

  test('ask proposal dismiss persists – Not now hides the card, and the stored dismissal keeps it hidden', () => {
    const { state, view } = play(SCRIPTS[2]);
    const dismissed = decide(state, view, false);
    assert.equal(dismissed.effects[0].kind === 'decide' && dismissed.effects[0].accept, false);
    const stored = storedOf(SCRIPTS[2]);
    stored.turns[0] = { ...stored.turns[0], proposals: stored.turns[0].proposals.map(p => ({ ...p, state: 'dismissed' })) };
    const reopened = dockView({ ...initialAsk, conversationId: 'conv-1' }, inputs({ conversation: stored }));
    assert.equal(reopened.pendingProposal, undefined);
    assert.equal(reopened.turns[0].proposal, undefined);
  });

  test('only the newest open proposal is the dock\'s card', () => {
    const stored = storedOf(SCRIPTS[2]);
    const second = { ...stored.turns[0], id: 'turn-2', proposals: [{ ...stored.turns[0].proposals[0], id: 'p-2' }] };
    const view = dockView({ ...initialAsk, conversationId: 'conv-1' }, inputs({ conversation: { ...stored, turns: [stored.turns[0], second] } }));
    assert.equal(view.pendingProposal?.proposalId, 'p-2');
    assert.equal(view.turns[0].proposal, undefined);
  });

  test('ask no provider before asking – not ready shows the no-provider state, not an error', () => {
    const view = dockView(initialAsk, inputs({ askReady: false }));
    assert.equal(view.providerReady, false);
    const html = renderTurns(view);
    assert.match(html, /Ask needs a provider\. Choose one in Settings\./);
    assert.doesNotMatch(html, /didn.t answer/);
    // Refused for a missing key: the same state, and the question goes back in the field.
    let state = setField(initialAsk, 'Anything new?');
    const asked = submit(state, dockView(state, inputs()), 'ask');
    state = runRefused(asked.state, (asked.effects[0] as { clientId: string }).clientId, { type: 'notConfigured', reasonCode: 'ai.missingKey', message: 'x' });
    const refused = dockView(state, inputs());
    assert.equal(refused.providerReady, false);
    assert.equal(state.field, 'Anything new?');
  });

  test('ask provider error line – "Groq didn\'t answer." with Retry and Use another provider; Retry re-runs once', () => {
    const { state, liveView } = play(SCRIPTS[6]);
    const html = renderTurns(liveView);
    assert.match(html, /Groq didn(’|&#x27;|')t answer\./);
    assert.match(html, />Retry</);
    assert.match(html, />Use another provider</);
    const failed = liveView.turns.at(-1)!;
    const again = retry(state, liveView, failed.id);
    assert.deepEqual(again.effects.map(e => (e.kind === 'run' ? e.question : e.kind)), [SCRIPTS[6].question]);
    assert.deepEqual(retry(again.state, dockView(again.state, inputs()), failed.id).effects, [], 'no second run while one is going');
  });

  test('ask use another provider lists ready providers other than the failing one', () => {
    assert.deepEqual(otherProviders([...providers], 'groq').map(p => p.id), ['ollama', 'anthropic']);
  });

  test('ask provenance on hover – "Answer by Groq"; a local model says "on this Mac"', () => {
    assert.equal(provenance({ provider: 'groq', model: 'm' }, [...providers]), 'Answer by Groq');
    assert.equal(provenance({ provider: 'ollama', model: 'm' }, [...providers]), 'Answer by Ollama on this Mac');
    assert.equal(provenance(undefined, [...providers]), undefined);
    const { view } = play(SCRIPTS[0]);
    assert.equal(view.turns.at(-1)!.provenance, 'Answer by Groq');
    // At rest the provenance is not drawn: it lives in a tooltip.
    assert.doesNotMatch(renderTurns(view), />Answer by Groq</);
  });

  test('ask working step line names the real step, then folds into "Read 14 emails from Jordan · 3 steps"', () => {
    play(SCRIPTS[0], (view, _state, frames) => {
      if (frames.length === 3) assert.equal(view.turns.at(-1)!.steps?.current, 'Reading 14 emails from Jordan');
    });
    const { view } = play(SCRIPTS[0]);
    assert.equal(view.turns.at(-1)!.steps?.summary, 'Read 14 emails from Jordan · 3 steps');
    assert.equal(view.turns.at(-1)!.steps?.current, undefined);
  });

  test('ask citation hover data and open target', () => {
    const { view } = play(SCRIPTS[0]);
    const turn = view.turns.at(-1)!;
    const first = turn.citations[0];
    assert.equal(first.quote, 'Let’s hold the design review Thursday from 2:00 to 2:30.');
    assert.equal(first.from, 'Mina Cho');
    assert.equal(first.subject, 'Hollow Creek review');
    assert.deepEqual(turn.targets.get(1), { kind: 'thread', threadId: first.threadId, messageId: 'm1-19' });
    const event = play(SCRIPTS[11]).liveView.turns.at(-1)!;
    assert.deepEqual(event.targets.get(1), { kind: 'event', eventId: 'e-review' });
    assert.equal(event.citations[0].kind, 'event');
  });

  test('ask decisive span single – the first emphasised range stays, later ones are plain', () => {
    const paragraphs = toParagraphs(
      [{ text: 'Layout by Friday; budget by Monday.', strong: [{ start: 10, end: 16 }, { start: 28, end: 34 }] }],
      new Set(),
    );
    assert.deepEqual(paragraphs[0].filter(s => s.kind === 'text' && s.strong), [{ kind: 'text', text: 'Friday', strong: true }]);
  });

  test('a chip never splits an emoji', () => {
    const { liveView } = play(SCRIPTS[14]);
    const texts = liveView.turns.at(-1)!.answer![0].flatMap(s => (s.kind === 'text' ? [s.text] : []));
    for (const t of texts) assert.doesNotMatch(t, /^[\udc00-\udfff]|[\ud800-\udbff]$/);
  });

  test('ask recents with times, suggestions, and ↑/↓ through them; Return asks the one under the cursor', () => {
    const view = dockView(initialAsk, inputs());
    assert.equal(view.empty?.suggestions.length, 3);
    assert.equal(view.empty?.recents.length, 2);
    let state = arrow(initialAsk, view, 1);
    assert.equal(state.cursor, 0);
    state = arrow(state, dockView(state, inputs()), -1);
    assert.equal(state.cursor, 4, 'wraps to the last recent');
    state = arrow(state, dockView(state, inputs()), 1);
    const picked = submit(state, dockView(state, inputs()), 'ask');
    assert.equal(picked.effects[0].kind === 'run' && picked.effects[0].question, 'What needs a reply from me today?');
  });

  test('↑ in an empty field inside a conversation recalls earlier questions', () => {
    const stored = storedOf(SCRIPTS[0]);
    const state0 = { ...initialAsk, conversationId: 'conv-1' };
    const view = dockView(state0, inputs({ conversation: stored }));
    const up = arrow(state0, view, -1);
    assert.equal(up.field, SCRIPTS[0].question);
    assert.equal(arrow(up, view, 1).field, '');
    assert.equal(arrow(setField(state0, 'typing'), view, -1).field, 'typing', 'typed text is never replaced');
  });

  test('ask new chat – ⌘N clears to the empty state and the next question starts a new conversation', () => {
    const { state } = play(SCRIPTS[0]);
    const fresh = newChat(state);
    assert.equal(fresh.state.conversationId, undefined);
    assert.ok(dockView(fresh.state, inputs()).empty);
    const next = submit(setField(fresh.state, 'New question'), dockView(fresh.state, inputs()), 'ask');
    assert.equal(next.effects[0].kind === 'run' && next.effects[0].conversationId, undefined);
  });

  test('an account left out is said plainly under the answer', () => {
    const { view } = play(SCRIPTS[18]);
    assert.equal(view.turns.at(-1)!.excludedNote, 'Mail from Work was left out. Its AI setting is off.');
  });

  test('a long stream keeps every delta', () => {
    const { liveView } = play(SCRIPTS[17]);
    const text = liveView.turns.at(-1)!.answer!.flat().map(s => (s.kind === 'text' ? s.text : '')).join('');
    assert.equal(text, 'The Hollow Creek board passed the trail budget. '.repeat(30));
  });

  test('frames of another run never leak into this one', () => {
    let state = setField(initialAsk, 'One');
    const asked = submit(state, dockView(state, inputs()), 'ask');
    state = runStarted(asked.state, (asked.effects[0] as { clientId: string }).clientId, 'mine', 'conv-1').state;
    const view = dockView(state, inputs({ frames: [frame('other', 'text', { delta: 'not mine' }), frame('other', 'done')] }));
    assert.equal(view.working, true);
    assert.equal(view.turns.at(-1)!.answer, undefined);
    void message;
  });
});

function storedOf(script: Script): Conversation {
  return { id: 'conv-1', rev: 1, title: script.question, updatedAt: Date.now(), turns: [script.stored!('turn-1')] };
}
