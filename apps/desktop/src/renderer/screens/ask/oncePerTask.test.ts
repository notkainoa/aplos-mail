/**
 * The same-tick guard behind the dock's submit paths (final review finding): a fast double click on a
 * suggestion, a queued card or Retry inside one microtask must not start two runs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { oncePerTask } from './oncePerTask';

test('the same key inside one microtask runs once; a later task is a fresh press', async () => {
  const once = oncePerTask();
  let ran = 0;
  once('submit', () => (ran += 1));
  once('submit', () => (ran += 1));
  assert.equal(ran, 1, 'a double click is one submit');
  once('esc', () => (ran += 10));
  assert.equal(ran, 11, 'a different key is not deduped');
  await new Promise<void>(resolve => queueMicrotask(() => resolve()));
  once('submit', () => (ran += 1));
  assert.equal(ran, 12, 'the guard resets on the next task');
});
