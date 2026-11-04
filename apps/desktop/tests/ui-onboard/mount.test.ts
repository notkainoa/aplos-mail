// The onboarding mounts' pure conditions: the entry's route chooser and the mail pane's zero-accounts
// condition (`renderer/onboarding/route.ts`, `renderer/onboarding/demo.ts`). Run with the lane's tests:
//   cd apps/desktop && npx tsx --test "tests/ui-onboard/*.test.ts"
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseRoute, onboardingMode, scenarioParam } from '../../src/renderer/onboarding/route';
import { zeroAccountsMode } from '../../src/renderer/onboarding/demo';

describe('chooseRoute: window=onboarding routes to the onboarding app', () => {
  test('the query main gives the welcome window routes to onboarding, with and without mode', () => {
    assert.equal(chooseRoute('?window=onboarding'), 'onboarding');
    assert.equal(chooseRoute('?window=onboarding&mode=first'), 'onboarding');
    assert.equal(chooseRoute('?window=onboarding&mode=first-run'), 'onboarding');
    assert.equal(chooseRoute('?window=onboarding&mode=review'), 'onboarding');
  });

  test('a bare path and any other window value are the mail app', () => {
    assert.equal(chooseRoute(''), 'mail');
    assert.equal(chooseRoute('?'), 'mail');
    assert.equal(chooseRoute('?window=mail'), 'mail');
    assert.equal(chooseRoute('?window=popout'), 'mail');
    assert.equal(chooseRoute('?mode=review'), 'mail');
  });

  test('the legacy flag wins over the onboarding window, as today', () => {
    assert.equal(chooseRoute('?legacy=1'), 'legacy');
    assert.equal(chooseRoute('?legacy=1&window=onboarding'), 'legacy');
    assert.equal(chooseRoute('?window=onboarding&legacy=1'), 'legacy');
    // Only the exact flag counts: a stray legacy value does not block the route.
    assert.equal(chooseRoute('?legacy=0&window=onboarding'), 'onboarding');
  });
});

describe('onboardingMode: the window opens on its own default unless mode=review', () => {
  test('review is the only distinct mode', () => {
    assert.equal(onboardingMode('?window=onboarding&mode=review'), 'review');
  });

  test('first, first-run, a missing mode and anything unrecognised are the first-run flow', () => {
    assert.equal(onboardingMode('?window=onboarding'), 'first');
    assert.equal(onboardingMode('?window=onboarding&mode=first'), 'first');
    assert.equal(onboardingMode('?window=onboarding&mode=first-run'), 'first');
    assert.equal(onboardingMode('?window=onboarding&mode=bogus'), 'first');
  });
});

describe('scenarioParam: a dev URL may pick the stand-in scenario', () => {
  test('empty gives the zero-accounts stand-in; absent and anything else pass through', () => {
    assert.equal(scenarioParam('?scenario=empty'), 'empty');
    assert.equal(scenarioParam('?scenario=needs-reauth'), 'needs-reauth');
    assert.equal(scenarioParam(''), undefined);
  });
});

describe('zeroAccountsMode: when the empty pane shows the zero-accounts block', () => {
  test('with accounts the pane is never zero-accounts, whatever the sync does', () => {
    assert.equal(zeroAccountsMode({ accountCount: 1, firstSyncRunning: false }), 'none');
    assert.equal(zeroAccountsMode({ accountCount: 2, firstSyncRunning: true }), 'none');
  });

  test('with none, a running first sync always wins over the zero-accounts block', () => {
    assert.equal(zeroAccountsMode({ accountCount: 0, firstSyncRunning: true }), 'firstSync');
    assert.equal(zeroAccountsMode({ accountCount: 0, firstSyncRunning: false }), 'zero');
  });
});
