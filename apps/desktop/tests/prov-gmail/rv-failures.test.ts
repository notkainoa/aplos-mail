/** Unit tests of the quarantine retry schedule in `failures.ts` (review findings, RV-n). Synthetic ids only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { AdapterContext } from '@aplos/engine/ports';
import {
  FAILURES_KEY,
  MAX_ATTEMPTS,
  RETRY_KEY,
  readSchedule,
  settleFailures,
} from '../../src/host/providers/google/failures';
import type { FetchOutcome } from '../../src/host/providers/google/sync';

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;

const contextWith = (memory: Map<string, string>): AdapterContext =>
  ({ clock: { now: () => NOW }, memory, log: { event() {} } }) as unknown as AdapterContext;

/** One fetch in which `entry`'s own part failed with a 500. */
function failedFetch(entry: string): FetchOutcome {
  return {
    facts: [],
    byEntry: new Map(),
    pending: [entry],
    missing: [],
    quarantine: [],
    failed: [
      {
        entry,
        item: entry,
        error: {
          class: 'transient',
          provider: 'google',
          method: 'gmail.messages.get',
          reason: 'backendError',
        },
      },
    ],
    drafts: [],
    stopped: false,
  };
}

test('RV-3 a scheduled entry quarantined again by a later fetch keeps its tries and due pass', () => {
  const memory = new Map([
    [RETRY_KEY, JSON.stringify({ pass: 5, items: { m1: { tries: 2, due: 13 } } })],
    [FAILURES_KEY, JSON.stringify({ m1: { n: MAX_ATTEMPTS - 1, at: NOW - 6 * MINUTE } })],
  ]);
  const outcome = failedFetch('m1');
  const writes = settleFailures(contextWith(memory), outcome, ['m1']);
  assert.deepEqual(outcome.pending, [], 'it is quarantined, so it does not hold the cursor');
  assert.equal(outcome.quarantine.length, 1);
  const schedule = readSchedule(new Map(), writes);
  assert.deepEqual(schedule.items.m1, { tries: 2, due: 13 }, 'no fresh retries');
});
