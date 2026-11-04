/**
 * The Ask dock's pure decisions: frames folded into turns, citation chips, the Esc ladder, the follow-up queue,
 * no-provider versus provider-error, the daily-limit pause, and decisions. Run:
 * `cd apps/desktop && npx tsx --test 'src/renderer/screens/ask/**\/*.test.ts*'`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Citation, ProgressFrame, Proposal } from '../../data';
import {
  advance,
  decide,
  dockView,
  escape,
  foldFrames,
  initialAsk,
  runRefused,
  sendNow,
  setField,
  submit,
  toParagraphs,
  type AskInputs,
  type AskState,
} from './ask.model';

const NO_CALENDARS = new Map();

function inputs(extra: Partial<AskInputs> = {}): AskInputs {
  return {
    frames: [],
    providers: [{ id: 'groq', label: 'Groq', local: false, status: 'ready' }],
    askReady: true,
    askModel: { provider: 'groq', model: 'demo' },
    calendars: NO_CALENDARS,
    suggestions: ['a?', 'b?', 'c?'],
    recents: [],
    ...extra,
  };
}

let seq = 0;
function frame(kind: ProgressFrame['kind'], extra: Partial<ProgressFrame> = {}): ProgressFrame {
  seq += 1;
  return {
    frame: 'progress',
    dbEpoch: 'demo',
    seq,
    runId: 'r1',
    source: 'ask',
    kind,
    turnId: 'turn-1',
    ...extra,
  } as ProgressFrame;
}

function running(question = 'q?', runId = 'r1'): AskState {
  return {
    ...initialAsk,
    conversationId: 'conv-1',
    run: { clientId: 'c1', question, searchAll: false, runId, stopped: false, settled: false },
  };
}

const cite = (n: number): Citation => ({
  kind: 'message',
  n,
  messageId: `m${n}`,
  threadId: `t${n}`,
  quote: `quote ${n}`,
  fromName: 'Mina',
});

test('streaming frames fold into one live turn: steps, text, chips in place', () => {
  const state = running();
  const frames = [
    frame('step', { step: { id: 's1', text: 'Searching your mail', state: 'running' } }),
    frame('text', { delta: 'Mina says Thursday. ' }),
    frame('citation', { citation: cite(1) }),
    frame('text', { delta: 'Jordan agrees.' }),
  ];
  const view = dockView(state, inputs({ frames }));
  assert.equal(view.turns.length, 1);
  const turn = view.turns[0];
  assert.equal(turn.state, 'streaming');
  // While the answer streams the step line has folded into the dim log.
  assert.equal(turn.steps?.summary, 'Searching your mail');
  const cites = turn.answer!.flat().filter(s => s.kind === 'cite');
  assert.deepEqual(
    cites.map(c => (c.kind === 'cite' ? c.index : 0)),
    [1],
  );
  assert.equal(view.working, true);
});

test('a finished run shows the folded step log and numbered citations sorted by n', () => {
  const state = running();
  const frames = [
    frame('text', { delta: 'Answer. ' }),
    frame('citation', { citation: cite(2) }),
    frame('citation', { citation: cite(1) }),
    frame('done'),
  ];
  const view = dockView(state, inputs({ frames }));
  const turn = view.turns[0];
  assert.equal(turn.state, 'answered');
  assert.deepEqual(
    turn.citations.map(c => c.index),
    [1, 2],
  );
  assert.equal(turn.sourceLine, 'cited');
  assert.deepEqual(turn.provenance, { provider: 'Groq', local: false });
});

test('an answer with no citations says "No source in your mail"', () => {
  const state = running();
  const view = dockView(
    state,
    inputs({ frames: [frame('text', { delta: 'Nothing found.' }), frame('done')] }),
  );
  assert.equal(view.turns[0].sourceLine, 'noSource');
});

test('Esc on a streaming run stops it and asks the engine to cancel', () => {
  const state = running();
  const stepped = escape(state, dockView(state, inputs()));
  assert.equal(stepped.state.run?.stopped, true);
  assert.deepEqual(stepped.effects, [{ kind: 'cancel', runId: 'r1' }]);
  // The partial answer stays, marked stopped.
  const view = dockView(
    { ...stepped.state, run: { ...stepped.state.run!, settled: true } },
    inputs({ frames: [frame('text', { delta: 'Half an answer' })] }),
  );
  assert.equal(view.turns[0].state, 'stopped');
});

test('Esc then clears the field, then declines the proposal, then closes', () => {
  const idle: AskState = { ...initialAsk, field: 'typed' };
  const cleared = escape(idle, dockView(idle, inputs()));
  assert.equal(cleared.state.field, '');
  assert.equal(cleared.effects.length, 0);
  const proposal: Proposal = {
    kind: 'triage',
    id: 'p1',
    consequence: 'Move 3 emails',
    state: 'open',
    threadIds: ['t1'],
    action: { type: 'later' },
  };
  const live = running();
  const streamed = inputs({ frames: [frame('proposal', { proposal }), frame('done')] });
  // Esc stops a live run first; the proposal rung comes once the answer has landed.
  const withProposal: AskState = { ...live, run: { ...live.run!, settled: true } };
  const view = dockView(withProposal, streamed);
  assert.equal(view.working, false);
  const declined = escape(withProposal, view);
  assert.equal(declined.effects[0].kind, 'decide');
  const closed = escape(initialAsk, dockView(initialAsk, inputs()));
  assert.deepEqual(closed.effects, [{ kind: 'close' }]);
});

test('queued follow-ups run in order after the answer finishes', () => {
  let state = running();
  state = {
    ...state,
    queued: [
      { id: 'q1', text: 'first follow-up', searchAll: false },
      { id: 'q2', text: 'second follow-up', searchAll: false },
    ],
  };
  const stepped = advance(state, [frame('done')]);
  assert.equal(stepped.effects[0].kind, 'run');
  const effect = stepped.effects[0] as Extract<(typeof stepped.effects)[number], { kind: 'run' }>;
  assert.equal(effect.question, 'first follow-up');
  assert.deepEqual(
    stepped.state.queued.map(q => q.text),
    ['second follow-up'],
  );
});

test('typed while streaming queues as an editable card; ⌘Return sends now and cancels the run', () => {
  const state = { ...running(), field: 'what else?' };
  const queued = submit(state, dockView(state, inputs()), 'ask');
  assert.equal(queued.state.queued.length, 1);
  assert.equal(queued.state.field, '');
  const sent = sendNow(queued.state, dockView(queued.state, inputs()), queued.state.queued[0].id);
  const kinds = sent.effects.map(e => e.kind);
  assert.deepEqual(kinds, ['cancel', 'run']);
  assert.equal(sent.state.run?.question, 'what else?');
  assert.equal(sent.state.run?.stopped, false);
});

test('a no-provider refusal puts the question back in the field, not in an error', () => {
  let state = setField(initialAsk, 'my question');
  const started = submit(state, dockView(state, inputs()), 'ask');
  state = started.state;
  const refused = runRefused(state, state.run!.clientId, {
    type: 'notConfigured',
    reasonCode: 'ai.missingKey',
    message: 'Add a key first.',
  });
  assert.equal(refused.field, 'my question');
  const view = dockView(refused, inputs());
  assert.equal(view.providerReady, false);
  assert.equal(view.turns.length, 0);
});

test('a provider error draws a failed turn; a daily-cap refusal pauses it', () => {
  const state = running();
  const failed = dockView(
    state,
    inputs({ frames: [frame('error', { problem: { reasonCode: 'ai.unreachable' } })] }),
  );
  assert.equal(failed.turns[0].state, 'failed');
  assert.equal(failed.turns[0].provider, 'Groq');
  const paused = dockView(
    state,
    inputs({ frames: [frame('error', { problem: { reasonCode: 'ai.dailyCap' } })] }),
  );
  assert.equal(paused.turns[0].state, 'paused');
});

test('decide marks the card pending→sending and effects Ask/decide', () => {
  const proposal: Proposal = {
    kind: 'reply',
    id: 'p1',
    consequence: 'Reply to Mina',
    state: 'open',
    draft: { subject: 'Re: review' },
  };
  const state = running();
  const view = dockView(state, inputs({ frames: [frame('proposal', { proposal })] }));
  const stepped = decide(state, view, true);
  assert.equal(stepped.state.decisions.p1?.phase, 'sending');
  const effect = stepped.effects[0] as Extract<
    (typeof stepped.effects)[number],
    { kind: 'decide' }
  >;
  assert.equal(effect.proposalId, 'p1');
  assert.equal(effect.accept, true);
});

test('toParagraphs keeps only the first strong range and drops orphan chips', () => {
  const out = toParagraphs(
    [
      {
        text: 'alpha beta',
        strong: [{ start: 0, end: 5 }],
        cites: [
          { at: 5, n: 1 },
          { at: 10, n: 9 },
        ],
      },
      { text: 'gamma', strong: [{ start: 0, end: 5 }] },
    ],
    new Set([1]),
  );
  assert.equal(out.length, 2);
  const flat = out[0];
  assert.deepEqual(
    flat.map(s => (s.kind === 'text' ? `${s.strong ? '!' : ''}${s.text}` : `[${s.index}]`)),
    ['!alpha', '[1]', ' beta'],
  );
});

test('foldFrames ignores other runs and stops folding after a terminal frame', () => {
  const folded = foldFrames(
    [
      { ...frame('text', { delta: 'no' }), runId: 'other' },
      frame('done'),
      frame('text', { delta: 'late' }),
    ],
    'r1',
  );
  assert.equal(folded.terminal, 'done');
  assert.equal(folded.text, '');
});
