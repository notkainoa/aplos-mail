// Regression tests for the round-1 adversarial review of the onboarding lane (/tmp/uionb-review1.md). Each test replays
// the reviewer's sequence. Pure logic in node, plus static renders of the presentational parts; the container halves
// (listeners, timers) are checked through the pure decisions they call and, where only wiring can regress, the source.
// Run: cd apps/desktop && npx tsx --test tests/ui-onboard/review1.test.ts
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
  type ContextName,
} from '../../src/renderer/commands';
import type { SetupAccount, SetupStatus } from '../../src/renderer/data';
import {
  connectSentence,
  keySaveSentence,
  reasonSentence,
  WINDOW_COPY,
} from '../../src/renderer/onboarding/copy';
import { runAccountsEffect, type ConnectPorts } from '../../src/renderer/onboarding/connect';
import {
  flowView,
  initialFlow,
  keyPrefsFor,
  reduceFlow,
  runFlow,
  sessionSetupId,
  shouldMoveFocus,
  type FlowEffect,
  type FlowEvent,
  type FlowState,
  type StepChrome,
} from '../../src/renderer/onboarding/flow';
import { FirstSync } from '../../src/renderer/onboarding/firstSync/FirstSync';
import { DRILL_LIST_ID, DRILL_START } from '../../src/renderer/onboarding/firstSync/drill.model';
import {
  buildFirstSyncView,
  firstSyncCommands,
  firstSyncFocus,
  UNKNOWN_STATE_GRACE_MS,
  type AccountFacts,
  type FirstSyncInput,
  type FirstSyncView,
} from '../../src/renderer/onboarding/firstSync/model';
import { firstSyncStates } from '../../src/renderer/onboarding/firstSync/states';
import {
  MISSING_ACCOUNT_WAIT_MS,
  missingAccountClose,
  openReconnect,
} from '../../src/renderer/onboarding/reconnect/reconnect.model';
import { welcomeFailureLine } from '../../src/renderer/onboarding/showWelcome';
import { AccountsStep } from '../../src/renderer/onboarding/steps/Accounts';
import { keyFailureSentence } from '../../src/renderer/onboarding/steps/ai.model';
import { PermissionsStep } from '../../src/renderer/onboarding/steps/Permissions';
import { stepStates } from '../../src/renderer/onboarding/steps/states';
import { Welcome } from '../../src/renderer/onboarding/steps/Welcome';
import { ZeroAccountsView } from '../../src/renderer/onboarding/ZeroAccounts';
import type { SyncCheckpoint } from '../../src/renderer/ui/props';

const ROOT = path.resolve(import.meta.dirname, '../../src/renderer/onboarding');
const source = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const noop = () => {};

const handoffs = (effects: readonly FlowEffect[]) => effects.filter(e => e.type === 'handoff');
const ends = (effects: readonly FlowEffect[]) => effects.filter(e => e.type === 'setupEnd');

/** A window walked to first sync with a real account connected. */
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

/** Text inside visually hidden live regions removed, so what remains is what a sighted owner sees. */
const visible = (markup: string) =>
  markup
    .replace(/<p class="ui-onboarding-step__sr"[^>]*>[\s\S]*?<\/p>/g, '')
    .replace(/<span class="ui-sr-only"[^>]*>[\s\S]*?<\/span>/g, '');

/* ───────────────────────── first-sync fixtures ───────────────────────── */

const NOW = new Date(2026, 9, 29, 10, 0).getTime();
const A: AccountFacts = { id: 'a', address: 'jordan@example.com', colorTag: 'sky' };

function acct(patch: Partial<SetupAccount> = {}): SetupAccount {
  return {
    accountId: 'a',
    state: 'reading',
    firstWindow: { read: 24, total: 50, done: false },
    ai: { sorted: 0, total: 0, capped: 0, failed: 0 },
    backfill: { read: 0, target: 0 },
    runId: 'a-1',
    ...patch,
  };
}
const status = (accounts: SetupAccount[], patch: Partial<SetupStatus> = {}): SetupStatus => ({
  setupId: 's1',
  accounts,
  done: false,
  partial: false,
  errors: [],
  ...patch,
});
const build = (s: SetupStatus | undefined, patch: Partial<FirstSyncInput> = {}): FirstSyncView =>
  buildFirstSyncView({
    status: s,
    accounts: [A],
    aiProvider: 'Groq',
    consentStored: true,
    now: NOW,
    ...patch,
  });
const cp = <S extends SyncCheckpoint['step']>(v: FirstSyncView, step: S) =>
  v.rows[0].checkpoints.find(c => c.step === step) as
    Extract<SyncCheckpoint, { step: S }> | undefined;

/* ───────────────────────── 1. a failed handoff never strands the owner ───────────────────────── */

describe('review1 finding 1: a failed handoff', () => {
  test('review1: first sync Open Aplos → handoff refused → Esc, Return, Open Aplos each ask again', () => {
    const start = atFirstSync();
    const { state, each } = replay(start, [
      { type: 'open' },
      { type: 'handoffFailed' },
      { type: 'esc' },
      { type: 'handoffFailed' },
      { type: 'next' },
      { type: 'handoffFailed' },
      { type: 'open' },
    ]);
    assert.deepEqual(each[0], [{ type: 'setupEnd', reason: 'finished' }, { type: 'handoff' }]);
    assert.deepEqual(each[2], [{ type: 'handoff' }], 'Esc after the refusal asks again');
    assert.deepEqual(each[4], [{ type: 'handoff' }], 'Return after the refusal asks again');
    assert.deepEqual(each[6], [{ type: 'handoff' }], 'Open Aplos after the refusal asks again');
    assert.equal(ends(each.flat()).length, 1, 'still exactly one Setup/end');
    assert.equal(state.handoff, 'pending');
  });

  test('review1: the first-sync keys reach the window after a refusal (the screen hands every open over, no latch)', () => {
    // The registry handlers the screen attaches, wired to the window's step machine as FirstSyncSlotProps.onOpen is.
    let flow = reduceFlow(atFirstSync(), { type: 'open' }).state;
    flow = reduceFlow(flow, { type: 'handoffFailed' }).state;
    const asked: FlowEffect[] = [];
    const view = build(
      status([acct({ state: 'ready', firstWindow: { read: 50, total: 50, done: true } })]),
    );
    const handlers = firstSyncCommands({
      view: () => view,
      drillOpen: () => false,
      notice: () => undefined,
      onOpen: () => {
        const out = reduceFlow(flow, { type: 'open' });
        flow = out.state;
        asked.push(...out.effects);
      },
      onDrill: noop,
      onLeaveDrill: noop,
    });
    const registry = createAppRegistry();
    for (const [id, h] of Object.entries(handlers)) registry.attach(id, h);
    const ctx: CommandContext = {
      stack: ['onboarding', 'firstSync'],
      target: null,
      selection: [],
      conditions: {},
      prefs: DEFAULT_KEY_PREFS,
      focus: 'none',
    };
    const esc = registry.resolve(
      { key: 'Escape', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false },
      ctx,
    );
    assert.ok(esc);
    registry.run(esc.commandId, ctx);
    assert.equal(
      handoffs(asked).length,
      1,
      'Esc after a refused handoff asked for the mail window again',
    );
    // The container passes each of these straight to onOpen; the old `opened` latch swallowed every one after the first.
    const container = source('firstSync/FirstSyncContainer.tsx');
    assert.doesNotMatch(container, /opened\.current/, 'FirstSyncContainer latches Open Aplos');
    assert.match(container, /const open = \(\) => onOpen\(\);/);
  });

  test('review1: while a handoff is in flight, a second Esc or the auto-open asks nothing', () => {
    const { each } = replay(atFirstSync(), [
      { type: 'open' },
      { type: 'esc' },
      { type: 'open' },
      { type: 'handoffDone' },
    ]);
    assert.equal(handoffs(each.flat()).length, 1);
  });

  test('review1: Skip setup → handoff refused → Skip setup again asks again', () => {
    const { each } = replay(initialFlow(), [
      { type: 'skip' },
      { type: 'handoffFailed' },
      { type: 'skip' },
    ]);
    assert.deepEqual(each[0], [{ type: 'setupEnd', reason: 'skipped' }, { type: 'handoff' }]);
    assert.deepEqual(each[2], [{ type: 'handoff' }]);
  });

  test('review1: after a refusal the window knows it (Return retries on any step, the notice shows)', () => {
    const demo = replay(runFlow([{ type: 'next' }]).state, [
      { type: 'demoLoaded' },
      { type: 'handoffFailed' },
    ]);
    assert.equal(demo.state.step, 'accounts');
    assert.equal(flowView(demo.state).handoffFailed, true);
    assert.deepEqual(reduceFlow(demo.state, { type: 'retryHandoff' }).effects, [
      { type: 'handoff' },
    ]);
    // A closed window never asks, even after a refusal.
    const closed = replay(demo.state, [
      { type: 'close' },
      { type: 'retryHandoff' },
      { type: 'next' },
    ]);
    assert.equal(handoffs(closed.each.flat()).length, 0);
    assert.equal(flowView(closed.state).handoffFailed, false);
  });

  const notice = { text: WINDOW_COPY.handoffFailed, onRetry: noop };
  const chrome = (step: number): StepChrome => ({
    dashes: { step, of: 4 },
    onBack: noop,
    status: notice.text,
    notice,
  });
  const seen = (markup: string, text: string) => {
    const shown = visible(markup);
    assert.ok(
      shown.includes(text.replace(/'/g, '&#x27;')) || shown.includes(text),
      `"${text}" is not visible`,
    );
    assert.match(shown, /class="ui-error-line"/);
    assert.match(shown, />Try again</);
  };

  test('review1: the refusal is drawn visibly on first sync, not only in the hidden status', () => {
    seen(
      renderToStaticMarkup(firstSyncStates['handoff-failed'].render()),
      WINDOW_COPY.handoffFailed,
    );
    const v = build(
      status([acct({ state: 'ready', firstWindow: { read: 50, total: 50, done: true } })]),
    );
    const drill = renderToStaticMarkup(
      createElement(FirstSync, {
        view: v,
        drill: DRILL_START,
        now: NOW,
        onOpen: noop,
        onRetry: noop,
        onReconnect: noop,
        onTryKeys: noop,
        onLeaveDrill: noop,
        onDrillKey: noop,
        onDrillPick: noop,
        notice,
      }),
    );
    seen(drill, WINDOW_COPY.handoffFailed);
  });

  test('review1: the refusal and a failed demo load are visible on Welcome, Accounts and permissions', () => {
    seen(
      renderToStaticMarkup(
        createElement(Welcome, { chrome: chrome(1), onAddAccount: noop, onSkip: noop }),
      ),
      WINDOW_COPY.handoffFailed,
    );
    for (const mode of ['choose', 'typed', 'waiting', 'failed', 'connected'] as const) {
      const markup = renderToStaticMarkup(
        createElement(AccountsStep, {
          chrome: { ...chrome(2), notice: { text: WINDOW_COPY.demoFailed, onRetry: noop } },
          mode,
          address: 'jordan@example.com',
          notice: null,
          failure: null,
          accounts: [{ id: 'a', address: 'jordan@example.com', demo: false }],
          onEdit: noop,
          onSubmit: noop,
          onConnect: noop,
          onChooseGoogle: noop,
          onCancel: noop,
          onClear: noop,
          onContinue: noop,
          onAddAnother: noop,
        }),
      );
      seen(markup, WINDOW_COPY.demoFailed);
    }
    seen(
      renderToStaticMarkup(
        createElement(PermissionsStep, {
          chrome: chrome(4),
          microphone: 'notDetermined',
          notifications: 'notDetermined',
          openAtLogin: false,
          onAllow: noop,
          onOpenSettings: noop,
          onOpenAtLogin: noop,
          onFinish: noop,
        }),
      ),
      WINDOW_COPY.handoffFailed,
    );
  });

  test('review1: the window writes no sentence of its own outside copy.ts', () => {
    const app = source('OnboardingApp.tsx');
    assert.doesNotMatch(app, /couldn't open your mail window|didn't load/i);
    assert.match(app, /WINDOW_COPY\.handoffFailed/);
    assert.match(app, /WINDOW_COPY\.demoFailed/);
  });
});

/* ───────────────────────── 2. the session after it ended; demo vs a real account ───────────────────────── */

describe('review1 finding 2: after the session ended, and demo mail with a real account', () => {
  test('review1: a demo handoff ended the session on Accounts → a new connect carries no setupId', async () => {
    const ended = replay(runFlow([{ type: 'next' }]).state, [
      { type: 'demoLoaded' },
      { type: 'handoffFailed' },
    ]).state;
    assert.equal(ended.step, 'accounts');
    assert.equal(sessionSetupId(ended, 's1'), undefined);
    assert.equal(
      sessionSetupId(runFlow([{ type: 'next' }]).state, 's1'),
      's1',
      'a live session keeps its id',
    );
    const sent: unknown[] = [];
    const ports: ConnectPorts = {
      discover: async () => ({ provider: 'google' }),
      connect: async input => {
        sent.push(input);
        return { connectId: 'c9' };
      },
      cancelConnect: async () => ({ cancelled: true }),
    };
    await runAccountsEffect(
      { type: 'connect', attempt: 1 },
      ports,
      noop,
      sessionSetupId(ended, 's1'),
    );
    assert.deepEqual(sent, [{ provider: 'google' }]);
  });

  test('review1: Try demo mail hides once a real account connected, and a late demo load keeps its first sync', () => {
    const connected = runFlow([
      { type: 'next' },
      { type: 'connectStarted', connectId: 'c1' },
      { type: 'connectResolved', connectId: 'c1', outcome: 'connected', accountId: 'a1' },
    ]).state;
    assert.equal(flowView(connected).tryDemo, false);
    const late = reduceFlow(connected, { type: 'demoLoaded' });
    assert.deepEqual(
      late.effects,
      [],
      'no Setup/end and no handoff: the account still gets its first sync',
    );
    assert.equal(late.state.ended, null);
    const on = runFlow(
      [{ type: 'next' }, { type: 'next' }, { type: 'next' }, { type: 'next' }],
      late.state,
    ).state;
    assert.equal(on.step, 'firstSync');
  });
});

/* ───────────────────────── 3. first sync tells the truth ───────────────────────── */

describe('review1 finding 3: first sync', () => {
  test('review1: Sort shown done, then a larger total with a cap and a failure → no longer done, "10 of 40"', () => {
    const first = build(
      status([
        acct({
          state: 'ready',
          firstWindow: { read: 50, total: 50, done: true },
          ai: { sorted: 10, total: 10, capped: 0, failed: 0 },
        }),
      ]),
    );
    assert.equal(cp(first, 'sort')?.state, 'done');
    const next = build(
      status([
        acct({
          state: 'ready',
          firstWindow: { read: 50, total: 50, done: true },
          ai: { sorted: 10, total: 40, capped: 20, failed: 10, reasonCode: 'ai.unreachable' },
        }),
      ]),
      { previous: first },
    );
    const sort = cp(next, 'sort');
    assert.notEqual(sort?.state, 'done', 'a capped and failed pass reads as done');
    assert.equal(sort?.state, 'failed');
    assert.equal(sort?.sorted, 10);
    assert.equal(sort?.of, 40);
    assert.equal(
      next.rows[0].ready.sorted,
      undefined,
      'the ready line never says sorted for an unfinished pass',
    );
    assert.equal(next.autoOpen, false);
  });

  const failedAfterWindow = (aiProvider: string | null) =>
    build(
      status(
        [
          acct({
            state: 'failed',
            firstWindow: { read: 50, total: 50, done: true },
            ai: { sorted: 40, total: 40, capped: 0, failed: 0 },
            reasonCode: 'auth.expired',
          }),
        ],
        {
          errors: [
            { accountId: 'a', phase: 'backfill', reasonCode: 'auth.expired', at: NOW - 60_000 },
          ],
        },
      ),
      { aiProvider },
    );

  test('review1: a sign-in that expired after a complete pass is Google’s, keeps Sort done, offers Reconnect', () => {
    const v = failedAfterWindow('Groq');
    const row = v.rows[0];
    assert.equal(cp(v, 'sort')?.state, 'done', 'the finished pass is not shown as failed');
    assert.equal(cp(v, 'sort')?.sorted, 40, 'no count below the truth (39 of 40)');
    assert.equal(row.sortFailed, false);
    assert.equal(row.action, 'reconnect');
    assert.deepEqual(row.failure, {
      kind: 'reason',
      text: reasonSentence('auth.expired'),
      retryable: false,
    });
    assert.doesNotMatch(
      JSON.stringify(row.failure),
      /Groq|sort/i,
      'a Google sign-in failure blamed on the AI provider',
    );
    assert.equal(v.outcome, 'failed');
  });

  test('review1: the same failure with no AI provider still says why and offers Reconnect', () => {
    const v = failedAfterWindow(null);
    const row = v.rows[0];
    assert.equal(
      row.checkpoints.some(c => c.step === 'sort'),
      false,
    );
    assert.equal(row.action, 'reconnect');
    assert.equal(
      row.failure?.kind === 'reason' && row.failure.text,
      'Google needs you to sign in again.',
    );
    assert.notEqual(v.lede, 'Aplos waits for you. Older mail follows after you open it.');
  });

  test('review1: a status without setupId then with one is the same run (30 of 50 never drops to 20 of 50)', () => {
    const first = build(
      status([acct({ firstWindow: { read: 30, total: 50, done: false } })], { setupId: undefined }),
    );
    assert.equal(cp(first, 'read')?.read, 30);
    const next = build(
      status([acct({ firstWindow: { read: 20, total: 50, done: false } })], { setupId: 's1' }),
      {
        previous: first,
      },
    );
    assert.equal(cp(next, 'read')?.read, 30);
    // A different session still starts clean.
    const other = build(
      status([acct({ firstWindow: { read: 5, total: 50, done: false } })], { setupId: 's2' }),
      {
        previous: next,
      },
    );
    assert.equal(cp(other, 'read')?.read, 5);
  });

  test('review1: a state the screen doesn’t know never reads "Connecting…" forever; it offers Try again', () => {
    const unknown = acct({ state: 'importing', firstWindow: { read: 0, total: 0, done: false } });
    const first = build(status([unknown]));
    assert.equal(
      first.rows[0].checkpoints.some(c => c.state === 'current'),
      false,
      'nothing runs in an unknown state',
    );
    assert.equal(first.rows[0].action, 'none', 'Try again waits for the grace period');
    const later = build(status([unknown]), { previous: first, now: NOW + UNKNOWN_STATE_GRACE_MS });
    assert.equal(later.rows[0].action, 'retry');
    assert.equal(later.rows[0].failure?.kind, 'reason');
    assert.ok(later.rows[0].checkpoints.some(c => c.state === 'failed'));
  });
});

/* ───────────────────────── 4. copy names the right party ───────────────────────── */

describe('review1 finding 4: copy', () => {
  test('review1: an AI rate-limit pause names the AI provider, never Google', () => {
    const v = build(
      status([
        acct({
          state: 'paused',
          firstWindow: { read: 50, total: 50, done: true },
          ai: { sorted: 12, total: 40, capped: 0, failed: 0 },
          reasonCode: 'ai.rateLimited',
          pausedUntil: new Date(2026, 9, 29, 10, 20).getTime(),
        }),
      ]),
    );
    assert.equal(v.outcome, 'paused');
    assert.match(v.lede, /^Groq asked us to slow down\. Resuming at 10:20 AM\./);
    assert.doesNotMatch(v.lede, /Google/);
    const unnamed = build(status([acct({ state: 'paused', reasonCode: 'ai.rateLimited' })]), {
      aiProvider: null,
    });
    assert.match(unnamed.lede, /^Your AI provider asked us to slow down\./);
  });

  test('review1: a refused connect with no code says the sign-in didn’t finish, not "Sync hit a problem"', () => {
    assert.equal(connectSentence(undefined), 'Google sign-in didn’t finish. Try again.');
    assert.equal(
      connectSentence('auth.denied'),
      reasonSentence('auth.denied'),
      'known codes keep their sentence',
    );
    const markup = renderToStaticMarkup(stepStates['accounts-failed-no-code'].render());
    assert.match(markup, /Google sign-in didn’t finish\. Try again\./);
    assert.doesNotMatch(markup, /Sync hit a problem/);
  });

  test('review1: a key that couldn’t be saved on this Mac names the chosen provider and doesn’t say it refused the key', () => {
    assert.equal(
      keyFailureSentence('unknown', 'ChatGPT (OpenAI)'),
      'Aplos couldn’t save your ChatGPT key on this Mac. Paste it again, or skip for now.',
    );
    assert.equal(
      keyFailureSentence('ai.missingKey', 'Groq'),
      'Groq didn’t take that key. Paste it again, or skip for now.',
    );
    assert.doesNotMatch(keyFailureSentence('unknown', 'OpenAI'), /Groq|didn’t take/);
    assert.equal(
      keySaveSentence('auth.adminPolicy', 'Groq'),
      'Your organization has turned off saving keys.',
    );
    assert.doesNotMatch(
      source('steps/ai.model.ts'),
      /didn't take that key/,
      'the sentence lives in copy.ts',
    );
  });
});

/* ───────────────────────── 6. Reconnect and Open Settings from first sync ───────────────────────── */

describe('review1 finding 6: Reconnect and Open Settings', () => {
  test('review1: Reconnect opens the reconnect sheet, one account at a time, never a bare Account/reconnect', () => {
    assert.equal(openReconnect(null, 'a'), 'a');
    assert.equal(openReconnect('a', 'a'), 'a', 'a second press starts no second browser flow');
    assert.equal(openReconnect('a', 'b'), 'a', 'one sheet at a time');
    const app = source('OnboardingApp.tsx');
    assert.match(app, /<ReconnectFlow\b/);
    assert.match(
      app,
      /onReconnect: accountId => setReconnecting\(current => openReconnect\(current, accountId\)\)/,
    );
    assert.doesNotMatch(app, /ports\.reconnect\(|api\.account\.reconnect/);
    assert.match(
      app,
      /keysSuspended: reconnecting !== null/,
      'the screen’s Esc would also open Aplos under the sheet',
    );
  });

  test('review1: Open Settings after a sorting failure hands over to Settings → AI (and keeps it on a retry)', () => {
    const { each } = replay(atFirstSync(), [
      { type: 'openSettings' },
      { type: 'handoffFailed' },
      { type: 'retryHandoff' },
    ]);
    assert.deepEqual(each[0], [
      { type: 'setupEnd', reason: 'finished' },
      { type: 'handoff', to: 'settings.ai' },
    ]);
    assert.deepEqual(each[2], [{ type: 'handoff', to: 'settings.ai' }]);
    assert.match(
      source('OnboardingApp.tsx'),
      /onOpenSettings: \(\) => dispatchFlow\(\{ type: 'openSettings' \}\)/,
    );
    const markup = renderToStaticMarkup(firstSyncStates['ai-failed'].render());
    assert.match(markup, />Open Settings</);
  });
});

/* ───────────────────────── 7. focus entering first sync ───────────────────────── */

describe('review1 finding 7: focus on first sync (F12)', () => {
  test('review1: Finish setup → first sync focuses Continue anyway, then the filled button once it turns on', () => {
    const waiting = build(
      status([acct({ state: 'connecting', firstWindow: { read: 0, total: 0, done: false } })]),
    );
    const before = firstSyncFocus(waiting, false);
    assert.deepEqual(before.focus, { kind: 'button', label: 'Continue anyway' });
    const ready = build(
      status([acct({ state: 'ready', firstWindow: { read: 50, total: 50, done: true } })], {
        done: true,
      }),
    );
    const after = firstSyncFocus(ready, false);
    assert.deepEqual(after.focus, { kind: 'button', label: ready.primary.label });
    assert.notEqual(
      after.focusKey,
      before.focusKey,
      'the key changes when the filled button turns on',
    );
    assert.equal(
      after.focusKey.split(':')[0],
      before.focusKey.split(':')[0],
      'same step: no scroll back to the top',
    );
    const drill = firstSyncFocus(waiting, true);
    assert.deepEqual(drill.focus, { kind: 'field', id: DRILL_LIST_ID });
    assert.notEqual(drill.focusKey, before.focusKey, 'entering and leaving the drill moves focus');
    // The root no longer binds first sync with no target.
    assert.doesNotMatch(source('OnboardingApp.tsx'), /bindKeys\(\{ focusKey: 'firstSync' \}\)/);
  });

  test('review1: an engine-driven focus change never pulls focus from a control the owner chose', () => {
    assert.equal(shouldMoveFocus(true, true, 'elsewhere'), true, 'a new step always focuses');
    assert.equal(shouldMoveFocus(false, true, 'none'), true, 'focus on the body moves');
    assert.equal(
      shouldMoveFocus(false, true, 'footer'),
      true,
      'from Continue anyway to Open Aplos',
    );
    assert.equal(shouldMoveFocus(false, true, 'elsewhere'), false, 'a row’s Try again keeps focus');
    assert.equal(
      shouldMoveFocus(false, false, 'elsewhere'),
      true,
      'owner-driven state changes still move focus',
    );
  });
});

/* ───────────────────────── other PLAUSIBLE findings ───────────────────────── */

describe('review1 other findings', () => {
  test('review1: Add an account that can’t open the setup window says so visibly', () => {
    assert.equal(welcomeFailureLine('failed'), WINDOW_COPY.setupWindowFailed);
    assert.equal(welcomeFailureLine('opened'), undefined);
    const markup = renderToStaticMarkup(
      createElement(ZeroAccountsView, {
        notice: WINDOW_COPY.setupWindowFailed,
        onAddAccount: noop,
        onTryDemo: noop,
      }),
    );
    assert.ok(
      markup.includes(WINDOW_COPY.setupWindowFailed.replace(/'/g, '&#x27;')) ||
        markup.includes(WINDOW_COPY.setupWindowFailed),
    );
    assert.match(
      source('ZeroAccounts.tsx'),
      /then\(result =>\s*setNotice\(welcomeFailureLine\(result\)\)/,
    );
  });

  test('review1: the reconnect flow never waits forever for an account the list doesn’t have', () => {
    assert.equal(
      missingAccountClose(true, 0),
      'afterWait',
      'an answered empty list closes after the wait, not never',
    );
    assert.equal(missingAccountClose(true, 2), 'now');
    assert.equal(
      missingAccountClose(false, 0),
      'wait',
      'a list that has not answered yet is not proof the account is gone',
    );
    assert.ok(MISSING_ACCOUNT_WAIT_MS > 0 && MISSING_ACCOUNT_WAIT_MS <= 10_000);
    assert.match(
      source('reconnect/ReconnectFlow.tsx'),
      /setTimeout\(\(\) => close\.current\('failed'\), MISSING_ACCOUNT_WAIT_MS\)/,
    );
  });

  test('review1: the window’s keys follow the owner’s single-key setting (WCAG 2.1.4)', () => {
    const off = keyPrefsFor({
      singleKeys: false,
      holdMs: 300,
      swipeDirection: 'doneRight',
      keymap: {},
    });
    assert.equal(off.singleKeyShortcuts, false);
    assert.equal(off.holdThresholdMs, 300);
    assert.deepEqual(keyPrefsFor(undefined), DEFAULT_KEY_PREFS);
    // The drill's J resolves with the defaults and not with single keys switched off.
    const stack: ContextName[] = ['onboarding', 'firstSync', 'drill'];
    const ctx = (prefs: typeof off): CommandContext => ({
      stack,
      target: null,
      selection: [],
      conditions: {},
      prefs,
      focus: 'none',
    });
    const j = { key: 'j', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };
    // Resolve ignores commands with no attached handler, so the screen's own handlers go on as the container's do.
    const attach = (registry: ReturnType<typeof createAppRegistry>) => {
      const handlers = firstSyncCommands({
        view: () => build(status([acct()])),
        drillOpen: () => true,
        notice: () => undefined,
        onOpen: noop,
        onDrill: noop,
        onLeaveDrill: noop,
      });
      for (const [id, h] of Object.entries(handlers))
        registry.attach(id as Parameters<typeof registry.attach>[0], h);
    };
    const registry = createAppRegistry();
    attach(registry);
    assert.ok(registry.resolve(j, ctx(DEFAULT_KEY_PREFS)), 'J moves in the drill by default');
    const offRegistry = createAppRegistry(off);
    attach(offRegistry);
    const resolved = offRegistry.resolve(j, ctx(off));
    assert.ok(
      !resolved || !resolved.commandId.startsWith('drill.'),
      'J still runs with single keys off',
    );
    for (const file of ['OnboardingApp.tsx', 'firstSync/FirstSyncContainer.tsx']) {
      assert.doesNotMatch(
        source(file),
        /prefs: DEFAULT_KEY_PREFS/,
        `${file} ignores the owner's key settings`,
      );
    }
  });
});
