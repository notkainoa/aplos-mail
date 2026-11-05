// Regression tests for the mount-branch review of the onboarding lane (the shared-shell mount: `?window=onboarding`,
// the zero-accounts pane, and the shell-hosted `ReconnectFlow`). Each test replays a finding. Pure logic in node,
// plus static renders against a connected stand-in data layer; where only wiring can regress, the source.
// Run: cd apps/desktop && npx tsx --test tests/ui-onboard/review3.test.ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createFixtureEngine, defaultNow } from '@aplos/contract-fixture';
import { connectDataLayer, type DataConnection } from '../../src/renderer/data/connect';
import { createManualScheduler, createManualTimers } from '../../src/renderer/data/scheduler';
import { ReconnectFlow } from '../../src/renderer/onboarding/reconnect/ReconnectFlow';
import {
  MISSING_ACCOUNT_WAIT_MS,
  callForSheetMode,
  initialReconnect,
  missingAccountClose,
  reduceReconnect,
  sheetView,
  type ReconnectEvent,
  type ReconnectState,
} from '../../src/renderer/onboarding/reconnect/reconnect.model';
import { ZERO_ACCOUNTS, zeroAccountsProven } from '../../src/renderer/onboarding/demo';
import { ZeroAccounts } from '../../src/renderer/onboarding/ZeroAccounts';
import { HomeEmpty } from '../../src/renderer/screens/home/HomeStates';

const ROOT = path.resolve(import.meta.dirname, '../../src/renderer');
const source = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const noop = () => {};
const nextTask = () => new Promise<void>(resolve => setImmediate(resolve));

let open: DataConnection | null = null;

afterEach(() => {
  open?.close();
  open = null;
});

/** Connects a scenario behind the data layer and lets the wanted singletons answer. */
async function boot(scenario: 'demo' | 'empty') {
  const engine = createFixtureEngine({ scenario, clock: defaultNow });
  const scheduler = createManualScheduler();
  const connection = connectDataLayer({
    session: engine.connect(),
    scheduler,
    timers: createManualTimers(defaultNow),
  });
  open = connection;
  connection.layer.session.want('accounts');
  for (let i = 0; i < 20; i += 1) {
    await nextTask();
    scheduler.flush();
  }
  return connection;
}

/* ───────────── 1. the sheet's mode arg must reach the flow (the caller's choice wins) ───────────── */

describe('mount-review 1: openSheet mode reaches the flow', () => {
  test('a SheetMode maps to its engine call', () => {
    assert.equal(callForSheetMode('grant'), 'grantPermissions');
    assert.equal(callForSheetMode('reconnect'), 'reconnect');
  });

  test('the caller’s grant wins on a demo account whose health offers nothing', async () => {
    const connection = await boot('demo');
    const account = connection.layer.session.accounts[0]!;
    const grant = renderToStaticMarkup(
      createElement(ReconnectFlow, {
        accountId: account.id,
        call: 'grantPermissions',
        onClose: noop,
      }),
    );
    assert.match(grant, /Grant access for /);
    assert.match(grant, /Waiting for Google in your browser/);
    // Without the caller's pick the same demo account derives the weekly reconnect.
    const weekly = renderToStaticMarkup(
      createElement(ReconnectFlow, { accountId: account.id, onClose: noop }),
    );
    assert.match(weekly, /Reconnect /);
    assert.doesNotMatch(weekly, /Grant access/);
  });

  test('the shell’s host passes args.mode through as the call', () => {
    assert.match(
      source('shell/SheetHost.tsx'),
      /call=\{callForSheetMode\(args\.mode\)\}/,
      'ReconnectHost must hand the caller’s mode to the flow',
    );
  });
});

/* ───────────── 2. Return in the reconnect sheet is Try again when it failed ───────────── */

describe('mount-review 2: sheet.default retries a failed reconnect only', () => {
  const waiting = (): ReconnectState =>
    reduceReconnect(initialReconnect({ accountId: 'a1', address: 'a@b.c' }), {
      type: 'open',
    }).state;

  test('the machine ignores retry in every phase but failed', () => {
    const idle = initialReconnect({ accountId: 'a1', address: 'a@b.c' });
    const events: ReconnectEvent[] = [{ type: 'retry' }];
    for (const event of events) {
      const out = reduceReconnect(idle, event);
      assert.equal(out.state, idle);
      assert.equal(out.effects.length, 0);
    }
    const out = reduceReconnect(waiting(), { type: 'retry' });
    assert.equal(out.state.phase, 'waiting');
    assert.equal(out.effects.length, 0, 'no second start while a flow is in flight');
  });

  test('a failed sheet retries into a new attempt', () => {
    let state = waiting();
    state = reduceReconnect(state, { type: 'started', attempt: 1, connectId: 'c1' }).state;
    state = reduceReconnect(state, {
      type: 'frame',
      connectId: 'c1',
      mode: 'reconnect',
      state: 'failed',
      reasonCode: 'auth.timeout',
    }).state;
    const retried = reduceReconnect(state, { type: 'retry' });
    assert.equal(retried.state.phase, 'waiting');
    assert.equal(retried.effects.length, 1);
    assert.equal(retried.effects[0]?.type, 'start');
  });

  test('the flow registers sheet.default so Return reaches the machine', () => {
    const code = source('onboarding/reconnect/ReconnectFlow.tsx');
    assert.match(code, /'sheet\.default'/, 'the sheet.default handler is registered');
    assert.match(code, /useRegisterCommands\(/, 'through the shell’s registry');
    assert.match(code, /type: 'retry'/, 'running the machine’s retry event');
  });
});

/* ───────────── 3. the mail window’s boot pulls the lane’s stylesheet ───────────── */

describe('mount-review 3: boot() imports onboarding.css', () => {
  test('the dev mail boot loads the lane’s wrappers after the one stylesheet', () => {
    const entry = source('main.tsx');
    const stylesBody = entry.slice(
      entry.indexOf('function loadMailStyles'),
      entry.indexOf('async function bootOnboarding'),
    );
    const styles = stylesBody.indexOf("import('./ui/styles.css')");
    const lane = stylesBody.indexOf("import('./onboarding/onboarding.css')");
    assert.ok(styles > 0, 'loadMailStyles() still loads ui/styles.css');
    assert.ok(lane > styles, 'onboarding.css loads after the one stylesheet for the mail window');
  });
});

/* ───────────── 4. a missing account closes only once the list has answered ───────────── */

describe('mount-review 4: the missing-account wait gates on loaded', () => {
  test('an unanswered list never closes the flow, however empty it reads', () => {
    assert.equal(missingAccountClose(false, 0), 'wait');
    assert.equal(missingAccountClose(false, 2), 'wait');
    assert.equal(missingAccountClose(true, 2), 'now', 'answered list without the account');
    assert.equal(missingAccountClose(true, 0), 'afterWait', 'answered empty list');
    assert.ok(MISSING_ACCOUNT_WAIT_MS > 0);
  });

  test('the flow hands the loaded flag to the decision', () => {
    assert.match(
      source('onboarding/reconnect/ReconnectFlow.tsx'),
      /missingAccountClose\(loaded, accounts\)/,
      'Missing must close only on an answered list',
    );
  });
});

/* ───────────── 5. zero accounts + paused/hidden is not a running first sync ───────────── */

describe('mount-review 5: no accounts never reads as first sync', () => {
  test('an empty pane with settling true still offers Add an account', async () => {
    await boot('empty');
    const html = renderToStaticMarkup(
      createElement(HomeEmpty, {
        accountCount: 0,
        settling: true,
        handledToday: 0,
        canUndo: false,
      }),
    );
    assert.match(html, /Add an account/);
    assert.doesNotMatch(html, /first mail is on its way/);
  });

  test('HomeStates no longer passes the conflated settling flag', () => {
    assert.doesNotMatch(
      source('screens/home/HomeStates.tsx'),
      /firstSyncRunning=\{settling\}/,
      'paused or hidden counts are not a running first sync',
    );
  });
});

/* ───────────── 6. a slow or failed Session/get must not blank the pane ───────────── */

describe('mount-review 6: the loaded account list proves “no accounts”', () => {
  test('the loaded list wins; the session’s word covers the time before it loads', () => {
    assert.equal(
      zeroAccountsProven({ hasAccounts: false, accountsLoaded: true, accountCount: 0 }),
      true,
    );
    assert.equal(
      zeroAccountsProven({ hasAccounts: true, accountsLoaded: true, accountCount: 0 }),
      true,
      'a stale session answer never blanks Home once the list has loaded empty',
    );
    assert.equal(
      zeroAccountsProven({ hasAccounts: undefined, accountsLoaded: true, accountCount: 0 }),
      true,
      'Session/get slow or failed: the caller’s loaded empty list is proof',
    );
    assert.equal(
      zeroAccountsProven({ hasAccounts: undefined, accountsLoaded: true, accountCount: 2 }),
      false,
    );
    assert.equal(
      zeroAccountsProven({ hasAccounts: undefined, accountsLoaded: false, accountCount: 0 }),
      false,
      'never shown while accounts are still loading',
    );
  });

  test('with the session unanswered the pane still offers Add an account once the list is in', async () => {
    const connection = await boot('empty');
    connection.layer.session.session = undefined;
    const html = renderToStaticMarkup(createElement(ZeroAccounts, {}));
    assert.match(html, /Add an account/);
  });
});

/* ───────────── 7. no dead connect bookkeeping in the pane ───────────── */

describe('mount-review 7: the pane keeps no unread connect state', () => {
  test('ZeroAccounts accumulates nothing it never reads', () => {
    assert.doesNotMatch(
      source('onboarding/ZeroAccounts.tsx'),
      /reduceAccounts|useConnectFrames|AddAccountHost|frameEvent|initialAccounts/,
      'the frames listener’s reduced state was never read',
    );
  });

  test('the pane still draws the zero block', async () => {
    await boot('empty');
    const html = renderToStaticMarkup(createElement(ZeroAccounts, {}));
    assert.match(html, new RegExp(ZERO_ACCOUNTS.text.replace(/\./g, '\\.')));
  });
});

/* ───────────── the sheet draws open from the first frame (SSR/no-effects render) ───────────── */

describe('mount-review: the hosted sheet never flashes shut', () => {
  test('sheetView opens for idle and only closes for closed', () => {
    const idle = initialReconnect({ accountId: 'a1', address: 'a@b.c' });
    assert.equal(sheetView(idle).open, true, 'idle draws as waiting, not as a closed sheet');
    assert.equal(sheetView(idle).state, 'waiting');
    const closed = reduceReconnect(waitingForClose(), { type: 'cancel' }).state;
    assert.equal(sheetView(closed).open, false);
  });

  test('a static render of the flow shows the waiting sheet, not a crash or nothing', async () => {
    const connection = await boot('demo');
    const account = connection.layer.session.accounts[0]!;
    const html = renderToStaticMarkup(
      createElement(ReconnectFlow, { accountId: account.id, onClose: noop }),
    );
    assert.match(html, /Waiting for Google in your browser/);
  });
});

function waitingForClose(): ReconnectState {
  return reduceReconnect(initialReconnect({ accountId: 'a1', address: 'a@b.c' }), {
    type: 'open',
  }).state;
}
