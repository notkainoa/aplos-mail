import assert from 'node:assert/strict';
import test from 'node:test';
import { ContractError } from '@aplos/contract/contract-error';
import { DESKTOP_FAILURE_KEY, desktopFailure, failureOf } from '../../src/shared/desktop-error';

test('a ContractError keeps its type, sentence and reason code', () => {
  const failure = desktopFailure(
    new ContractError({ type: 'validation', message: 'Choose a pane.', reasonCode: 'pane.bad' }),
  );
  assert.deepEqual(failure[DESKTOP_FAILURE_KEY], {
    type: 'validation',
    message: 'Choose a pane.',
    reasonCode: 'pane.bad',
  });
});

test('a plain Error keeps its sentence as unavailable, cut short; no stack or cause travels', () => {
  const failure = desktopFailure(
    new Error('Save this draft before opening a separate window.', { cause: new Error('secret') }),
  );
  assert.deepEqual(failure[DESKTOP_FAILURE_KEY], {
    type: 'unavailable',
    message: 'Save this draft before opening a separate window.',
  });
  assert.equal(
    desktopFailure(new Error('x'.repeat(1000)))[DESKTOP_FAILURE_KEY].message.length,
    300,
  );
  assert.equal(JSON.stringify(failure).includes('secret'), false);
});

test('anything that is not an error is the generic sentence', () => {
  for (const thrown of [undefined, null, 'boom', 7, {}, new Error('  ')])
    assert.deepEqual(desktopFailure(thrown)[DESKTOP_FAILURE_KEY], {
      type: 'internal',
      message: 'Something went wrong. Try again.',
    });
});

test('failureOf finds an envelope and nothing else: no normal result looks like one', () => {
  const failure = desktopFailure(new Error('No.'));
  assert.deepEqual(failureOf(failure), { type: 'unavailable', message: 'No.' });
  for (const result of [
    undefined,
    null,
    'x',
    1,
    { ok: true },
    { canceled: false },
    [],
    { [DESKTOP_FAILURE_KEY]: 'x' },
  ])
    assert.equal(failureOf(result), undefined);
});

test('a system error or a subclass never carries its message: no path, no internal text reaches the page', () => {
  const fs = Object.assign(new Error("EACCES: permission denied, open '/Users/me/secret.txt'"), {
    code: 'EACCES',
  });
  for (const thrown of [
    fs,
    new TypeError("Cannot read properties of undefined (reading 'info')"),
  ]) {
    const failure = desktopFailure(thrown)[DESKTOP_FAILURE_KEY];
    assert.deepEqual(failure, { type: 'internal', message: 'Something went wrong. Try again.' });
  }
});

test('failureOf forwards type, message and reason code only', () => {
  const widened = {
    [DESKTOP_FAILURE_KEY]: {
      type: 'unavailable',
      message: 'No.',
      stack: 'at x (/Users/me)',
      cause: 'c',
    },
  };
  assert.deepEqual(failureOf(widened), { type: 'unavailable', message: 'No.' });
});
