import test from 'node:test';
import assert from 'node:assert/strict';
import { OVERDUE_GRACE_MS, WAITING_SUBMISSION_STATES } from '../src/rules';
import { SubmissionState } from '../src/index';

/** FR-2: the waiting states and the overdue grace are defined once, for the contract, the engine and the stand-in. */
test('the overdue rule covers queued and scheduled sends, never sending, with a 5-minute grace', () => {
  assert.deepEqual([...WAITING_SUBMISSION_STATES], ['queued', 'scheduled']);
  for (const state of WAITING_SUBMISSION_STATES) SubmissionState.parse(state);
  assert.ok(!(WAITING_SUBMISSION_STATES as readonly string[]).includes('sending'));
  assert.equal(OVERDUE_GRACE_MS, 300_000);
});
