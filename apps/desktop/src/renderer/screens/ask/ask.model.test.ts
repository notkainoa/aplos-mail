/**
 * The Ask dock's pure decisions: frames folded into turns, citation chips, the Esc ladder, the follow-up queue,
 * no-provider versus provider-error, the daily-limit pause, and decisions. Run:
 * `cd apps/desktop && npx tsx --test 'src/renderer/screens/ask/**\/*.test.ts*'`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Citation, Conversation, ProgressFrame, Proposal } from '../../data';
import {
  advance,
  decide,
  dockView,
  escape,
  foldFrames,
  initialAsk,
  newChat,
  openConversation,
  runRefused,
  runStarted,
  sendNow,
  setField,
  submit,
  toParagraphs,
  trackedRunIds,
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
  const view = dockView(
    state,
    inputs({ frames: [frame('proposal', { proposal }), frame('done')] }),
  );
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

test('a run dropped mid-flight (⌘N, a recent chat) is cancelled when its id arrives', () => {
  const pending: AskState = {
    ...initialAsk,
    run: { clientId: 'c1', question: 'q?', searchAll: false, stopped: false, settled: false },
  };
  const stepped = newChat(pending);
  // The call is still out: no runId, so no cancel effect is possible yet.
  assert.deepEqual(stepped.effects, []);
  // `Ask/run` resolves after the state dropped the run — it must not be left to finish unobserved.
  const late = runStarted(stepped.state, 'c1', 'r-late', 'conv-1');
  assert.deepEqual(late.effects, [{ kind: 'cancel', runId: 'r-late' }]);
  assert.equal(late.state.conversationId, undefined);
  const opened = openConversation(pending, 'conv-9').state;
  const late2 = runStarted(opened, 'c1', 'r-late', 'conv-1');
  assert.deepEqual(late2.effects, [{ kind: 'cancel', runId: 'r-late' }]);
  assert.equal(late2.state.conversationId, 'conv-9');
});

test('a stored turn with a problem and a partial answer still renders failed, as the live run did', () => {
  const conversation: Conversation = {
    id: 'conv-1',
    rev: 3,
    title: 'q?',
    updatedAt: 1,
    turns: [
      {
        id: 'turn-1',
        question: 'q?',
        answer: { blocks: [{ text: 'Partial answer only.' }] },
        citations: [],
        noSource: true,
        problem: { reasonCode: 'ai.unreachable', message: 'Provider failed.' },
        proposals: [],
        steps: [],
        createdAt: 1,
      },
    ],
  };
  const state: AskState = { ...initialAsk, conversationId: 'conv-1' };
  const view = dockView(state, inputs({ conversation }));
  assert.equal(view.turns.length, 1);
  const turn = view.turns[0];
  assert.equal(turn.state, 'failed');
  assert.equal(turn.provider, 'Groq');
  // A failed partial answer does not get the closing source line.
  assert.equal(turn.sourceLine, null);
  assert.equal(turn.answer?.length, 1);
});

test('a streamed proposal becomes actionable only once the run has ended', () => {
  const proposal: Proposal = {
    kind: 'reply',
    id: 'p1',
    consequence: 'Reply to Mina',
    state: 'open',
    draft: { subject: 'Re: review' },
  };
  const state = running();
  // Mid-stream the engine has not stored the turn's proposals yet, so the affordance is held.
  const mid = dockView(state, inputs({ frames: [frame('proposal', { proposal })] }));
  assert.equal(mid.turns[0].proposal, undefined);
  assert.equal(mid.pendingProposal, undefined);
  assert.deepEqual(decide(state, mid, true).effects, []);
  // Once the run ends the card shows and Return decides.
  const done = dockView(
    state,
    inputs({ frames: [frame('proposal', { proposal }), frame('done')] }),
  );
  assert.equal(done.pendingProposal?.proposalId, 'p1');
  assert.equal(decide(state, done, true).effects[0].kind, 'decide');
});

test('a dock reopened after the run finished settles from the seeded run log, no phantom turn', () => {
  // askStore kept the run while the dock was closed; the engine finished and stored the turn. On reopen the
  // run-scoped subscription (`trackedRunIds`) replays the whole log, including the terminal frame.
  const state = running();
  assert.deepEqual(trackedRunIds(state), ['r1', undefined, undefined, undefined]);
  const frames = [frame('text', { delta: 'All done.' }), frame('done')];
  const conversation: Conversation = {
    id: 'conv-1',
    rev: 2,
    title: 'q?',
    updatedAt: 1,
    turns: [
      {
        id: 'turn-1',
        question: 'q?',
        answer: { blocks: [{ text: 'All done.' }] },
        citations: [],
        noSource: true,
        proposals: [],
        steps: [],
        createdAt: 1,
      },
    ],
  };
  const stepped = advance(state, frames);
  assert.equal(stepped.state.run?.settled, true);
  const view = dockView(stepped.state, inputs({ frames, conversation }));
  assert.equal(view.working, false);
  assert.equal(view.turns.length, 1);
  assert.equal(view.turns[0].id, 'turn-1');
  assert.equal(view.turns[0].live, false);
  // Esc's first rung is not "stop" over a finished run.
  assert.deepEqual(escape(stepped.state, view).effects, [{ kind: 'close' }]);
});

test('trackedRunIds covers the live run and the remembered past ones', () => {
  const past = {
    clientId: 'c0',
    question: 'earlier?',
    searchAll: false,
    runId: 'r0',
    stopped: true,
    settled: true,
  };
  const state: AskState = { ...running(), past: [past] };
  assert.deepEqual(trackedRunIds(state), ['r1', 'r0', undefined, undefined]);
  assert.deepEqual(trackedRunIds(initialAsk), [undefined, undefined, undefined, undefined]);
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
