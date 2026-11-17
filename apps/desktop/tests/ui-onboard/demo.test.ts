// Demo mail on request, the zero-accounts state and Show welcome (plan 30 §4.5 rows 8 and 9; U8 acceptance 3;
// DESIGN 7.10 Accounts, 7.14, 7.11 step 1).
// Run: cd apps/desktop && npx tsx --test tests/ui-onboard/demo.test.ts
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  REMOVE_DEMO_CONFIRM,
  ZERO_ACCOUNTS,
  demoControls,
  loadDemo,
  removeDemo,
  resetDemo,
  zeroAccountsMode,
  type DemoPorts,
} from '../../src/renderer/onboarding/demo';
import {
  ONBOARDING_ROUTE,
  openOnboardingWindow,
  showWelcome,
} from '../../src/renderer/onboarding/showWelcome';
import { WELCOME_LEDE } from '../../src/renderer/onboarding/steps/Welcome';
import { ZeroAccountsView } from '../../src/renderer/onboarding/ZeroAccounts';

const noop = () => undefined;

const REAL = { demo: false };
const DEMO = { demo: true };

/** Ports that record each contract call. */
function recorder(fail?: 'load' | 'reset' | 'remove') {
  const calls: string[] = [];
  const make = (name: 'load' | 'reset' | 'remove', method: string) => async () => {
    calls.push(method);
    if (fail === name) throw new Error('refused');
    return {};
  };
  const ports: DemoPorts = {
    load: make('load', 'Demo/load'),
    reset: make('reset', 'Demo/reset'),
    remove: make('remove', 'Demo/remove'),
  };
  return { ports, calls };
}

describe('which demo controls show', () => {
  test('Load only with no demo account; Reset and Remove only with one', () => {
    assert.deepEqual(demoControls([]), { load: true, reset: false, remove: false });
    assert.deepEqual(demoControls([REAL]), { load: true, reset: false, remove: false });
    assert.deepEqual(demoControls([DEMO]), { load: false, reset: true, remove: true });
    assert.deepEqual(demoControls([REAL, DEMO]), { load: false, reset: true, remove: true });
  });
});

describe('onb-demo-isolation: nothing reaches the engine until the explicit action', () => {
  test('rendering decisions never call the engine: demoControls and zeroAccountsMode are pure', () => {
    const { calls } = recorder();
    demoControls([]);
    zeroAccountsMode({ accountCount: 0, firstSyncRunning: false });
    assert.deepEqual(calls, []);
  });

  test('"Try demo mail" calls Demo/load once, when clicked', async () => {
    const { ports, calls } = recorder();
    assert.deepEqual(calls, []);
    assert.equal(await loadDemo(ports, []), 'loaded');
    assert.deepEqual(calls, ['Demo/load']);
  });

  test('Load with a demo account already there is refused without reaching the engine', async () => {
    const { ports, calls } = recorder();
    assert.equal(await loadDemo(ports, [DEMO]), 'exists');
    assert.deepEqual(calls, []);
  });

  test('onb-demo-existing-data-untouched: with only real accounts, Reset and Remove are refused and never reach the engine', async () => {
    const { ports, calls } = recorder();
    assert.equal(await resetDemo(ports, [REAL]), 'none');
    assert.equal(await removeDemo(ports, [REAL], () => true), 'none');
    assert.equal(await resetDemo(ports, []), 'none');
    assert.deepEqual(calls, []);
  });

  test('Reset calls Demo/reset only for a demo account; real accounts beside it are not named', async () => {
    const { ports, calls } = recorder();
    assert.equal(await resetDemo(ports, [REAL, DEMO]), 'reset');
    assert.deepEqual(calls, ['Demo/reset']);
  });

  test('a refused call is "failed", never a throw', async () => {
    assert.equal(await loadDemo(recorder('load').ports, []), 'failed');
    assert.equal(await resetDemo(recorder('reset').ports, [DEMO]), 'failed');
    assert.equal(await removeDemo(recorder('remove').ports, [DEMO], () => true), 'failed');
  });
});

describe('removing demo mail has no Undo, so it asks first', () => {
  test('without a yes nothing is removed: false, undefined, a rejection and a non-true value all cancel', async () => {
    for (const answer of [
      () => false,
      () => undefined as unknown as boolean,
      () => Promise.resolve(false),
      () => 1 as unknown as boolean,
    ]) {
      const { ports, calls } = recorder();
      assert.equal(await removeDemo(ports, [DEMO], answer), 'cancelled');
      assert.deepEqual(calls, []);
    }
    const { ports, calls } = recorder();
    assert.equal(
      await removeDemo(ports, [DEMO], () => Promise.reject(new Error('closed'))),
      'cancelled',
    );
    assert.deepEqual(calls, []);
  });

  test('a yes removes it with one Demo/remove', async () => {
    const { ports, calls } = recorder();
    assert.equal(await removeDemo(ports, [DEMO], async () => true), 'removed');
    assert.deepEqual(calls, ['Demo/remove']);
  });

  test('the confirm is destructive (Cancel is the default row), names Remove, and carries no Undo', () => {
    assert.equal(REMOVE_DEMO_CONFIRM.destructive, true);
    assert.equal(REMOVE_DEMO_CONFIRM.confirmLabel, 'Remove');
    assert.equal(REMOVE_DEMO_CONFIRM.cancelLabel, 'Cancel');
    assert.match(REMOVE_DEMO_CONFIRM.consequence, /can't be undone/);
    assert.doesNotMatch(JSON.stringify(REMOVE_DEMO_CONFIRM), /undo\b(?!ne)/i);
  });
});

describe('empty-no-accounts: the zero-accounts state', () => {
  test('no accounts and no first sync shows the zero-accounts line', () => {
    assert.equal(zeroAccountsMode({ accountCount: 0, firstSyncRunning: false }), 'zero');
  });

  test('never while a first sync runs: the first-mail line instead', () => {
    assert.equal(zeroAccountsMode({ accountCount: 0, firstSyncRunning: true }), 'firstSync');
  });

  test('with accounts (real or demo) neither line applies', () => {
    assert.equal(zeroAccountsMode({ accountCount: 1, firstSyncRunning: false }), 'none');
    assert.equal(zeroAccountsMode({ accountCount: 1, firstSyncRunning: true }), 'none');
  });

  test("DESIGN 7.14's copy", () => {
    assert.equal(ZERO_ACCOUNTS.text, 'Add an account to bring in your mail');
    assert.equal(ZERO_ACCOUNTS.add, 'Add account');
    assert.equal(ZERO_ACCOUNTS.tryDemo, 'Try demo mail');
    assert.equal(ZERO_ACCOUNTS.firstSync, 'Your first mail is on its way');
  });

  test('the block carries one sentence on Aplos, three one-line rows and the privacy line', () => {
    assert.equal(ZERO_ACCOUNTS.lede, WELCOME_LEDE, 'the same words Welcome uses');
    assert.equal(ZERO_ACCOUNTS.rows.length, 3);
    for (const row of ZERO_ACCOUNTS.rows) assert.match(row.text, /\.$/);
    assert.ok(
      ['tray', 'keyboard', 'lock'].every((icon, i) => ZERO_ACCOUNTS.rows[i]!.icon === icon),
    );
    assert.equal(
      ZERO_ACCOUNTS.privacy,
      'Sign-in is with Google in your browser; Aplos reads your mail on this Mac.',
    );
  });

  test('the view draws the block, not a bare line: one filled button, the three rows, the small line', () => {
    const markup = renderToStaticMarkup(
      createElement(ZeroAccountsView, { onAddAccount: noop, onTryDemo: noop }),
    );
    assert.ok(markup.includes('onb-zero'));
    assert.equal(markup.match(/data-variant="filled"/g)?.length, 1);
    assert.equal(markup.match(/class="ui-choice-row"/g)?.length, 3);
    for (const row of ZERO_ACCOUNTS.rows) assert.ok(markup.includes(row.text));
    assert.ok(markup.includes(ZERO_ACCOUNTS.lede));
    assert.ok(markup.includes(ZERO_ACCOUNTS.privacy));
    // A first sync still swaps the block for the one line (§4.5 rows 8 and 10).
    const syncing = renderToStaticMarkup(
      createElement(ZeroAccountsView, {
        firstSyncRunning: true,
        detail: 'Reading your newest mail · 24 of 50',
        onAddAccount: noop,
        onTryDemo: noop,
      }),
    );
    assert.ok(syncing.includes(ZERO_ACCOUNTS.firstSync));
    assert.ok(syncing.includes('24 of 50'));
    assert.ok(!syncing.includes('onb-zero'));
  });
});

describe('Show welcome', () => {
  const noWindow = (over: Partial<Parameters<typeof showWelcome>[0]> = {}) => {
    const log: string[] = [];
    return {
      log,
      ports: {
        openOnboarding: async (input: { mode: string }) => {
          log.push(`Window/openOnboarding ${input.mode}`);
        },
        isBrowserPreview: () => false,
        navigate: (route: string) => {
          log.push(`navigate ${route}`);
        },
        ...over,
      },
    };
  };

  test('in the app it opens the onboarding window in review mode and nothing else', async () => {
    const { log, ports } = noWindow();
    assert.equal(await showWelcome(ports), 'opened');
    assert.deepEqual(log, ['Window/openOnboarding review']);
  });

  test('in the browser preview it navigates to the onboarding route instead of calling main', async () => {
    const { log, ports } = noWindow({ isBrowserPreview: () => true });
    assert.equal(await showWelcome(ports), 'navigated');
    assert.deepEqual(log, [`navigate ${ONBOARDING_ROUTE}`]);
  });

  test('the zero-accounts "Add an account" opens it in first mode', async () => {
    const { log, ports } = noWindow();
    assert.equal(await openOnboardingWindow('first', ports), 'opened');
    assert.deepEqual(log, ['Window/openOnboarding first']);
  });

  test('when main cannot open it, the answer is "failed" and nothing throws', async () => {
    const { ports } = noWindow({
      openOnboarding: async () => {
        throw new Error('no window');
      },
    });
    assert.equal(await showWelcome(ports), 'failed');
  });
});
