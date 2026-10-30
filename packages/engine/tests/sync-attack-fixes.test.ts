import test from 'node:test';
import assert from 'node:assert/strict';
import type { ErrorClass } from '@aplos/contract';
import type { AdapterAccount, PlannedStep, StepResult } from '../src/ports';
import { stepWrites } from '../src/sync/facts';
import { settleWrites, type OpRow } from '../src/sync/ops';

// Unit checks for the fixes behind apps/desktop/tests/prov-gov-attack.test.ts (01 and 03), which run them end to end.

const row: OpRow = { opId: 'op-1', seq: 1, state: 'inflight', attempts: 2, payload: '{}' };
const failed = (cls: ErrorClass) => ({
  opId: 'op-1',
  result: 'failed' as const,
  error: { class: cls, provider: 'gmail', method: 'gmail.messages.modify', reason: `${cls}Reason` },
});

test('prov-gov-attack-01 a refusal the governor holds requeues the op (still replayed, not an attempt); others fail it', () => {
  for (const cls of [
    'throttle',
    'daily',
    'anti_abuse',
    'auth',
    'config',
    'send_limit',
    'cancelled',
  ] as const) {
    const settled = settleWrites('acct-1', row, failed(cls), 1_000);
    assert.equal(settled.paused, true, cls);
    assert.deepEqual(
      settled.writes,
      [
        {
          kind: 'opSettle',
          opId: 'op-1',
          state: 'queued',
          nextAt: null,
          lastError: `${cls}Reason`,
        },
      ],
      cls,
    );
  }
  for (const cls of ['permission', 'permanent'] as const) {
    const settled = settleWrites('acct-1', row, failed(cls), 1_000);
    assert.notEqual(settled.paused, true, cls);
    assert.equal((settled.writes[0] as { state: string }).state, 'failed', cls);
  }
  const transient = settleWrites('acct-1', row, failed('transient'), 1_000);
  assert.equal((transient.writes[0] as { state: string; attempts: number }).attempts, 3);
});

test('prov-gov-attack-03 a list round stamps the ids it listed on the step that listed them, not only on the covering step', () => {
  const account: AdapterAccount = {
    id: 'acct-1',
    provider: 'google',
    address: 'owner@example.test',
    grantedScopes: [],
    capabilities: {
      labels: true,
      folders: false,
      drafts: true,
      serverSearch: true,
      calendar: false,
      filters: true,
      push: false,
      sendAs: true,
      unsubscribeHeaders: true,
      importance: true,
      threading: 'native',
    },
  };
  const ctx = (step: PlannedStep) => ({
    account,
    step,
    state: { scope: step.scope, generation: 7, updatedAt: 0 },
    now: 0,
    failures: new Map(),
    baselineDone: true,
  });
  const result: StepResult = {
    placements: [{ remoteId: 'm1', folder: 'INBOX', present: true }],
    nextStates: [{ scope: 'window:inbox', generation: 42, updatedAt: 0, phase: 'resyncing' }],
    done: false,
    costUnits: 0,
  };
  const listing = stepWrites(
    result,
    ctx({ scope: 'window:inbox', lane: 'incremental', origin: 'resync', trigger: 'reset' }),
  );
  assert.equal(listing.find(w => w.kind === 'placements')?.seenGen, 42);
  // History deltas never carry a stamp (a NULL stamp is never swept).
  const history = stepWrites(
    { ...result, nextStates: [] },
    ctx({ scope: 'history', lane: 'incremental', origin: 'incremental', trigger: 'poll' }),
  );
  assert.equal(history.find(w => w.kind === 'placements')?.seenGen, undefined);
});
