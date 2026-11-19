// Welcome's footer: "Skip setup" on a fresh install, "Close" when the window was reopened with accounts connected.
// Run: cd apps/desktop && npx tsx --test tests/ui-onboard/welcomeClose.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Welcome } from '../../src/renderer/onboarding/steps/Welcome';

const noop = () => {};
const chrome = { dashes: { step: 1, of: 4 }, connected: false, onBack: noop };

test('Welcome says Close, not Skip setup, once accounts exist', () => {
  const props = { chrome, onAddAccount: noop, onSkip: noop };
  const fresh = renderToStaticMarkup(createElement(Welcome, props));
  const reopened = renderToStaticMarkup(createElement(Welcome, { ...props, hasAccounts: true }));
  assert.match(fresh, /Skip setup/);
  assert.doesNotMatch(reopened, /Skip setup/);
  assert.match(reopened, />Close</);
});
