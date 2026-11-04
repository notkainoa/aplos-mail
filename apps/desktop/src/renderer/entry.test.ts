import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chooseEntry, onboardingMode, windowKind, wantsLegacy } from './entry';

test('windowKind reads ?window=, then the test hook, and defaults to the mail window', () => {
  assert.equal(windowKind(''), 'mail');
  assert.equal(windowKind('?window=onboarding&mode=first'), 'onboarding');
  assert.equal(windowKind('?window=compose'), 'mail');
  assert.equal(windowKind('', 'onboarding'), 'onboarding');
  assert.equal(windowKind('?window=mail', 'onboarding'), 'mail');
});

test('onboardingMode is first unless the URL says review', () => {
  assert.equal(onboardingMode('?window=onboarding'), 'first');
  assert.equal(onboardingMode('?window=onboarding&mode=review'), 'review');
  assert.equal(onboardingMode('?mode=nonsense'), 'first');
});

test('a development build boots OnboardingApp for the onboarding window and App for every other window', () => {
  assert.equal(chooseEntry({ search: '?window=onboarding&mode=first', dev: true }), 'onboarding');
  assert.equal(chooseEntry({ search: '', dev: true }), 'app');
  assert.equal(chooseEntry({ search: '?window=other', dev: true }), 'app');
  assert.equal(chooseEntry({ search: '', dev: true, hook: 'onboarding' }), 'onboarding');
});

test('the legacy switch and every production build keep the legacy renderer, onboarding window included', () => {
  assert.equal(chooseEntry({ search: '?legacy=1', dev: true }), 'legacy');
  assert.equal(chooseEntry({ search: '?window=onboarding&legacy=1', dev: true }), 'legacy');
  assert.equal(chooseEntry({ search: '', dev: true, legacyEnv: true }), 'legacy');
  assert.equal(chooseEntry({ search: '?window=onboarding', dev: false }), 'legacy');
  assert.equal(chooseEntry({ search: '', dev: false }), 'legacy');
  assert.equal(wantsLegacy({ search: '?legacy=0', dev: true }), false);
});
