// The onboarding step machine (DESIGN 7.11; plan 30 U8 acceptance 2; Appendix C F1, F8, F9, F12).
// Run: cd apps/desktop && npx tsx --test tests/ui-onboard/flow.test.ts
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  dashesFor,
  flowView,
  initialFlow,
  reduceFlow,
  runFlow,
  type FlowEffect,
  type FlowEvent,
  type FlowState,
  type StepId,
} from '../../src/renderer/onboarding/flow';

const ends = (effects: readonly FlowEffect[]) => effects.filter(e => e.type === 'setupEnd');
const handoffs = (effects: readonly FlowEffect[]) => effects.filter(e => e.type === 'handoff');

/** Walks a fresh window to a step, optionally with a real account connected. */
function at(step: StepId, connected = false): FlowState {
  const events: FlowEvent[] = [];
  if (connected) {
    events.push({ type: 'connectStarted', connectId: 'c1' });
    events.push({
      type: 'connectResolved',
      connectId: 'c1',
      outcome: 'connected',
      accountId: 'a1',
    });
  }
  const order: StepId[] = ['welcome', 'accounts', 'ai', 'permissions', 'firstSync'];
  for (let i = 0; i < order.indexOf(step); i += 1) events.push({ type: 'next' });
  const out = runFlow(events);
  assert.equal(out.state.step, step);
  assert.equal(ends(out.effects).length, 0, 'walking forward never ends setup');
  return out.state;
}

describe('steps and keys', () => {
  test('next walks Welcome → Accounts → AI → permissions', () => {
    const { state } = runFlow([{ type: 'next' }, { type: 'next' }, { type: 'next' }]);
    assert.equal(state.step, 'permissions');
  });

  test('Finish setup with a real account connected goes to first sync', () => {
    const out = reduceFlow(at('permissions', true), { type: 'next' });
    assert.equal(out.state.step, 'firstSync');
    assert.deepEqual(out.effects, []);
  });

  test('Finish setup with no real account ends setup as finished and hands over (no first sync)', () => {
    const out = reduceFlow(at('permissions'), { type: 'next' });
    assert.equal(out.state.step, 'permissions');
    assert.deepEqual(out.effects, [{ type: 'setupEnd', reason: 'finished' }, { type: 'handoff' }]);
  });

  test('Esc goes back a step on Accounts, AI and permissions', () => {
    assert.equal(reduceFlow(at('accounts'), { type: 'esc' }).state.step, 'welcome');
    assert.equal(reduceFlow(at('ai'), { type: 'esc' }).state.step, 'accounts');
    assert.equal(reduceFlow(at('permissions'), { type: 'esc' }).state.step, 'ai');
  });

  test('keys-onb-esc-ladder: Esc on Welcome is Skip setup', () => {
    const out = reduceFlow(initialFlow(), { type: 'esc' });
    assert.deepEqual(out.effects, [{ type: 'setupEnd', reason: 'skipped' }, { type: 'handoff' }]);
    assert.equal(flowView(initialFlow()).esc, 'skipSetup');
    assert.equal(flowView(initialFlow()).welcome, true);
  });

  test('F8: Esc on first sync opens Aplos (finished)', () => {
    const out = reduceFlow(at('firstSync', true), { type: 'esc' });
    assert.deepEqual(out.effects, [{ type: 'setupEnd', reason: 'finished' }, { type: 'handoff' }]);
    assert.equal(flowView(at('firstSync', true)).esc, 'openAplos');
    assert.deepEqual(flowView(at('firstSync', true)).contexts, ['onboarding', 'firstSync']);
  });

  test('Open Aplos on first sync ends as finished', () => {
    const out = reduceFlow(at('firstSync', true), { type: 'open' });
    assert.deepEqual(ends(out.effects), [{ type: 'setupEnd', reason: 'finished' }]);
  });

  test('Try demo mail ends as demo and skips first sync', () => {
    const out = reduceFlow(at('accounts'), { type: 'demoLoaded' });
    assert.deepEqual(out.effects, [{ type: 'setupEnd', reason: 'demo' }, { type: 'handoff' }]);
    assert.notEqual(out.state.step, 'firstSync');
    assert.equal(out.state.hasDemo, true);
  });

  test('a connected demo account never sends the window to first sync', () => {
    const { state } = runFlow([
      {
        type: 'connectResolved',
        connectId: 'd',
        outcome: 'connected',
        accountId: 'demo1',
        demo: true,
      },
      { type: 'next' },
      { type: 'next' },
      { type: 'next' },
      { type: 'next' },
    ]);
    assert.notEqual(state.step, 'firstSync');
  });

  test('dashes: Welcome 1 of 4 … permissions 4 of 4; none on first sync', () => {
    assert.deepEqual(dashesFor('welcome'), { step: 1, of: 4 });
    assert.deepEqual(dashesFor('permissions'), { step: 4, of: 4 });
    assert.equal(dashesFor('firstSync'), undefined);
  });

  test('Try demo mail shows only on Welcome and Accounts while no demo account exists', () => {
    assert.equal(flowView(initialFlow()).tryDemo, true);
    assert.equal(flowView(at('accounts')).tryDemo, true);
    assert.equal(flowView(at('ai')).tryDemo, false);
    assert.equal(flowView(initialFlow({ hasDemo: true })).tryDemo, false);
  });

  test('keys-onb-return-each-step: Welcome and permissions name their filled main action (F12)', () => {
    assert.deepEqual(flowView(initialFlow()).focus, { kind: 'button', label: 'Add account' });
    assert.deepEqual(flowView(at('permissions')).focus, { kind: 'button', label: 'Finish setup' });
  });
});

describe('F9: a connect that resolves never navigates', () => {
  const outcomes = ['connected', 'failed', 'cancelled'] as const;
  for (const step of ['welcome', 'accounts', 'ai', 'permissions'] as const) {
    for (const outcome of outcomes) {
      test(`resolve ${outcome} while on ${step}: step unchanged, no effects`, () => {
        const start = { ...at(step), pendingConnectId: 'late' };
        const out = reduceFlow(start, {
          type: 'connectResolved',
          connectId: 'late',
          outcome,
          accountId: 'a9',
        });
        assert.equal(out.state.step, step);
        assert.deepEqual(out.effects, []);
        assert.equal(out.state.pendingConnectId, null);
        assert.deepEqual(out.state.connected, outcome === 'connected' ? ['a9'] : []);
      });
    }
  }

  test('a late connected answer still decides first sync (the account is real and was connected here)', () => {
    const { state } = runFlow([
      { type: 'next' },
      { type: 'connectStarted', connectId: 'c1' },
      { type: 'esc' }, // the owner left the Accounts step while Google was open
      { type: 'next' },
      { type: 'next' },
      { type: 'connectResolved', connectId: 'c1', outcome: 'connected', accountId: 'a1' },
    ]);
    assert.equal(state.step, 'ai', 'the late answer did not move the window');
    const out = runFlow([{ type: 'next' }, { type: 'next' }], state);
    assert.equal(out.state.step, 'firstSync');
  });
});

describe('close-at-any-moment matrix (plan 30 U8 acceptance 2; F1, F2)', () => {
  const steps: StepId[] = ['welcome', 'accounts', 'ai', 'permissions', 'firstSync'];
  // Connect states at the flow level: idle (none), pending (started, unanswered), connected (answered),
  // syncing and synced (first sync running or done; the flow holds the same facts, the screen differs).
  const connectStates = ['idle', 'pending', 'connected', 'syncing', 'synced'] as const;

  function setup(step: StepId, connect: (typeof connectStates)[number]): FlowEvent[] {
    const events: FlowEvent[] = [];
    if (connect !== 'idle') events.push({ type: 'connectStarted', connectId: 'c1' });
    if (connect !== 'idle' && connect !== 'pending') {
      events.push({
        type: 'connectResolved',
        connectId: 'c1',
        outcome: 'connected',
        accountId: 'a1',
      });
    }
    const order: StepId[] = ['welcome', 'accounts', 'ai', 'permissions', 'firstSync'];
    for (let i = 0; i < order.indexOf(step); i += 1) events.push({ type: 'next' });
    return events;
  }

  for (const step of steps) {
    for (const connect of connectStates) {
      // First sync is only reachable with a real account connected.
      if (step === 'firstSync' && (connect === 'idle' || connect === 'pending')) continue;
      test(`close at ${step} with connect ${connect}: exactly one Setup/end (closed), nothing navigates after`, () => {
        const before = runFlow(setup(step, connect));
        assert.equal(before.state.step, step);
        const closed = runFlow(
          [
            { type: 'close' },
            // Everything that can still arrive after the window closed:
            { type: 'connectResolved', connectId: 'c1', outcome: 'connected', accountId: 'a1' },
            { type: 'connectResolved', connectId: 'c2', outcome: 'failed' },
            { type: 'close' },
            { type: 'next' },
            { type: 'esc' },
            { type: 'open' },
            { type: 'demoLoaded' },
          ],
          before.state,
        );
        assert.deepEqual(ends(closed.effects), [{ type: 'setupEnd', reason: 'closed' }]);
        assert.equal(
          handoffs(closed.effects).length,
          0,
          'a closed window never asks for the mail window',
        );
        assert.equal(closed.state.step, step, 'no late answer or key moved the window');
        assert.equal(closed.state.ended, 'closed');
      });
    }
  }

  for (const [label, event, reason] of [
    ['finished', { type: 'next' }, 'finished'],
    ['skipped', { type: 'skip' }, 'skipped'],
    ['demo', { type: 'demoLoaded' }, 'demo'],
  ] as const) {
    test(`F1: ${label} then the window closes: still exactly one Setup/end (${reason})`, () => {
      const start = label === 'finished' ? at('permissions') : initialFlow();
      const out = runFlow([event, { type: 'close' }], start);
      assert.deepEqual(ends(out.effects), [{ type: 'setupEnd', reason }]);
    });
  }

  test('F1 reopen path: "Show welcome" with accounts, connect, close → one closed Setup/end', () => {
    const out = runFlow([
      { type: 'next' },
      { type: 'connectStarted', connectId: 'c1' },
      { type: 'connectResolved', connectId: 'c1', outcome: 'connected', accountId: 'a2' },
      { type: 'close' },
    ]);
    assert.deepEqual(ends(out.effects), [{ type: 'setupEnd', reason: 'closed' }]);
  });

  test('a failed handoff can be retried with Return or Esc, without a second Setup/end', () => {
    const out = runFlow([
      { type: 'esc' },
      { type: 'handoffFailed' },
      { type: 'esc' },
      { type: 'handoffFailed' },
      { type: 'next' },
    ]);
    assert.equal(ends(out.effects).length, 1);
    assert.equal(handoffs(out.effects).length, 3);
  });
});

// These need the Playwright base on the browser preview with the stand-in engine (renderer/data lands in ui-shell U2).
// The pure halves are tested above and in connect.test.ts; the DOM halves stay todo until then.
describe('DOM (needs the Playwright base and the stand-in engine)', () => {
  test.todo(
    'F12 typed address + Return focuses Continue with Google; Return continues – dom (focusTarget in OnboardingApp)',
  );
  test.todo(
    'F9 connect resolving after Esc or Back never navigates; list updates in place – dom with resolveConnect',
  );
  test.todo(
    'F13 steps never clip their top at 640×520 with long content; Welcome uses safe center – checked today by preview/shoot.mjs',
  );
  test.todo(
    'close-at-any-moment matrix in the window: pagehide at each step × connect state → one Setup/end in the contract log',
  );
  test.todo('keys-tab-order-visual – Tab order equals visual order on every step');
  test.todo('onb-ai-env-key – DOM, attributes and screenshots contain no canary key');
});
