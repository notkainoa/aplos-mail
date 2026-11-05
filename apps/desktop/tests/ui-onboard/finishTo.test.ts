// `Window/finishOnboarding`'s optional `{ to }` input (eng-contract #289): first sync's "Open Settings" hands over
// to Settings → AI and every other way out hands over plainly. A failed handoff's Try again (Return on the notice)
// repeats the failed destination; a different way of going on asks for its own, so a stale `to` never reaches a
// handoff the owner did not ask it on. Pure reducer/effect tests plus the default port's forwarding, against a
// runtime installed through `installDataRuntime`. Main still ignores `to` until the eng-host change lands, so there
// is no end-to-end half.
// Run: cd apps/desktop && npx tsx --test tests/ui-onboard/finishTo.test.ts
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { installDataRuntime, type DataRuntime } from '../../src/renderer/data';
import {
  initialFlow,
  reduceFlow,
  runFlow,
  type FlowEffect,
  type FlowEvent,
  type FlowState,
} from '../../src/renderer/onboarding/flow';
import { defaultWindowPorts } from '../../src/renderer/onboarding/windowPorts';
import { dataWindowPorts } from '../../src/renderer/onboardingPorts';

const ends = (effects: readonly FlowEffect[]) => effects.filter(e => e.type === 'setupEnd');
const handoffs = (effects: readonly FlowEffect[]) => effects.filter(e => e.type === 'handoff');

/** A window walked to first sync with a real account connected (same walk as review1's). */
function atFirstSync(): FlowState {
  const { state } = runFlow([
    { type: 'connectStarted', connectId: 'c1' },
    { type: 'connectResolved', connectId: 'c1', outcome: 'connected', accountId: 'a1' },
    { type: 'next' },
    { type: 'next' },
    { type: 'next' },
    { type: 'next' },
  ]);
  assert.equal(state.step, 'firstSync');
  return state;
}

/** A window on the named step, no accounts: welcome → accounts → ai → permissions. */
function atPermissions(): FlowState {
  const { state } = runFlow([{ type: 'next' }, { type: 'next' }, { type: 'next' }]);
  assert.equal(state.step, 'permissions');
  return state;
}

/** Feeds events one at a time, returning the effects of each. */
function replay(start: FlowState, events: readonly FlowEvent[]) {
  let state = start;
  const each: FlowEffect[][] = [];
  for (const event of events) {
    const out = reduceFlow(state, event);
    state = out.state;
    each.push([...out.effects]);
  }
  return { state, each };
}

describe('finishOnboarding to: settings.ai', () => {
  test('finishTo: Open Settings on first sync ends setup exactly once, then hands over to Settings → AI', () => {
    const { state, each } = replay(atFirstSync(), [
      { type: 'openSettings' },
      { type: 'handoffDone' },
      { type: 'retryHandoff' },
      { type: 'openSettings' },
      { type: 'open' },
    ]);
    assert.deepEqual(each[0], [
      { type: 'setupEnd', reason: 'finished' },
      { type: 'handoff', to: 'settings.ai' },
    ]);
    assert.equal(ends(each.flat()).length, 1, 'one Setup/end for the whole session');
    assert.equal(state.ended, 'finished');
    assert.equal(state.handoff, 'idle', 'the answered handoff is not failed or in flight');
    assert.equal(
      handoffs(each.flat()).length,
      1,
      'nothing asks for the mail window after it answered',
    );
  });

  test('finishTo: Try again and Return on a failed settings handoff retry with Settings → AI, never plain', () => {
    const { each } = replay(atFirstSync(), [
      { type: 'openSettings' },
      { type: 'handoffFailed' },
      { type: 'retryHandoff' }, // the notice's Try again; Return dispatches the same event
      { type: 'handoffFailed' },
      { type: 'retryHandoff' },
    ]);
    assert.deepEqual(each[2], [{ type: 'handoff', to: 'settings.ai' }]);
    assert.deepEqual(
      each[4],
      [{ type: 'handoff', to: 'settings.ai' }],
      'the destination survives refusals',
    );
  });

  test('finishTo: pressing Open Settings again on a failed plain handoff asks for Settings → AI', () => {
    const { each } = replay(atFirstSync(), [
      { type: 'open' },
      { type: 'handoffFailed' },
      { type: 'openSettings' },
    ]);
    assert.deepEqual(each[0], [{ type: 'setupEnd', reason: 'finished' }, { type: 'handoff' }]);
    assert.deepEqual(each[2], [{ type: 'handoff', to: 'settings.ai' }]);
  });

  for (const event of [{ type: 'open' }, { type: 'esc' }, { type: 'next' }] as const) {
    test(`finishTo: ${event.type} after a failed settings handoff asks plainly — no stale destination`, () => {
      const { each } = replay(atFirstSync(), [
        { type: 'openSettings' },
        { type: 'handoffFailed' },
        event,
        { type: 'handoffFailed' },
        { type: 'retryHandoff' },
      ]);
      assert.deepEqual(
        each[2],
        [{ type: 'handoff' }],
        'a different way out asks for its own handoff',
      );
      assert.deepEqual(
        each[4],
        [{ type: 'handoff' }],
        'Try again repeats the new request, not the older settings one',
      );
    });
  }

  test('finishTo: every other way out hands over with no destination', () => {
    const cases: [string, FlowState, FlowEvent][] = [
      ['Skip setup on Welcome', initialFlow(), { type: 'skip' }],
      ['Esc on Welcome (Skip setup)', initialFlow(), { type: 'esc' }],
      ['Try demo mail on Accounts', runFlow([{ type: 'next' }]).state, { type: 'demoLoaded' }],
      ['Finish setup with nothing to sync', atPermissions(), { type: 'next' }],
      ['Open Aplos on first sync', atFirstSync(), { type: 'open' }],
      ['Esc on first sync (Open Aplos)', atFirstSync(), { type: 'esc' }],
      ['Continue on first sync', atFirstSync(), { type: 'next' }],
    ];
    for (const [label, start, event] of cases) {
      const out = reduceFlow(start, event);
      assert.deepEqual(
        handoffs(out.effects),
        [{ type: 'handoff' }],
        `${label} asks for the mail window's default screen`,
      );
      assert.equal(ends(out.effects).length, 1, `${label} still ends setup exactly once`);
    }
  });

  test('finishTo: the demo path and a late demo answer never carry a destination', () => {
    const demo = runFlow([{ type: 'demoLoaded' }]);
    assert.deepEqual(demo.effects, [{ type: 'setupEnd', reason: 'demo' }, { type: 'handoff' }]);
    const retried = replay(demo.state, [{ type: 'handoffFailed' }, { type: 'retryHandoff' }]);
    assert.deepEqual(retried.each[1], [{ type: 'handoff' }]);
  });

  test('finishTo: the default port forwards { to } to api.window.finishOnboarding', async () => {
    const calls: unknown[] = [];
    installDataRuntime({
      api: {
        window: {
          finishOnboarding: async (args: unknown) => {
            calls.push(args);
            return { ok: true };
          },
        },
      },
    } as unknown as DataRuntime);
    try {
      await defaultWindowPorts.finish({ to: 'settings.ai' });
      await defaultWindowPorts.finish();
      await defaultWindowPorts.finish({});
    } finally {
      installDataRuntime(null);
    }
    assert.deepEqual(calls, [{ to: 'settings.ai' }, {}, {}]);
  });
  test('finishTo: the window route’s own port (main.tsx passes dataWindowPorts) forwards { to } too', async () => {
    const calls: unknown[] = [];
    installDataRuntime({
      api: {
        window: {
          finishOnboarding: async (args: unknown) => {
            calls.push(args);
            return { ok: true };
          },
        },
      },
    } as unknown as DataRuntime);
    try {
      await dataWindowPorts.finish?.({ to: 'settings.ai' });
      await dataWindowPorts.finish?.();
    } finally {
      installDataRuntime(null);
    }
    assert.deepEqual(calls, [{ to: 'settings.ai' }, {}]);
  });
});
