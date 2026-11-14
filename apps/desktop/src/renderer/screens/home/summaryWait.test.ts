import assert from 'node:assert/strict';
import test from 'node:test';
import { SUMMARY_WAIT_MS, waitLeft } from './summaryWait';

test('the wait for a summary starts when it is first seen pending and runs out', () => {
  const seen = new Map<string, number>();
  assert.equal(waitLeft('t1', true, 1_000, seen), SUMMARY_WAIT_MS);
  assert.equal(waitLeft('t1', true, 1_000 + 5_000, seen), SUMMARY_WAIT_MS - 5_000);
  assert.equal(waitLeft('t1', true, 1_000 + SUMMARY_WAIT_MS + 1, seen), 0);
});

test('a thread that is not pending has no wait, and its clock resets', () => {
  const seen = new Map<string, number>();
  waitLeft('t1', true, 0, seen);
  assert.equal(waitLeft('t1', false, 10, seen), null);
  assert.equal(waitLeft('t1', true, 99_000, seen), SUMMARY_WAIT_MS);
});

test('each thread has its own clock', () => {
  const seen = new Map<string, number>();
  waitLeft('a', true, 0, seen);
  assert.equal(waitLeft('b', true, 10_000, seen), SUMMARY_WAIT_MS);
});
