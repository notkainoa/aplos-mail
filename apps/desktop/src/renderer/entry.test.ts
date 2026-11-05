import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  chooseEntry,
  hasBridgeShape,
  onboardingMode,
  transportOf,
  windowKind,
  wantsLegacy,
} from './entry';

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

test('the legacy switch and every production build without the bridge keep the legacy renderer, onboarding window included', () => {
  assert.equal(chooseEntry({ search: '?legacy=1', dev: true }), 'legacy');
  assert.equal(chooseEntry({ search: '?window=onboarding&legacy=1', dev: true }), 'legacy');
  assert.equal(chooseEntry({ search: '', dev: true, legacyEnv: true }), 'legacy');
  assert.equal(chooseEntry({ search: '?window=onboarding', dev: false }), 'legacy');
  assert.equal(chooseEntry({ search: '', dev: false }), 'legacy');
  assert.equal(wantsLegacy({ search: '?legacy=0', dev: true }), false);
});

test('transportOf picks the real engine whenever the window has the bridge and the legacy switch is off', () => {
  assert.equal(transportOf({ search: '', dev: true, bridge: true }), 'engine');
  assert.equal(transportOf({ search: '', dev: true }), 'standin');
  assert.equal(transportOf({ search: '', dev: true, bridge: false }), 'standin');
  assert.equal(transportOf({ search: '', dev: false, bridge: true }), 'engine');
  assert.equal(transportOf({ search: '', dev: false }), 'standin');
  assert.equal(transportOf({ search: '?legacy=1', dev: true, bridge: true }), 'standin');
  assert.equal(transportOf({ search: '', dev: true, legacyEnv: true, bridge: true }), 'standin');
  assert.equal(transportOf({ search: '?window=onboarding', dev: true, bridge: true }), 'engine');
});

test('the bridge decides a production build: with it the new roots boot, without it legacy; the legacy switch wins either way', () => {
  assert.equal(chooseEntry({ search: '', dev: false, bridge: true }), 'app');
  assert.equal(
    chooseEntry({ search: '?window=onboarding', dev: false, bridge: true }),
    'onboarding',
  );
  assert.equal(chooseEntry({ search: '?legacy=1', dev: false, bridge: true }), 'legacy');
  assert.equal(chooseEntry({ search: '', dev: false, bridge: false }), 'legacy');
  assert.equal(chooseEntry({ search: '?legacy=1', dev: true, bridge: true }), 'legacy');
  assert.equal(chooseEntry({ search: '', dev: true, legacyEnv: true, bridge: true }), 'legacy');
  assert.equal(chooseEntry({ search: '', dev: true, bridge: true }), 'app');
  assert.equal(
    chooseEntry({ search: '?window=onboarding', dev: true, bridge: true }),
    'onboarding',
  );
});

test('hasBridgeShape needs an object with call and subscribe functions and never throws', () => {
  const call = () => undefined;
  assert.equal(hasBridgeShape({ aplosEngine: { call, subscribe: call } }), true);
  assert.equal(hasBridgeShape({ aplosEngine: { call } }), false);
  assert.equal(hasBridgeShape({ aplosEngine: 'yes' }), false);
  assert.equal(hasBridgeShape({}), false);
  assert.equal(hasBridgeShape(null), false);
  const hostile = {
    get aplosEngine(): never {
      throw new Error('getter');
    },
  };
  assert.equal(hasBridgeShape(hostile), false);
});

test('a pop-out window (?draft= or ?thread=) is the legacy renderer on every build, bridge or not', () => {
  for (const dev of [true, false])
    for (const bridge of [true, false]) {
      assert.equal(chooseEntry({ search: '?draft=d1', dev, bridge }), 'legacy');
      assert.equal(chooseEntry({ search: '?thread=t1', dev, bridge }), 'legacy');
    }
  assert.equal(transportOf({ search: '?draft=d1', dev: true, bridge: true }), 'standin');
  assert.equal(chooseEntry({ search: '?drafts=1', dev: true }), 'app');
});
