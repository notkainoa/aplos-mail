import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ProviderError,
  type PlanInput,
  type PlannedStep,
  type SyncLane,
  type WorkflowChannel,
} from '../src/ports';
import type { StorePort } from '../src/store';
import { gcalBudget, gmailBudget } from '../src/sync/budgets';
import { HEARTBEAT_MS } from '../src/sync/actor';
import { opPayload } from '../src/sync/ops';
import { readGovernor } from '../src/sync/persist';
import {
  ACCOUNT,
  ADDRESS,
  FakeAdapter,
  MINUTE,
  T0,
  accountRow,
  connectResult,
  deferred,
  disk,
  fact,
  governed,
  settle,
  stateOf,
  until,
  world,
  type StepFn,
} from './sync-actor-helpers';

const step = (
  scope: PlannedStep['scope'],
  lane: SyncLane,
  origin: PlannedStep['origin'],
  trigger: PlannedStep['trigger'],
  notBefore?: number,
): PlannedStep => ({
  scope,
  lane,
  origin,
  trigger,
  ...(notBefore !== undefined ? { notBefore } : {}),
});
const stateIn = (input: PlanInput, scope: string) => input.states.find(s => s.scope === scope);
const refusal = (cls: string, extra: Record<string, unknown> = {}) =>
  new ProviderError({
    class: cls,
    provider: 'gmail',
    method: 'fake.history',
    reason: cls === 'throttle' ? 'rateLimitExceeded' : cls === 'auth' ? 'invalid_grant' : cls,
    status: 429,
    ...extra,
  });

/** History polls every 60 s from the stored cursor; `answer` decides each call. */
function poller(answer: (n: number) => void | Promise<void>): FakeAdapter {
  let n = 0;
  return new FakeAdapter(
    input => {
      const history = stateIn(input, 'history');
      const immediate = input.trigger !== 'poll' || !history;
      return [
        step(
          'history',
          'incremental',
          'incremental',
          input.trigger,
          immediate ? input.env.now : history!.updatedAt + 60_000,
        ),
      ];
    },
    {
      history: async (s, state, ctx) => {
        await governed(ctx, s, 2, () => answer(++n));
        return {
          nextStates: [{ scope: 'history', cursor: `h-${n}`, generation: 0, updatedAt: 0 }],
          done: true,
          baselineReached: true,
          costUnits: 2,
        };
      },
    },
  );
}

function enqueueArchive(store: StorePort, opId: string, remoteId: string) {
  store.commit({
    opId: `local-${opId}`,
    origin: 'local',
    writes: [
      {
        kind: 'op',
        opId,
        accountId: ACCOUNT,
        opKind: 'archive',
        targets: [`${ACCOUNT}:${remoteId}`],
        payload: opPayload(remoteId, { kind: 'folders', add: [], remove: ['INBOX'] }),
        effect: [{ kind: 'placements', target: { remoteId }, add: [], remove: ['INBOX'] }],
        scope: 'mail.write',
      },
    ],
  });
}

function seedMessages(store: StorePort, ids: string[]) {
  store.commit({
    opId: `seed-${ids.join()}`,
    origin: 'sync',
    writes: ids.map((id, i) => {
      const f = fact(id, i);
      return {
        kind: 'message' as const,
        accountId: ACCOUNT,
        remoteId: id,
        remoteThreadId: f.remoteThreadId,
        to: f.to,
        cc: f.cc,
        date: f.date,
        internalDate: f.internalDate,
        flags: f.flags,
        folders: [{ folder: 'INBOX' }],
      };
    }),
  });
}

test('prov-gov-T14 a throttle pauses the account: paused(until, throttle), zero calls, and Sync/request refused with no I/O', async () => {
  const d = disk();
  const adapter = poller(n => {
    if (n === 2) throw refusal('throttle');
  });
  const w = world(d, () => adapter);
  try {
    await w.host.start(ACCOUNT);
    await until(() => stateOf(w.store, 'history')?.cursor === 'h-1', 'the first pass');
    await settle();
    await w.clock.advance(60_000);
    await until(() => w.host.status(ACCOUNT)?.status.state === 'paused', 'the pause');
    const plansBefore = adapter.plans.length;
    const until_ = w.clock.now() + 60_000;
    assert.deepEqual(w.host.status(ACCOUNT)!.status, {
      state: 'paused',
      until: until_,
      class: 'throttle',
      reason: 'rateLimitExceeded',
    });
    assert.equal(w.host.status(ACCOUNT)!.reasonCode, 'rate.minute');
    const row = accountRow(w.store);
    assert.equal(row.status, 'paused');
    assert.equal(row.resume_at, until_);
    assert.equal(row.status_reason_code, 'rate.minute');
    // X1 (prov-gov-T29): manual syncs, double clicks and wakes during the pause make zero requests.
    for (let i = 0; i < 30; i++) {
      const answer = w.host.request(ACCOUNT, { manual: true });
      assert.deepEqual(answer, {
        ok: false,
        cls: 'throttle',
        reason: 'rateLimitExceeded',
        until: until_,
      });
      if (i % 10 === 0) w.host.wake('wake');
      await settle(2);
    }
    await w.clock.advance(59_999);
    assert.equal(adapter.calls.length, 2);
    // At the end of the pause the actor plans with `resume` and polls at once.
    await w.clock.advance(1);
    await until(() => adapter.calls.length === 3, 'the pass after the pause');
    assert.equal(
      adapter.plans.slice(plansBefore).find(p => p.trigger !== 'poll')?.trigger,
      'resume',
    );
    await until(() => w.host.status(ACCOUNT)?.status.state === 'ok', 'ok again');
    assert.equal(accountRow(w.store).status, 'ok');
  } finally {
    await w.kill();
    d.cleanup();
  }
});

test('Sync/request force during a throttle runs one step through retryNow, and the accepted call ends the pause', async () => {
  const d = disk();
  const adapter = poller(n => {
    if (n === 1) throw refusal('throttle');
  });
  const w = world(d, () => adapter);
  try {
    await w.host.start(ACCOUNT);
    await until(() => w.host.status(ACCOUNT)?.status.state === 'paused', 'the pause');
    assert.deepEqual(w.host.request(ACCOUNT, { manual: true, force: true }), { ok: true });
    await until(() => adapter.calls.length === 2, 'the forced pass');
    await until(
      () => w.host.status(ACCOUNT)?.status.state === 'ok',
      'the provider took it: the pause is over',
    );
    assert.equal(stateOf(w.store, 'history')?.cursor, 'h-2');
  } finally {
    await w.kill();
    d.cleanup();
  }
});

test('prov-gov-T21 restart restores governor state from governor_state: the cooldown is not lifted and the halved target survives', async () => {
  const d = disk();
  // Process 1 spends 4,000 units in one step, then is throttled with Retry-After 5 minutes.
  const spend: StepFn = async (s, _state, ctx) => {
    await ctx.governor.run(
      { budget: 'gmail', lane: 'interactive', kind: 'read', method: 'fake.big', cost: 4_000 },
      async () => {},
    );
    return {
      nextStates: [{ scope: s.scope, generation: 0, updatedAt: 0, phase: 'done' }],
      done: true,
      costUnits: 4_000,
    };
  };
  const first = new FakeAdapter(
    input =>
      stateIn(input, 'provider:big')?.phase === 'done'
        ? [step('history', 'incremental', 'incremental', input.trigger)]
        : [step('provider:big', 'incremental', 'baseline', input.trigger)],
    {
      'provider:big': spend,
      history: async (s, _st, ctx) =>
        governed(ctx, s, 2, () => {
          throw refusal('throttle', { retryAfterMs: 300_000 });
        }),
    },
  );
  const a = world(d, () => first);
  let cooldownUntil: number;
  try {
    await a.host.start(ACCOUNT);
    await until(() => a.host.status(ACCOUNT)?.status.state === 'paused', 'the pause');
    cooldownUntil = a.clock.now() + 300_000;
    // governor_state equals the governor's snapshot, field by field (written before the error reached the caller).
    const live = a.governor.snapshot(ACCOUNT).find(s => s.budget === 'gmail')!;
    const stored = readGovernor(a.store, ACCOUNT).find(s => s.budget === 'gmail')!;
    assert.deepEqual(stored, live);
    assert.equal(stored.cooldownUntil, cooldownUntil);
    assert.equal(stored.cooldownStep, 1);
    assert.equal(stored.target, 2_250);
  } finally {
    await a.kill();
  }
  // Process 2: same database, new governor. Zero calls until the cooldown ends, then it waits out the old minute.
  await a.clock.advance(2 * MINUTE);
  const calls: number[] = [];
  const second = new FakeAdapter(
    () => [step('provider:after', 'incremental', 'incremental', 'poll')],
    {
      'provider:after': async (s, _st, ctx) => {
        await ctx.governor.run(
          { budget: 'gmail', lane: 'interactive', kind: 'read', method: 'fake.big', cost: 1_000 },
          async () => {
            calls.push(ctx.clock.now());
          },
        );
        return {
          nextStates: [{ scope: s.scope, generation: 0, updatedAt: 0 }],
          done: true,
          costUnits: 1_000,
        };
      },
    },
  );
  const b = world(d, () => second, { clock: a.clock });
  try {
    await b.host.start(ACCOUNT);
    await until(() => b.host.status(ACCOUNT)?.status.state === 'paused', 'the restored pause');
    assert.equal(
      b.host.status(ACCOUNT)!.status.state === 'paused' &&
        (b.host.status(ACCOUNT)!.status as { until: number }).until,
      cooldownUntil,
    );
    for (let i = 0; i < 5; i++) {
      assert.equal(b.host.request(ACCOUNT, { manual: true }).ok, false);
      await b.clock.advance(30_000);
    }
    assert.equal(second.calls.length, 0, 'zero requests during the restored cooldown');
    await b.clock.advanceTo(cooldownUntil);
    await until(() => calls.length >= 1, 'the first request after the cooldown');
    assert.equal(calls[0], cooldownUntil);
    assert.equal(
      b.governor.snapshot(ACCOUNT).find(s => s.budget === 'gmail')!.target,
      2_250,
      'the halved target survived',
    );
  } finally {
    await b.kill();
    d.cleanup();
  }
});

test('prov-gov-T41 a restart inside a busy minute waits for the minute to pass', async () => {
  const d = disk();
  const big =
    (cost: number, at: number[]): StepFn =>
    async (s, _st, ctx) => {
      await ctx.governor.run(
        { budget: 'gmail', lane: 'interactive', kind: 'read', method: 'fake.big', cost },
        async () => {
          at.push(ctx.clock.now());
        },
      );
      return {
        nextStates: [{ scope: s.scope, generation: 0, updatedAt: 0, phase: 'done' }],
        done: true,
        costUnits: cost,
      };
    };
  const firstAt: number[] = [];
  const once = (fn: StepFn) =>
    new FakeAdapter(
      input =>
        stateIn(input, 'provider:x')?.phase === 'done'
          ? []
          : [step('provider:x', 'incremental', 'baseline', input.trigger)],
      { 'provider:x': fn },
    );
  const a = world(d, () => once(big(4_000, firstAt)));
  try {
    await a.host.start(ACCOUNT);
    await until(() => firstAt.length === 1, 'the busy step');
    await settle();
  } finally {
    await a.kill();
  }
  await a.clock.advance(5_000);
  // The new process has one more request to make on the same scope.
  const secondAt: number[] = [];
  const reopened = world(d, () => once(big(1_000, secondAt)), { clock: a.clock });
  try {
    reopened.store.commit({
      opId: 'reset-x',
      origin: 'system',
      writes: [{ kind: 'syncState', accountId: ACCOUNT, scope: 'provider:x', generation: 0 }],
    });
    await reopened.host.start(ACCOUNT);
    await settle(20);
    assert.equal(secondAt.length, 0, 'the restored window is full');
    await reopened.clock.advanceTo(firstAt[0] + MINUTE + 15_000);
    await until(() => secondAt.length === 1, 'the request once the old minute has aged out');
    assert.ok(
      secondAt[0] >= firstAt[0] + MINUTE,
      `sent ${secondAt[0] - firstAt[0]} ms after the busy minute began`,
    );
  } finally {
    await reopened.kill();
    d.cleanup();
  }
});

test('prov-gov-T53 prov-gov-T54 an auth block: needsReauth, no calls, ops kept; reconnect flushes them first and resumes the stored cursor with no resync', async () => {
  const d = disk();
  let expired = false;
  const adapter = new FakeAdapter(
    input => {
      const history = stateIn(input, 'history');
      if (!history?.cursor) return [step('window:inbox', 'incremental', 'resync', input.trigger)];
      return [
        step(
          'history',
          'incremental',
          'incremental',
          input.trigger,
          input.trigger === 'poll' ? history.updatedAt + 60_000 : input.env.now,
        ),
      ];
    },
    {
      history: async (s, state, ctx) => {
        await governed(ctx, s, 2, () => {
          if (expired) throw refusal('auth', { status: 400 });
        });
        return {
          nextStates: [
            { scope: 'history', cursor: `${state.cursor}+`, generation: 0, updatedAt: 0 },
          ],
          done: true,
          baselineReached: true,
          costUnits: 2,
        };
      },
      'window:inbox': async () => {
        throw new Error('a reconnect must not resync');
      },
    },
  );
  const w = world(d, () => adapter);
  try {
    seedMessages(w.store, ['m1', 'm2', 'm3']);
    w.store.commit({
      opId: 'cursor',
      origin: 'sync',
      writes: [
        { kind: 'syncState', accountId: ACCOUNT, scope: 'history', cursor: 'h-5', generation: 0 },
      ],
    });
    await w.host.start(ACCOUNT);
    await until(() => stateOf(w.store, 'history')?.cursor === 'h-5+', 'the first poll');
    await settle();
    expired = true;
    await w.clock.advance(60_000);
    await until(() => w.host.status(ACCOUNT)?.status.state === 'needsReauth', 'needsReauth');
    assert.equal(w.host.status(ACCOUNT)!.reasonCode, 'auth.revoked');
    assert.equal(accountRow(w.store).status, 'needsReauth');
    const before = adapter.calls.length;
    // Local actions while expired queue; nothing goes out for a day of manual syncs, wakes and op triggers.
    for (const id of ['m1', 'm2', 'm3']) {
      enqueueArchive(w.store, `op-${id}`, id);
      w.host.opsChanged(ACCOUNT);
    }
    for (let i = 0; i < 24; i++) {
      assert.deepEqual(w.host.request(ACCOUNT, { manual: true }), {
        ok: false,
        cls: 'auth',
        reason: 'invalid_grant',
      });
      w.host.wake('network');
      await w.clock.advance(3600_000);
    }
    assert.equal(adapter.calls.length, before, 'zero requests while expired');
    assert.equal(
      w.store.read(q =>
        q.get<{ n: number }>("SELECT COUNT(*) AS n FROM ops WHERE state = 'queued'"),
      )!.n,
      3,
    );
    // Reconnect: grant stored, block cleared, ops flushed before the first sync step, which uses the stored cursor.
    expired = false;
    await w.host.reconnected(ACCOUNT, connectResult());
    await until(() => adapter.calls.length === before + 4, 'three applies and one poll');
    assert.deepEqual(adapter.calls.slice(before), [
      'apply:op-m1',
      'apply:op-m2',
      'apply:op-m3',
      'history:',
    ]);
    await until(() => stateOf(w.store, 'history')?.cursor === 'h-5++', 'the poll commit');
    assert.equal(stateOf(w.store, 'history')?.cursor, 'h-5++', 'resumed from the stored cursor');
    assert.equal(w.store.read(q => q.get<{ n: number }>('SELECT COUNT(*) AS n FROM ops'))!.n, 0);
    await until(() => w.host.status(ACCOUNT)?.status.state === 'ok', 'ok');
    const row = accountRow(w.store);
    assert.equal(row.refresh_expires_at, T0 + 7 * 86_400_000);
    assert.equal(row.remote_subject, 'sub-1');
  } finally {
    await w.kill();
    d.cleanup();
  }
});

test('op outcomes settle: applied and notFound drop the op, a failure holds back later ops, transient retries later', async () => {
  const d = disk();
  const adapter = poller(() => {});
  adapter.planner = () => [];
  const outcomes: Record<string, 'applied' | 'notFound' | 'permanent' | 'transient' | 'uncertain'> =
    {
      'op-a': 'applied',
      'op-b': 'notFound',
      'op-c': 'transient',
      'op-d': 'applied',
    };
  adapter.applyFn = async op =>
    op.opIds.map(opId => {
      const kind = outcomes[opId];
      if (kind === 'applied' || kind === 'notFound') return { opId, result: kind };
      return {
        opId,
        result: 'failed',
        error: {
          class: kind === 'uncertain' ? 'transient' : kind,
          provider: 'gmail',
          method: 'fake.modify',
          reason: kind,
          ...(kind === 'uncertain' ? { uncertain: true } : {}),
        },
      };
    });
  const w = world(d, () => adapter);
  const ops = () =>
    w.store
      .read(q =>
        q.all<{ op_id: string; state: string; last_error: string | null; next_at: number | null }>(
          'SELECT op_id, state, last_error, next_at FROM ops ORDER BY seq',
        ),
      )
      .map(r => ({ ...r }));
  try {
    seedMessages(w.store, ['a', 'b', 'c', 'd']);
    for (const id of ['a', 'b', 'c', 'd']) enqueueArchive(w.store, `op-${id}`, id);
    await w.host.start(ACCOUNT);
    await until(() => adapter.applied.length === 3, 'three applies');
    await settle();
    const now = w.clock.now();
    assert.deepEqual(
      ops(),
      [
        { op_id: 'op-c', state: 'queued', last_error: 'transient', next_at: now + 30_000 },
        { op_id: 'op-d', state: 'queued', last_error: null, next_at: null },
      ],
      'applied and notFound are gone; the transient failure holds back op-d',
    );
    // The ops deadline source fires at the retry time.
    outcomes['op-c'] = 'permanent';
    await w.clock.advance(30_000);
    await w.deadlines.sources.get('ops')!.fire(w.clock.now());
    await until(() => adapter.applied.length === 4, 'the retry');
    await settle();
    assert.deepEqual(
      ops().map(o => [o.op_id, o.state, o.last_error]),
      [
        ['op-c', 'failed', 'permanent'],
        ['op-d', 'queued', null],
      ],
    );
    w.host.opsChanged(ACCOUNT);
    await settle(20);
    assert.equal(
      adapter.applied.length,
      4,
      'a failed op holds back the later ones until Retry or discard',
    );
  } finally {
    await w.kill();
    d.cleanup();
  }
});

test('a secondary device drops backfill, prefetch and enrichment but keeps the workflow round; primary runs them all', async () => {
  const d = disk();
  const once: StepFn = async (s, _st, ctx) => {
    await governed(ctx, s, 5);
    return {
      nextStates: [{ scope: s.scope, generation: 0, updatedAt: 0, phase: 'done' }],
      done: true,
      costUnits: 5,
    };
  };
  const lanes: [string, SyncLane][] = [
    ['history', 'incremental'],
    ['backfill:inbox', 'backfill'],
    ['prefetch', 'prefetch'],
    ['provider:polish', 'enrichment'],
    ['workflow', 'enrichment'],
  ];
  const adapter = new FakeAdapter(
    input =>
      lanes
        .filter(([scope]) => stateIn(input, scope)?.phase !== 'done')
        .map(([scope, lane]) =>
          step(scope as PlannedStep['scope'], lane, 'backfill', input.trigger),
        ),
    { history: once, 'backfill:inbox': once, prefetch: once, 'provider:polish': once },
  );
  const rounds: string[] = [];
  const channel: WorkflowChannel = {
    async round(state, ctx) {
      rounds.push(state.scope);
      await ctx.governor.run(
        { budget: 'gmail', lane: 'enrichment', kind: 'read', method: 'fake.workflow', cost: 2 },
        async () => {},
      );
      return {
        copies: [],
        nextState: { scope: 'workflow', generation: 0, updatedAt: 0, phase: 'done' },
        costUnits: 2,
      };
    },
    put: async () => 'copy-1',
    compact: async () => {},
  };
  adapter.workflow = channel;
  const w = world(d, () => adapter);
  try {
    await w.host.start(ACCOUNT);
    await until(() => rounds.length === 1, 'the workflow round');
    await settle(20);
    assert.deepEqual(
      adapter.calls,
      ['history:'],
      'with a workflow channel the device starts as secondary',
    );
    assert.equal(w.host.status(ACCOUNT)!.lease?.role, 'secondary');
    assert.equal(w.governor.inspect(ACCOUNT, 'gmail').target, gmailBudget.target.secondary);
    // The lease module says this device is primary: the dropped lanes run now, under the primary target.
    w.host.leaseChanged(ACCOUNT, {
      role: 'primary',
      holder: 'device-a',
      until: w.clock.now() + 30 * MINUTE,
    });
    await until(() => adapter.calls.length === 4, 'the background lanes');
    assert.deepEqual(adapter.calls.slice(1).sort(), [
      'backfill:inbox:',
      'prefetch:',
      'provider:polish:',
    ]);
    assert.equal(w.governor.inspect(ACCOUNT, 'gmail').target, gmailBudget.target.primary);
  } finally {
    await w.kill();
    d.cleanup();
  }
});

test('prov-gov-T35 the heartbeat beats every 30 s idle and while waiting on the governor; a stalled adapter goes silent', async () => {
  const d = disk();
  const stall = deferred();
  // Each request runs one scripted step.
  const queue: ('quick' | 'wait' | 'stall')[] = ['quick'];
  const adapter = new FakeAdapter(
    input => (queue.length ? [step('history', 'incremental', 'incremental', input.trigger)] : []),
    {
      history: async (s, _st, ctx) => {
        const mode = queue.shift();
        if (mode === 'stall')
          await stall.promise; // ignores every abort
        else if (mode === 'wait') {
          // Two requests that need more than a minute of budget: the second waits in the governor.
          await ctx.governor.run(
            { budget: 'gmail', lane: 'interactive', kind: 'read', method: 'fake.big', cost: 4_500 },
            async () => {},
          );
          await ctx.governor.run(
            { budget: 'gmail', lane: 'interactive', kind: 'read', method: 'fake.big', cost: 4_500 },
            async () => {},
          );
        } else await governed(ctx, s, 1);
        return {
          nextStates: [{ scope: 'history', generation: 0, updatedAt: 0, cursor: mode }],
          done: true,
          costUnits: 1,
        };
      },
    },
  );
  const w = world(d, () => adapter);
  try {
    await w.host.start(ACCOUNT);
    await until(() => stateOf(w.store, 'history')?.cursor === 'quick', 'the first step');
    await settle();
    for (let i = 0; i < 3; i++) {
      await w.clock.advance(HEARTBEAT_MS);
      assert.equal(w.host.lastHeartbeat(ACCOUNT), w.clock.now(), 'idle');
    }
    queue.push('wait');
    w.host.request(ACCOUNT, { manual: true });
    await until(() => adapter.calls.length === 2, 'the waiting step');
    await settle();
    await w.clock.advance(HEARTBEAT_MS);
    assert.equal(w.host.lastHeartbeat(ACCOUNT), w.clock.now(), 'waiting on the governor');
    await w.clock.advance(MINUTE);
    await until(() => stateOf(w.store, 'history')?.cursor === 'wait', 'the waiting step to finish');
    queue.push('stall');
    w.host.request(ACCOUNT, { manual: true });
    await until(() => adapter.calls.length === 3, 'the stalled step');
    const last = w.host.lastHeartbeat(ACCOUNT)!;
    for (let i = 0; i < 5; i++) await w.clock.advance(HEARTBEAT_MS);
    assert.equal(
      w.host.lastHeartbeat(ACCOUNT),
      last,
      'silent while the adapter hangs, so the supervisor can restart it',
    );
    // The supervisor stops it; the zombie's late reply is discarded, never committed.
    await w.host.stop(ACCOUNT, 'restart');
    assert.equal(adapter.closed, true);
    stall.resolve();
    await settle();
    assert.equal(stateOf(w.store, 'history')?.cursor, 'wait');
  } finally {
    await w.kill();
    d.cleanup();
  }
});

test('a pause on another budget backs the step off until it ends instead of spinning', async () => {
  const d = disk();
  let calls = 0;
  const adapter = new FakeAdapter(
    input => {
      const history = stateIn(input, 'history');
      const notBefore = history ? history.updatedAt + 60_000 : input.env.now;
      return [step('history', 'incremental', 'incremental', input.trigger, notBefore)];
    },
    {
      history: async (s, _state, ctx) => {
        const request = {
          budget: 'gcal',
          lane: s.lane,
          kind: 'read',
          method: 'fake.events',
          cost: 1,
        };
        await ctx.governor.run(request as never, async () => {
          if (++calls === 1) throw refusal('throttle', { provider: 'gcal' });
        });
        return {
          nextStates: [{ scope: 'history', cursor: `c-${calls}`, generation: 0, updatedAt: 0 }],
          done: true,
          costUnits: 1,
        };
      },
    },
  );
  const w = world(d, () => adapter, { budgets: [gmailBudget, gcalBudget] });
  try {
    await w.host.start(ACCOUNT);
    await until(() => calls === 1, 'the refused call');
    await settle(40);
    assert.equal(calls, 1, 'the step is not run again while gcal is paused');
    await w.clock.advance(60_000);
    await until(() => calls === 2, 'the step after the pause');
  } finally {
    await w.kill();
    d.cleanup();
  }
});

test('reconnected refuses a grant without the mail scope: nothing stored, the auth block stays', async () => {
  const d = disk();
  const adapter = poller(() => {});
  const w = world(d, () => adapter);
  try {
    const before = accountRow(w.store);
    await assert.rejects(
      w.host.reconnected(
        ACCOUNT,
        connectResult({
          grantedScopes: ['openid'],
          identity: { subject: 'sub-2', address: ADDRESS },
        }),
      ),
      (e: unknown) => e instanceof ProviderError && e.error.reason === 'missingRequiredScope',
    );
    assert.deepEqual(accountRow(w.store), before);
  } finally {
    await w.kill();
    d.cleanup();
  }
});
