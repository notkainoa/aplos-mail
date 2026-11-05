/**
 * Closing the dock mid-run must not strand it: the data layer keeps every run's frames for a late subscriber that
 * names the runId, so the host's run-scoped subscriptions replay the run on reopen and the model settles instead of
 * hanging 'working' beside the stored turn. Runs a real fixture-engine Ask to prove the wiring the host depends on
 * (`useAskFrames` ↔ `trackedRunIds`), plus the consent dismissal's home in `askStore`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ProgressFrame } from '../../data';
import { createHarness } from '../../data/harness';
import { askStore, defaultDockWidth } from './askStore';
import {
  advance,
  dockView,
  initialAsk,
  trackedRunIds,
  type AskInputs,
  type AskState,
} from './ask.model';

function inputs(extra: Partial<AskInputs> = {}): AskInputs {
  return {
    frames: [],
    providers: [{ id: 'groq', label: 'Groq', local: false, status: 'ready' }],
    askReady: true,
    askModel: { provider: 'groq', model: 'demo' },
    calendars: new Map(),
    suggestions: [],
    recents: [],
    ...extra,
  };
}

test('a dock reopened after the run finished settles from the run-scoped seed, no phantom turn', async () => {
  const h = createHarness();
  try {
    await h.settle();
    const { runId, conversationId } = await h.layer.api.ask.run({
      question: 'What needs my reply today?',
    });
    // The dock is closed: nothing is subscribed. The engine streams and stores the turn anyway.
    await h.control.advanceClock({ ms: 3_000 });
    await h.settle();
    const conversation = (await h.truth.api.conversation.get({ ids: [conversationId] })).list[0]!;
    assert.ok(conversation.turns.length > 0, 'the finished turn is stored');

    // The pre-fix filter — `{source: 'ask'}` without a runId — starts empty on every mount.
    assert.equal(h.layer.bus.open('progress', { source: 'ask' }).getSnapshot().frames.length, 0);

    // The state askStore kept while the dock was closed, and the run the host now subscribes to.
    const kept: AskState = {
      ...initialAsk,
      conversationId,
      run: {
        clientId: 'c1',
        question: 'What needs my reply today?',
        searchAll: false,
        runId,
        stopped: false,
        settled: false,
      },
    };
    assert.equal(trackedRunIds(kept)[0], runId);
    const frames = h.layer.bus.open('progress', { source: 'ask', runId }).getSnapshot()
      .frames as readonly ProgressFrame[];
    assert.ok(frames.length > 0, 'the run replays from its start');
    assert.ok(
      frames.some(f => f.kind === 'done'),
      'the terminal frame is in the log',
    );

    const stepped = advance(kept, frames, false);
    assert.equal(stepped.state.run?.settled, true);
    const view = dockView(stepped.state, inputs({ conversation, frames }));
    assert.equal(view.working, false);
    assert.equal(view.turns.length, 1);
    assert.equal(view.turns[0].live, false);
    assert.equal(view.turns[0].id, conversation.turns[0].id);
  } finally {
    h.close();
  }
});

test('defaultDockWidth gives the layout default for the window: 320 under 1180 px, else 360', () => {
  assert.equal(defaultDockWidth(1179), 320);
  assert.equal(defaultDockWidth(1180), 360);
  assert.equal(defaultDockWidth(1600), 360);
});

test('"Not now" consent dismissal lives in the store, so it survives the host unmounting', () => {
  askStore.update(s => ({ ...s, consentDismissed: 7 }));
  // Other store writes (tab hops, open requests, ask state) must not drop it.
  askStore.open('today');
  askStore.update(s => ({ ...s, ask: { ...s.ask, field: 'typed' } }));
  assert.equal(askStore.get().consentDismissed, 7);
});
