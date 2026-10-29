import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PausedError,
  type PlannedStep,
  type SyncLane,
  type WorkflowChannel,
  type WorkflowCopy,
} from '../src/ports';
import { gmailBudget } from '../src/sync/budgets';
import { LEASE_TTL_MS, type LeaseClaim, type LeaseRecord } from '../src/sync/lease';
import type { HostWorkflowChannel } from '../src/sync/host';
import {
  ACCOUNT,
  FakeAdapter,
  MINUTE,
  disk,
  governed,
  settle,
  stateOf,
  until,
  world,
} from './sync-actor-helpers';

/**
 * The actor host's lease wiring (ARCH 6.5, plan 20 PV3): `createLeaseController` on the account's workflow channel,
 * its `tick()` on the `lease:<account>` deadline, claims and the pin through `claimLease`/`releaseLease`, the dead
 * claim a quit or disconnect publishes, and the workflow-round rules the actor applies to it.
 */

/** The "mailbox" two devices' channels share: the merged workflow records, latest write per key. */
interface Remote {
  records: Map<string, LeaseRecord>;
  gen: number;
}

const remote = (): Remote => ({ records: new Map(), gen: 0 });

const byKey = (a: LeaseRecord, b: LeaseRecord) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
const stampOf = (r: LeaseRecord) => `${r.stamp.at}:${r.stamp.gen}`;
const claimOf = (remote: Remote, device: string) =>
  remote.records.get(`lease:${device}`)?.value as LeaseClaim | undefined;

/**
 * A fake `WorkflowStateChannel` over the shared remote, stamped as `device`: `read` is one round (the whole view
 * plus the records this channel last reported as changed), `write` stamps and stores the entries, `ingest` takes
 * copies whose `data` is a JSON list of records.
 */
function remoteChannel(remote: Remote, device: string): HostWorkflowChannel {
  const seen = new Map<string, string>();
  return {
    async read(_state, ctx) {
      const records = [...remote.records.values()].sort(byKey);
      const changed = records.filter(r => seen.get(r.key) !== stampOf(r));
      for (const r of records) seen.set(r.key, stampOf(r));
      return {
        records,
        changed,
        nextState: {
          scope: 'workflow',
          cursor: `wf-${ctx.generation}`,
          generation: ctx.generation,
          updatedAt: ctx.clock.now(),
        },
        costUnits: 2,
      };
    },
    async write(entries, ctx) {
      for (const e of entries) {
        remote.records.set(e.key, {
          key: e.key,
          stamp: { at: ctx.clock.now(), gen: ++remote.gen, device },
          value: e.value,
        });
      }
      return { remoteId: `copy-${remote.gen}` };
    },
    async ingest(copies) {
      const changed: LeaseRecord[] = [];
      for (const copy of copies) {
        for (const record of JSON.parse(copy.data) as LeaseRecord[]) {
          remote.records.set(record.key, record);
          changed.push(record);
        }
      }
      return { changed };
    },
  };
}

/** The port's `WorkflowChannel` (the adapter's transport); `round` is governed and counts its calls. */
function portChannel(rounds: string[], copies: () => WorkflowCopy[] = () => []): WorkflowChannel {
  return {
    async round(state, ctx) {
      await ctx.governor.run(
        { budget: 'gmail', lane: 'enrichment', kind: 'read', method: 'fake.workflow', cost: 2 },
        async () => {},
      );
      rounds.push(state.scope);
      return {
        copies: copies(),
        nextState: {
          scope: 'workflow',
          generation: ctx.generation,
          updatedAt: ctx.clock.now(),
        },
        costUnits: 2,
      };
    },
    put: async () => 'copy-1',
    compact: async () => {},
  };
}

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

const fire = (w: ReturnType<typeof world>, id = `lease:${ACCOUNT}`) =>
  w.deadlines.sources.get(id)!.fire(w.clock.now());

test('the lease rides the channel: a candidacy promotes the only device, claim pins it, release keeps it by hysteresis', async () => {
  const d = disk();
  const rem = remote();
  const adapter = new FakeAdapter(() => [], {});
  adapter.workflow = portChannel([]);
  const w = world(d, () => adapter, {
    host: { workflowChannel: () => remoteChannel(rem, 'device-a') },
  });
  try {
    await w.host.start(ACCOUNT);
    assert.ok(w.deadlines.sources.has(`lease:${ACCOUNT}`), 'the lease deadline source registered');
    // Round 1 publishes a candidacy; the immediate re-read (round 2) renews it as the holder.
    await fire(w);
    await fire(w);
    await settle();
    const record = rem.records.get('lease:device-a')!;
    const claim = record.value as LeaseClaim;
    assert.equal(claim.v, 1);
    assert.equal(claim.holder, true);
    assert.equal(claim.until, record.stamp.at + LEASE_TTL_MS);
    assert.equal(w.host.status(ACCOUNT)!.lease?.role, 'primary');
    assert.equal(w.host.status(ACCOUNT)!.lease?.holder, 'device-a');
    // The read committed the round's nextState as the `workflow` scope row, the same write a step makes.
    assert.match(stateOf(w.store, 'workflow')!.cursor ?? '', /^wf-/);
    // "Use this Mac": the pin rides the same record.
    await w.host.claimLease(ACCOUNT);
    assert.equal(claimOf(rem, 'device-a')!.pinned, true);
    assert.ok(w.deadlines.changes.includes(`lease:${ACCOUNT}`));
    assert.equal(w.host.status(ACCOUNT)!.lease?.pinned, true);
    await w.host.releaseLease(ACCOUNT);
    const unpinned = claimOf(rem, 'device-a')!;
    assert.equal(unpinned.pinned, false);
    assert.equal(unpinned.holder, true, 'a released pin keeps the lease by hysteresis');
    assert.equal(w.host.status(ACCOUNT)!.lease?.role, 'primary');
  } finally {
    await w.kill();
    d.cleanup();
  }
});

test('a second device reads the pinned claim, stays secondary under its target, and still runs no primary lanes', async () => {
  const rem = remote();
  const dA = disk();
  const a = world(
    dA,
    () => {
      const adapter = new FakeAdapter(() => [], {});
      adapter.workflow = portChannel([]);
      return adapter;
    },
    { host: { workflowChannel: () => remoteChannel(rem, 'device-a') } },
  );
  const dB = disk();
  const b = world(
    dB,
    () => {
      const adapter = new FakeAdapter(() => [], {});
      adapter.workflow = portChannel([]);
      return adapter;
    },
    {
      clock: a.clock,
      deviceId: 'device-b',
      host: { workflowChannel: () => remoteChannel(rem, 'device-b') },
    },
  );
  try {
    await a.host.start(ACCOUNT);
    await b.host.start(ACCOUNT);
    await a.host.claimLease(ACCOUNT);
    await settle();
    // B's round sees A's live pinned claim: it reports secondary, under the secondary governor target.
    await fire(b);
    await fire(b);
    await settle();
    const lease = b.host.status(ACCOUNT)!.lease;
    assert.equal(lease?.role, 'secondary');
    assert.equal(lease?.holder, 'device-a');
    assert.equal(claimOf(rem, 'device-b')!.holder, false, 'B published only a candidacy');
    assert.equal(b.governor.inspect(ACCOUNT, 'gmail').target, gmailBudget.target.secondary);
    assert.equal(a.governor.inspect(ACCOUNT, 'gmail').target, gmailBudget.target.primary);
  } finally {
    await a.kill();
    await b.kill();
    dA.cleanup();
    dB.cleanup();
  }
});

test('a quit or disconnect publishes the dead claim; a restart keeps it and the next controller picks it up', async () => {
  const rem = remote();
  const dA = disk();
  const a = world(
    dA,
    () => {
      const adapter = new FakeAdapter(() => [], {});
      adapter.workflow = portChannel([]);
      return adapter;
    },
    { host: { workflowChannel: () => remoteChannel(rem, 'device-a') } },
  );
  try {
    await a.host.start(ACCOUNT);
    await fire(a);
    await fire(a);
    await settle();
    assert.equal(a.host.status(ACCOUNT)!.lease?.role, 'primary');

    // A restart: the claim stays published and live, the deadline and controller go away.
    await a.host.stop(ACCOUNT, 'restart');
    assert.ok(
      !a.deadlines.sources.has(`lease:${ACCOUNT}`),
      'lease deadline unregistered on restart',
    );
    const claim = claimOf(rem, 'device-a')!;
    assert.equal(claim.holder, true);
    assert.ok(claim.until > a.clock.now(), 'the published claim survives the restart');

    // The restarted actor gets a fresh controller on the same channel; its read sees the live claim.
    await a.host.start(ACCOUNT);
    assert.ok(a.deadlines.sources.has(`lease:${ACCOUNT}`), 'lease deadline registered again');
    await fire(a);
    await settle();
    assert.equal(a.host.status(ACCOUNT)!.lease?.role, 'primary');

    // A quit publishes the expired claim instead: the lease is free at the next read.
    await a.host.stop(ACCOUNT, 'quit');
    assert.ok(!a.deadlines.sources.has(`lease:${ACCOUNT}`));
    const dead = claimOf(rem, 'device-a')!;
    assert.equal(dead.holder, false);
    assert.equal(dead.until, 0, 'the expired claim frees the lease');
    assert.equal(a.host.status(ACCOUNT), undefined);
  } finally {
    await a.kill();
    dA.cleanup();
  }
});

test('an adapter with a workflow port but no channel keeps the local claim and release', async () => {
  const d = disk();
  const adapter = new FakeAdapter(() => [], {});
  adapter.workflow = portChannel([]);
  const w = world(d, () => adapter);
  try {
    await w.host.start(ACCOUNT);
    assert.ok(!w.deadlines.sources.has(`lease:${ACCOUNT}`), 'no lease deadline without a channel');
    assert.equal(w.host.status(ACCOUNT)!.lease?.role, 'secondary');
    await w.host.claimLease(ACCOUNT);
    assert.equal(w.host.status(ACCOUNT)!.lease?.role, 'primary');
    assert.equal(w.host.status(ACCOUNT)!.lease?.pinned, true);
    const row = w.store.read(q =>
      q.get<{ d: string | null }>(
        'SELECT primary_lease_device AS d FROM accounts WHERE id = ?',
        ACCOUNT,
      ),
    );
    assert.equal(row?.d, 'device-a', 'the local claim lands on the account row as before');
    await w.host.releaseLease(ACCOUNT);
    assert.equal(w.host.status(ACCOUNT)!.lease?.pinned, false);
    assert.equal(w.host.status(ACCOUNT)!.lease?.role, 'primary');
  } finally {
    await w.kill();
    d.cleanup();
  }
});

test('merged records reach onWorkflowMerged — from the lease read and from a round ingesting copies', async () => {
  const d = disk();
  const rem = remote();
  const merged: LeaseRecord[][] = [];
  const delivered: WorkflowCopy[][] = [];
  rem.records.set('thread:t-1', {
    key: 'thread:t-1',
    stamp: { at: 1, gen: 0, device: 'device-x' },
    value: { status: 'done' },
  });
  const rounds: string[] = [];
  const adapter = new FakeAdapter(
    input =>
      rounds.length === 0 ? [step('workflow', 'enrichment', 'workflow', input.trigger)] : [],
    {},
  );
  adapter.workflow = portChannel(rounds, () => [
    {
      deviceId: 'device-x',
      writtenAt: 2,
      data: JSON.stringify([
        {
          key: 'thread:t-2',
          stamp: { at: 2, gen: 0, device: 'device-x' },
          value: { status: 'snoozed' },
        },
      ]),
    },
  ]);
  const w = world(d, () => adapter, {
    host: {
      workflowChannel: () => remoteChannel(rem, 'device-a'),
      onWorkflowMerged: (_account, changed) => merged.push([...changed]),
      onWorkflowCopies: (_account, copies) => delivered.push(copies),
    },
  });
  try {
    await w.host.start(ACCOUNT);
    // The lease's first read reports the seeded record as changed.
    await fire(w);
    await settle();
    assert.ok(
      merged.flat().some(r => r.key === 'thread:t-1'),
      'the lease read merged the seeded record',
    );
    // The actor's workflow round delivers its copies to the channel's ingest and to the subscriber.
    await until(() => rounds.length === 1, 'the workflow round');
    await until(() => merged.flat().some(r => r.key === 'thread:t-2'), 'the round copies merged');
    assert.ok(delivered.length >= 1, 'the round copies were delivered to the subscriber');
    assert.equal(delivered[0][0].deviceId, 'device-x');
  } finally {
    await w.kill();
    d.cleanup();
  }
});

test('a secondary that sees a live holder runs no workflow round; once it ends the round runs and charges', async () => {
  const d = disk();
  const rem = remote();
  const rounds: string[] = [];
  const adapter = new FakeAdapter(
    input => {
      const history = input.states.find(s => s.scope === 'history');
      const immediate = input.trigger !== 'poll' || !history;
      const steps = [
        step(
          'history',
          'incremental',
          'incremental',
          input.trigger,
          immediate ? input.env.now : history!.updatedAt + MINUTE,
        ),
      ];
      if (rounds.length === 0)
        steps.push(step('workflow', 'enrichment', 'workflow', input.trigger));
      return steps;
    },
    {
      history: async (s, _state, ctx) => {
        await governed(ctx, s, 2);
        return {
          nextStates: [{ scope: 'history', cursor: 'h-1', generation: 0, updatedAt: 0 }],
          done: true,
          costUnits: 2,
        };
      },
    },
  );
  adapter.workflow = portChannel(rounds);
  const w = world(d, () => adapter, {
    host: { workflowChannel: () => remoteChannel(rem, 'device-a') },
  });
  try {
    // A live holder elsewhere: the workflow round is the primary's job.
    w.host.leaseChanged(ACCOUNT, {
      role: 'secondary',
      holder: 'device-b',
      until: w.clock.now() + 30 * MINUTE,
    });
    await w.host.start(ACCOUNT);
    await until(() => adapter.calls.length === 1, 'the history step');
    await settle(20);
    assert.equal(rounds.length, 0, 'no workflow round while another device holds the lease');
    // The claim runs out: this device may run the round itself (and win the lease on it).
    await w.clock.advance(30 * MINUTE);
    await until(() => rounds.length === 1, 'the workflow round after the claim ended');
    assert.ok(
      w.governor.inspect(ACCOUNT, 'gmail').used >= 2,
      'the round charged through the governor',
    );
  } finally {
    await w.kill();
    d.cleanup();
  }
});

test('a PausedError from the round holds the scope until it ends, with no retry while paused', async () => {
  const d = disk();
  const rem = remote();
  const attempts: number[] = [];
  const adapter = new FakeAdapter(
    input =>
      attempts.length < 2 ? [step('workflow', 'enrichment', 'workflow', input.trigger)] : [],
    {},
  );
  let pauseEnd = 0;
  adapter.workflow = {
    async round(_state, ctx) {
      const now = ctx.clock.now();
      attempts.push(now);
      if (pauseEnd === 0) pauseEnd = now + 5 * MINUTE;
      if (now < pauseEnd) {
        throw new PausedError(ACCOUNT, 'gmail', 'throttle', 'rateLimitExceeded', pauseEnd);
      }
      return {
        copies: [],
        nextState: {
          scope: 'workflow',
          generation: ctx.generation,
          updatedAt: now,
        },
        costUnits: 2,
      };
    },
    put: async () => 'x',
    compact: async () => {},
  };
  const w = world(d, () => adapter, {
    host: { workflowChannel: () => remoteChannel(rem, 'device-a') },
  });
  try {
    await w.host.start(ACCOUNT);
    await until(() => attempts.length === 1, 'the first (refused) round');
    await settle(20);
    assert.equal(attempts.length, 1, 'no retry while the hold stands');
    await w.clock.advance(5 * MINUTE + 1);
    await until(() => attempts.length === 2, 'the round once the hold ended');
    assert.ok(attempts[1] >= attempts[0] + 5 * MINUTE);
  } finally {
    await w.kill();
    d.cleanup();
  }
});
