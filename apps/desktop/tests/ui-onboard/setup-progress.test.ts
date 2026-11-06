/**
 * First sync is mail progress, never gated on AI (BUG 2, DESIGN 7.12): `Setup/status` rows drive the screen
 * with or without a provider or consent, and the data layer re-reads it on the frames a first sync raises —
 * account status transitions and each committed mail batch — so the counters move while the engine works.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Frame } from '@aplos/contract';
import type { SetupStatus } from '../../src/renderer/data';
import { SessionStore } from '../../src/renderer/data/session';
import { createEmitter } from '../../src/renderer/data/emitter';
import type { DataClient } from '../../src/renderer/data/client';
import { acct, ready, status, view } from './firstSync.helpers';

function store(calls: { setup: SetupStatus }) {
  const emitter = createEmitter();
  let setupCalls = 0;
  const client = {
    api: {},
    call: async (method: string) => {
      if (method === 'Setup/status') {
        setupCalls++;
        return calls.setup;
      }
      return {};
    },
    subscribe: () => () => undefined,
    close: () => undefined,
    inFlight: 0,
    mintId: (prefix: string) => `${prefix}-1`,
  } as unknown as DataClient;
  const session = new SessionStore(client, emitter);
  return {
    session,
    setupCalls: () => setupCalls,
    snapshot: () => session.setup,
  };
}

const state = (types: Record<string, number>, seq = 7): Frame =>
  ({ frame: 'state', dbEpoch: 'e1', seq, types }) as Frame;

test('first sync re-reads Setup/status on the frames a first sync raises (BUG 2)', async () => {
  const { session, setupCalls, snapshot } = store({
    setup: status([acct('a', { state: 'reading' })]),
  });
  // `want('setup')` is the screen asking for progress; 'accounts' stands in for useAccounts().
  (session as unknown as { want(n: string): void }).want('setup');
  (session as unknown as { want(n: string): void }).want('accounts');
  await Promise.resolve();
  assert.equal(setupCalls(), 1);
  const frames: Record<string, number>[] = [{ Account: 2 }, { Thread: 3 }, { Message: 4 }];
  for (const types of frames) {
    session.frame(state(types));
    await Promise.resolve();
    await Promise.resolve();
  }
  assert.equal(
    setupCalls(),
    4,
    'account and mail commits during the first window each refresh progress',
  );
  assert.equal(snapshot()?.accounts[0]?.state, 'reading');
});

test('first sync shows mail progress with no provider and no consent: rows count and the run reaches ready (BUG 2)', () => {
  const noAi = { aiProvider: null, consentStored: false };
  const early = view(
    status([acct('a', { state: 'connecting', firstWindow: { read: 0, total: 0, done: false } })]),
    noAi,
  );
  assert.equal(early.rows[0]?.checkpoints.find(c => c.step === 'connect')?.state, 'current');
  assert.equal(early.rows[0]?.checkpoints.length, 3, 'connect, find, read — no sort row');

  const mid = view(
    status([
      acct('a', {
        state: 'reading',
        firstWindow: { found: 214, read: 24, total: 50, done: false },
      }),
    ]),
    { ...noAi, previous: early },
  );
  const readCp = mid.rows[0]?.checkpoints.find(c => c.step === 'read');
  assert.equal(readCp?.state, 'current');
  assert.ok(
    (readCp && 'read' in readCp ? readCp.read : 0) > 0,
    'mail rows count while sorting is absent',
  );
  assert.equal(mid.rows[0]?.failure, undefined, 'no error line with AI off');

  const done = view(status([ready('a', 0, 0, { ai: undefined })], { done: true }), {
    ...noAi,
    previous: mid,
  });
  assert.equal(done.outcome, 'ready');
  assert.equal(done.autoOpen, true, 'a clean finish opens Aplos by itself with AI off');
  assert.equal(done.primary.enabled, true);
});
