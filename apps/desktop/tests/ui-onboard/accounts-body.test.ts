// `AccountsBody` is the Accounts connect flow's content with no step frame: the shell's Add account dialog draws
// the same body inside its own `Dialog`. `AccountsStep` keeps the `OnboardingStep` frame around it — same title,
// footer and dashes as before.
// Run: cd apps/desktop && npx tsx --test tests/ui-onboard/accounts-body.test.ts
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { StepChrome } from '../../src/renderer/onboarding/flow';
import {
  AccountsBody,
  AccountsStep,
  type AccountRowData,
  type AccountsStepProps,
} from '../../src/renderer/onboarding/steps/Accounts';

const noop = () => {};
const chrome: StepChrome = { dashes: { step: 2, of: 4 }, onBack: noop };
const JORDAN: AccountRowData = { id: 'a1', address: 'jordan.lee@example.com', demo: false };

const body = (mode: AccountsStepProps['mode'], over: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    createElement(AccountsBody, {
      mode,
      address: 'jordan.lee@example.com',
      notice: null,
      failure: null,
      accounts: [JORDAN],
      onEdit: noop,
      onSubmit: noop,
      onChooseGoogle: noop,
      ...over,
    }),
  );

const step = (mode: AccountsStepProps['mode'], over: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    createElement(AccountsStep, {
      chrome,
      mode,
      address: 'jordan.lee@example.com',
      notice: null,
      failure: null,
      accounts: [JORDAN],
      onEdit: noop,
      onSubmit: noop,
      onConnect: noop,
      onChooseGoogle: noop,
      onCancel: noop,
      onClear: noop,
      onContinue: noop,
      onAddAnother: noop,
      ...over,
    }),
  );

// The frame's own markup (OnboardingStep.tsx): the heading and the footer. The footer says "Step N of 4" in words; the
// dashes beside it are gone.
const FRAME = ['ui-onboarding-step__title', 'ui-onboarding-step__foot'];

describe('AccountsBody draws only the connect flow, never the step frame', () => {
  test('choose: the field and the provider row, no heading, footer or step words', () => {
    const html = body('choose');
    for (const mark of FRAME) assert.ok(!html.includes(mark), mark);
    assert.ok(!html.includes('<h1'));
    assert.ok(!html.includes('Add your mail'));
    assert.ok(!html.includes('Step 2 of 4'));
    assert.ok(html.includes('onb-address'));
    assert.ok(html.includes('onb-provider-google'));
  });

  test('connected and waiting: the account list and the wait, still no frame', () => {
    const connected = body('connected');
    for (const mark of FRAME) assert.ok(!connected.includes(mark), mark);
    assert.ok(connected.includes('onb-account-a1'));
    assert.ok(connected.includes('Connected'));

    const waiting = body('waiting');
    for (const mark of FRAME) assert.ok(!waiting.includes(mark), mark);
    assert.ok(waiting.includes('Waiting for sign-in'));
  });
});

describe('AccountsStep keeps the OnboardingStep frame around the body', () => {
  test('choose: title, footer note and the "Step 2 of 4" words are present, with no dashes', () => {
    const html = step('choose');
    for (const mark of FRAME) assert.ok(html.includes(mark), mark);
    assert.ok(html.includes('Add your mail'));
    assert.ok(html.includes('>Step 2 of 4<'));
    assert.ok(html.includes('Setup continues in the background.'), 'a later step keeps the note');
    assert.ok(!html.includes('ui-onboarding-step__dashes'));
    assert.ok(html.includes('onb-address'));
  });

  test('connected: its own title and actions, and the same account list', () => {
    const html = step('connected');
    for (const mark of FRAME) assert.ok(html.includes(mark), mark);
    assert.ok(html.includes('>Step 2 of 4<'));
    assert.ok(!html.includes('ui-onboarding-step__dashes'));
    assert.ok(html.includes('Your accounts'));
    assert.ok(html.includes('Continue'));
    assert.ok(html.includes('Add another account'));
    assert.ok(html.includes('onb-account-a1'));
  });
});
