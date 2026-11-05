// Return while the window's failed handoff is on screen is the notice's Try again, not the
// first-sync screen's own "open": the screen's `onboarding.continue` stays disabled while the
// slot's `notice` is set, so nothing calls preventDefault and the key falls through to the window's
// own listener, whose `onboarding.continue` dispatches `retryHandoff` — repeating the destination
// the failed handoff asked for (Settings → AI after "Open Settings"). Before the gate the
// container's capture listener claimed Return first and dispatched a plain 'open', whose retry
// branch drops `handoffTo`: the same key opened Home, and behaved differently from Return with the
// primary button disabled. These tests drive the real key wiring — registry resolve then run, in
// the listeners' capture-then-bubble order — not raw reducer events.
// Run: cd apps/desktop && npx tsx --test tests/ui-onboard/finishTo.keys.test.ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  createAppRegistry,
  DEFAULT_KEY_PREFS,
  type CommandContext,
  type KeyInput,
  type Registry,
} from '../../src/renderer/commands';
import { WINDOW_COPY } from '../../src/renderer/onboarding/copy';
import {
  flowView,
  reduceFlow,
  runFlow,
  type FlowEffect,
  type FlowEvent,
  type FlowState,
  type WindowNotice,
} from '../../src/renderer/onboarding/flow';
import {
  firstSyncCommands,
  keyIntent,
  type FirstSyncView,
} from '../../src/renderer/onboarding/firstSync/model';
import { WindowNoticeLine } from '../../src/renderer/onboarding/WindowNotice';
import { acct, ready, status, view } from './firstSync.helpers';

const ROOT = path.resolve(import.meta.dirname, '../../src/renderer/onboarding');
const source = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const noop = () => {};

const CTX: CommandContext = {
  stack: ['onboarding', 'firstSync'],
  target: null,
  selection: [],
  conditions: {},
  prefs: DEFAULT_KEY_PREFS,
  focus: 'none',
};
const ENTER: KeyInput = {
  key: 'Enter',
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
};
const ESC: KeyInput = {
  key: 'Escape',
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
};

/** A window walked to first sync with a real account connected (same walk as finishTo's). */
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

/** The screen after a sort failure: the row offers "Open Settings" and the filled button is on. */
function sortFailedView(): FirstSyncView {
  const v = view(
    status([
      ready('a', 12, 40, {
        ai: { sorted: 12, total: 40, capped: 0, failed: 5, reasonCode: 'ai.missingKey' },
      }),
    ]),
  );
  assert.ok(v.rows[0].sortFailed, 'fixture: the sort failure is shown');
  assert.equal(keyIntent(v, 'Enter'), 'open', 'fixture: the screen answers Return here');
  return v;
}

/** A screen still waiting: the filled button is off, so Return was never the screen's. */
function waitingView(): FirstSyncView {
  const v = view(status([acct('a')]));
  assert.equal(keyIntent(v, 'Enter'), 'none', 'fixture: the screen never answered Return here');
  return v;
}

/** The screen's own registry, attached as FirstSyncContainer attaches firstSyncCommands to `own`. */
function screenRegistry(
  v: FirstSyncView,
  notice: () => WindowNotice | undefined,
  onOpen: () => void,
): Registry {
  const registry = createAppRegistry();
  const handlers = firstSyncCommands({
    view: () => v,
    drillOpen: () => false,
    notice,
    onOpen,
    onDrill: noop,
    onLeaveDrill: noop,
  });
  for (const [id, h] of Object.entries(handlers)) registry.attach(id, h);
  return registry;
}

/**
 * The window half of the wiring, as OnboardingApp builds it: the step machine with its effects
 * collected, the slot's `notice` prop tracking the failed handoff, and the window registry's own
 * `onboarding.continue` (firstSync's StepKeys bind no `main`, so on this step Return is only the
 * notice's Try again).
 */
function windowSide() {
  let flow = atFirstSync();
  const each: FlowEffect[][] = [];
  const dispatch = (event: FlowEvent) => {
    const out = reduceFlow(flow, event);
    flow = out.state;
    each.push([...out.effects]);
  };
  const notice: WindowNotice = {
    text: WINDOW_COPY.handoffFailed,
    onRetry: () => dispatch({ type: 'retryHandoff' }),
  };
  const handoffFailed = () => flowView(flow).handoffFailed;
  const slotNotice = () => (handoffFailed() ? notice : undefined);
  const registry = createAppRegistry();
  // firstSync's StepKeys bind no `main`, as keysRef.current reads on this step.
  const keys: { readonly main?: () => void } = {};
  registry.attach('onboarding.continue', {
    when: () => handoffFailed() || Boolean(keys.main),
    run: () => (handoffFailed() ? dispatch({ type: 'retryHandoff' }) : keys.main?.()),
  });
  return { dispatch, each, notice, slotNotice, registry, flow: () => flow };
}

/** One keydown: the screen's capture listener resolves first; an unclaimed key reaches the window's. */
function pressKey(key: KeyInput, screen: Registry, win: Registry) {
  const hit = screen.resolve(key, CTX);
  if (hit) {
    screen.run(hit.commandId, CTX);
    return { claimedBy: 'screen' as const, commandId: hit.commandId };
  }
  const winHit = win.resolve(key, CTX);
  if (winHit) win.run(winHit.commandId, CTX);
  return { claimedBy: 'window' as const, commandId: winHit?.commandId ?? null };
}

describe('finishTo keys: Return while the window’s handoff failed', () => {
  test('the failed-handoff notice disables the screen’s Return; with none the screen keeps it; Esc is unaffected', () => {
    let notice: WindowNotice | undefined = { text: WINDOW_COPY.handoffFailed, onRetry: noop };
    const calls: string[] = [];
    const registry = screenRegistry(
      sortFailedView(),
      () => notice,
      () => calls.push('open'),
    );
    assert.equal(
      registry.resolve(ENTER, CTX),
      null,
      'the screen claimed Return during a failed handoff — the window’s retry could never run',
    );
    assert.deepEqual(calls, [], 'resolve returned null, so nothing ran and nothing was prevented');
    assert.equal(
      registry.resolve(ESC, CTX)?.commandId,
      'onboarding.openAplos',
      'Esc stays the screen’s own: it asks plainly by design (F8)',
    );
    notice = undefined;
    const hit = registry.resolve(ENTER, CTX);
    assert.equal(hit?.commandId, 'onboarding.continue', 'no notice: Return is the screen’s again');
    registry.run(hit!.commandId, CTX);
    assert.deepEqual(calls, ['open']);
  });

  test('sort failure → Open Settings → refused → Return asks for the mail window with Settings → AI', () => {
    const win = windowSide();
    const opened: string[] = [];
    const screen = screenRegistry(sortFailedView(), win.slotNotice, () => {
      opened.push('open');
      win.dispatch({ type: 'open' });
    });
    win.dispatch({ type: 'openSettings' });
    win.dispatch({ type: 'handoffFailed' });
    assert.equal(flowView(win.flow()).handoffFailed, true);
    assert.deepEqual(win.each.at(-2), [
      { type: 'setupEnd', reason: 'finished' },
      { type: 'handoff', to: 'settings.ai' },
    ]);

    const pressed = pressKey(ENTER, screen, win.registry);
    assert.equal(
      pressed.claimedBy,
      'window',
      'the screen claimed Return — its plain open would drop the destination',
    );
    assert.equal(pressed.commandId, 'onboarding.continue');
    assert.deepEqual(
      win.each.at(-1),
      [{ type: 'handoff', to: 'settings.ai' }],
      'Return on the failed handoff retries with Settings → AI, not plainly',
    );
    assert.equal(win.flow().handoff, 'pending');
    assert.equal(win.flow().handoffTo, 'settings.ai');
    assert.deepEqual(opened, [], 'the screen’s Open Aplos never ran');
  });

  test('with the filled button still off the same Return falls through and retries the same way', () => {
    const win = windowSide();
    const screen = screenRegistry(waitingView(), win.slotNotice, () =>
      win.dispatch({ type: 'open' }),
    );
    win.dispatch({ type: 'openSettings' });
    win.dispatch({ type: 'handoffFailed' });
    const pressed = pressKey(ENTER, screen, win.registry);
    assert.equal(pressed.claimedBy, 'window');
    assert.deepEqual(
      win.each.at(-1),
      [{ type: 'handoff', to: 'settings.ai' }],
      'button on or off, Return on a failed handoff does the same thing',
    );
  });

  test('without a failed handoff, Return is the screen’s Open Aplos and asks plainly', () => {
    const win = windowSide();
    const screen = screenRegistry(sortFailedView(), win.slotNotice, () =>
      win.dispatch({ type: 'open' }),
    );
    const pressed = pressKey(ENTER, screen, win.registry);
    assert.equal(pressed.claimedBy, 'screen');
    assert.deepEqual(
      win.each.at(-1),
      [{ type: 'setupEnd', reason: 'finished' }, { type: 'handoff' }],
      'a plain Open Aplos carries no destination',
    );
  });

  test('the visible Try again dispatches retryHandoff and keeps the failed destination', () => {
    const win = windowSide();
    win.dispatch({ type: 'openSettings' });
    win.dispatch({ type: 'handoffFailed' });
    const markup = renderToStaticMarkup(createElement(WindowNoticeLine, { notice: win.notice }));
    assert.match(markup, />Try again</, 'the notice draws a real retry control');
    win.notice.onRetry?.();
    assert.deepEqual(win.each.at(-1), [{ type: 'handoff', to: 'settings.ai' }]);
    // The window's own wiring is source-checked: the slot feeds the screen this same notice.
    assert.match(
      source('OnboardingApp.tsx'),
      /onRetry: \(\) => dispatchFlow\(\{ type: 'retryHandoff' \}\)/,
      'the window’s Try again must dispatch retryHandoff',
    );
  });
  test('the container feeds the key table the window’s failed-handoff notice, and the screen announces it', () => {
    assert.match(
      source('firstSync/FirstSyncContainer.tsx'),
      /notice: \(\) => latest\.current\.notice/,
      'without the notice callback the first-sync Return claims the key and drops the destination',
    );
    const screen = source('firstSync/FirstSync.tsx');
    assert.equal(
      (screen.match(/phaseStatus=\{props\.notice\?\.text \?\? view\.announcement\}/g) ?? []).length,
      2,
      'a refused handoff is spoken once through the screen’s one live region, in both layouts',
    );
  });
});
