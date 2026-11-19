import assert from 'node:assert/strict';
import test from 'node:test';
import type { EngineMethodName, Input, Output } from '@aplos/contract';
import type { AccountActorHost, AccountRuntime, Admission } from '../../src/ports';
import { accountWrite, T0 } from '../store/helpers';
import { CAPS } from '../sync-account-helpers';
import { testEngine } from '../runtime.helpers';

/**
 * `Setup/*` (the first-sync screen's progress): a live `AccountRuntime` or the account's stored health when no
 * actor is running, a refused retry that surfaces instead of answering ok, and an `end` bound to its own session.
 */

/** The actor host the setup area reads: `status` from a map, `request` answering what the test chooses. */
function fakeAccounts(options: {
  runtimes?: Map<string, AccountRuntime>;
  admissions?: Map<string, Admission>;
  requested?: string[];
}) {
  const accounts = {
    status: (id: string) => options.runtimes?.get(id),
    request: (id: string) => {
      options.requested?.push(id);
      return options.admissions?.get(id) ?? { ok: true as const };
    },
    requestAll: () => ({}),
  } as unknown as AccountActorHost;
  return accounts;
}

async function world(accounts: AccountActorHost) {
  const t = await testEngine({ ports: { accounts } });
  const call = <M extends EngineMethodName>(method: M, args: Input<M>) =>
    t.engine.connect().call(method, args) as Promise<Output<M>>;
  return { ...t, call };
}

const runtime = (patch: Partial<AccountRuntime> = {}): AccountRuntime => ({
  status: { state: 'syncing' },
  grantedScopes: [],
  capabilities: CAPS,
  firstWindow: { read: 0, total: 0 },
  ...patch,
});

test('Setup/status: a backfill pause after the first window keeps the row ready (no pausedUntil, no reasonCode)', async () => {
  const runtimes = new Map([
    [
      accountWrite.id,
      runtime({
        // The baseline is committed and the actor is now paused on a backfill rate limit: that pause is the
        // backfill's, not the first sync's, so the row stays ready (U8 4a: "Open Aplos" still fires).
        status: {
          state: 'paused',
          until: T0 + 60_000,
          class: 'throttle',
          reason: 'rateLimitExceeded',
        },
        reasonCode: 'rate.minute',
        baselineDoneAt: T0,
        firstWindow: { read: 50, total: 50 },
      }),
    ],
  ]);
  const w = await world(fakeAccounts({ runtimes }));
  try {
    w.store.commit({ opId: 'a1', origin: 'sync', writes: [{ ...accountWrite }] });
    const status = await w.call('Setup/status', {});
    const row = status.accounts[0];
    assert.equal(row?.state, 'ready');
    assert.equal(row?.firstWindow.done, true);
    assert.equal(row?.pausedUntil, undefined, 'the backfill pause is not the row');
    assert.equal(row?.reasonCode, undefined, 'the backfill reason is not the row');
    assert.equal(status.done, true);
    assert.equal(status.partial, false);
    assert.deepEqual(status.errors, []);
  } finally {
    await w.cleanup();
  }
});

test('Setup/status: a live pause before the first window is in still reports pausedUntil and reasonCode', async () => {
  const runtimes = new Map([
    [
      accountWrite.id,
      runtime({
        status: {
          state: 'paused',
          until: T0 + 60_000,
          class: 'throttle',
          reason: 'rateLimitExceeded',
        },
        reasonCode: 'rate.minute',
        firstWindow: { read: 12, total: 50 },
      }),
    ],
  ]);
  const w = await world(fakeAccounts({ runtimes }));
  try {
    w.store.commit({ opId: 'a1', origin: 'sync', writes: [{ ...accountWrite }] });
    const row = (await w.call('Setup/status', {})).accounts[0];
    assert.equal(row?.state, 'paused');
    assert.equal(row?.pausedUntil, T0 + 60_000);
    assert.equal(row?.reasonCode, 'rate.minute');
  } finally {
    await w.cleanup();
  }
});

test('Setup/status: with no actor the stored health answers — failed, paused and notConnected, never finding', async () => {
  const w = await world(fakeAccounts({}));
  try {
    w.store.commit({
      opId: 'a1',
      origin: 'sync',
      writes: [
        {
          ...accountWrite,
          id: 'acct-failed',
          status: { state: 'needsReauth', reason: 'invalid_grant' },
          reasonCode: 'auth.expired',
        },
        {
          ...accountWrite,
          id: 'acct-paused',
          status: {
            state: 'paused',
            until: T0 + 30_000,
            class: 'throttle',
            reason: 'rateLimitExceeded',
          },
          reasonCode: 'rate.minute',
        },
        { ...accountWrite, id: 'acct-stopped', status: { state: 'ok' } },
      ],
    });
    const status = await w.call('Setup/status', {});
    const rows = Object.fromEntries(status.accounts.map(row => [row.accountId, row]));
    const failed = rows['acct-failed'];
    assert.equal(failed?.state, 'failed');
    assert.equal(failed?.reasonCode, 'auth.expired', 'the stored reason code answers');
    const paused = rows['acct-paused'];
    assert.equal(paused?.state, 'paused');
    assert.equal(paused?.pausedUntil, T0 + 30_000, 'the stored resume time is pausedUntil');
    assert.equal(paused?.reasonCode, 'rate.minute');
    assert.equal(rows['acct-stopped']?.state, 'notConnected', 'a dead actor invents no progress');
    assert.equal(status.partial, true);
    assert.deepEqual(
      status.errors.map(error => error.accountId).sort(),
      ['acct-failed'],
      'only the failed row reports an error',
    );
  } finally {
    await w.cleanup();
  }
});

test('Setup/status: a stored pause with the first window already in is ready, like a live one', async () => {
  const w = await world(fakeAccounts({}));
  try {
    w.store.commit({
      opId: 'a1',
      origin: 'sync',
      writes: [
        {
          ...accountWrite,
          status: {
            state: 'paused',
            until: T0 + 30_000,
            class: 'throttle',
            reason: 'rateLimitExceeded',
          },
          reasonCode: 'rate.minute',
          baselineDoneAt: T0,
        },
      ],
    });
    const row = (await w.call('Setup/status', {})).accounts[0];
    assert.equal(row?.state, 'ready');
    assert.equal(row?.pausedUntil, undefined);
    assert.equal(row?.reasonCode, undefined);
  } finally {
    await w.cleanup();
  }
});

test('Setup/retry: an unknown account is notFound, a refused retry surfaces like Sync/request reports it', async () => {
  const requested: string[] = [];
  const admissions = new Map<string, Admission>([
    [
      accountWrite.id,
      { ok: false, cls: 'throttle', reason: 'rateLimitExceeded', until: T0 + 60_000 },
    ],
  ]);
  const w = await world(fakeAccounts({ admissions, requested }));
  try {
    w.store.commit({ opId: 'a1', origin: 'sync', writes: [{ ...accountWrite }] });
    await assert.rejects(
      w.call('Setup/retry', { accountId: 'acct-removed' }),
      (error: { type?: string }) => error.type === 'notFound',
    );
    assert.deepEqual(requested, [], 'nothing was asked for the unknown account');
    await assert.rejects(
      w.call('Setup/retry', { accountId: accountWrite.id }),
      (error: { type?: string; body?: { reasonCode?: string; resumeAt?: number } }) => {
        assert.equal(error.type, 'paused');
        assert.equal(
          error.body?.reasonCode,
          'rate.minute',
          'the catalogue code, not the provider reason',
        );
        assert.equal(error.body?.resumeAt, T0 + 60_000);
        return true;
      },
    );
    assert.deepEqual(requested, [accountWrite.id]);
  } finally {
    await w.cleanup();
  }
});

test('Setup/retry: an accepted retry answers ok and asked the actor once', async () => {
  const requested: string[] = [];
  const w = await world(fakeAccounts({ requested }));
  try {
    w.store.commit({ opId: 'a1', origin: 'sync', writes: [{ ...accountWrite }] });
    assert.deepEqual(await w.call('Setup/retry', { accountId: accountWrite.id }), { ok: true });
    assert.deepEqual(requested, [accountWrite.id]);
  } finally {
    await w.cleanup();
  }
});

test('Setup/end: an end naming a stale session changes nothing; its own session ends', async () => {
  const w = await world(fakeAccounts({}));
  try {
    const { setupId } = await w.call('Setup/begin', { origin: 'onboarding' });
    // An end from a session that already closed (a stale renderer or main's own close) is an idempotent ok.
    assert.deepEqual(await w.call('Setup/end', { setupId: 'setup-stale', reason: 'finished' }), {
      ok: true,
    });
    let status = await w.call('Setup/status', {});
    assert.equal(status.setupId, setupId, 'the live session survived the stale end');
    assert.deepEqual((await w.call('Session/get', {})).setup, {}, 'no setup.* was written');
    assert.deepEqual(await w.call('Setup/end', { setupId, reason: 'finished' }), { ok: true });
    status = await w.call('Setup/status', {});
    assert.equal(status.setupId, undefined);
    assert.notEqual((await w.call('Session/get', {})).setup.completedAt, undefined);
  } finally {
    await w.cleanup();
  }
});

test("Setup/end: after an engine restart (no live id) the window's own end still lands", async () => {
  const w = await world(fakeAccounts({}));
  try {
    // No Setup/begin in this engine: the renderer\'s session began before the restart, so its id is unknown here.
    assert.deepEqual(
      await w.call('Setup/end', { setupId: 'setup-before-restart', reason: 'skipped' }),
      {
        ok: true,
      },
    );
    assert.notEqual(
      (await w.call('Session/get', {})).setup.skippedAt,
      undefined,
      'a zero-account install must not reopen onboarding on the next launch',
    );
  } finally {
    await w.cleanup();
  }
});

test('Setup/end: with no setupId it still applies (main calls it with only a reason)', async () => {
  const w = await world(fakeAccounts({}));
  try {
    const { setupId } = await w.call('Setup/begin', { origin: 'onboarding' });
    assert.deepEqual(await w.call('Setup/end', { reason: 'skipped' }), { ok: true });
    assert.equal((await w.call('Setup/status', {})).setupId, undefined);
    assert.notEqual((await w.call('Session/get', {})).setup.skippedAt, undefined);
    assert.equal((await w.call('Session/get', {})).setup.completedAt, undefined);
    void setupId;
  } finally {
    await w.cleanup();
  }
});
