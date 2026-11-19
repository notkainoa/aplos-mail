import test from 'node:test';
import assert from 'node:assert/strict';
import { PausedError, type SyncState } from '../src/ports';
import { ProviderError } from '../src/ports/base';
import { gmailBudget } from '../src/sync/budgets';
import { LEASE_SKEW_MS, LEASE_TTL_MS, type LeaseClaim } from '../src/sync/lease';
import { LEASE_STOP_WAIT_MS, type HostWorkflowChannel } from '../src/sync/host';
import {
  ACCOUNT,
  FakeAdapter,
  MINUTE,
  deferred,
  disk,
  governed,
  settle,
  stateOf,
  until,
  world,
} from './sync-actor-helpers';
import {
  remote,
  claimOf,
  channelLog,
  remoteChannel,
  baselineDone,
  pump,
  workflowStep,
  channelWorld,
  portChannel,
  step,
  fire,
} from './sync-lease-rig';

/**
 * The actor host's lease wiring (ARCH 6.5, plan 20 PV3): `createLeaseController` on the account's workflow channel,
 * its `tick()` on the `lease:<account>` deadline, claims and the pin through `claimLease`/`releaseLease`, the dead
 * claim a quit or disconnect publishes, and the workflow-round rules the actor applies to it.
 */

test('the lease rides the channel: a candidacy promotes the only device, claim pins it, release keeps it by hysteresis', async () => {
  const d = disk();
  const rem = remote();
  const adapter = new FakeAdapter(() => [], {});
  adapter.workflow = portChannel([]);
  const w = world(d, () => adapter, {
    host: { workflowChannel: () => remoteChannel(rem, 'device-a') },
  });
  baselineDone(w);
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
  baselineDone(a);
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
  baselineDone(b);
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
  baselineDone(a);
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

test('every channel read reports its merge and the whole view to onWorkflowMerged', async () => {
  const d = disk();
  const rem = remote();
  const merged: { changed: string[]; view: string[] }[] = [];
  rem.records.set('thread:t-1', {
    key: 'thread:t-1',
    stamp: { at: 1, gen: 0, device: 'device-x' },
    value: { status: 'done' },
  });
  const adapter = new FakeAdapter(() => [], {});
  adapter.workflow = portChannel([]);
  const w = world(d, () => adapter, {
    host: {
      workflowChannel: () => remoteChannel(rem, 'device-a'),
      onWorkflowMerged: (_account, changed, view) =>
        merged.push({ changed: changed.map(r => r.key), view: view.map(r => r.key) }),
    },
  });
  baselineDone(w);
  try {
    await w.host.start(ACCOUNT);
    await fire(w);
    await settle();
    assert.ok(merged[0].changed.includes('thread:t-1'), 'the first read merged the seeded record');
    // A read that moved nothing still reports, with the view a subscriber retries deferred records from.
    await w.clock.advance(MINUTE);
    await fire(w);
    await settle();
    const last = merged.at(-1)!;
    assert.ok(!last.changed.includes('thread:t-1'));
    assert.ok(last.view.includes('thread:t-1'));
  } finally {
    await w.kill();
    d.cleanup();
  }
});

test("without a channel, a secondary's workflow round waits until the holder's claim is gone by the lease's own rule", async () => {
  const d = disk();
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
  const w = world(d, () => adapter);
  try {
    // A live holder elsewhere: the workflow round is the primary's job.
    const holderUntil = w.clock.now() + 30 * MINUTE;
    w.host.leaseChanged(ACCOUNT, { role: 'secondary', holder: 'device-b', until: holderUntil });
    await w.host.start(ACCOUNT);
    await until(() => adapter.calls.length === 1, 'the history step');
    await settle(20);
    assert.equal(rounds.length, 0, 'no workflow round while another device holds the lease');
    // Past `until` but inside the skew margin, lease.ts still honours the claim: so does the actor.
    await w.clock.advance(30 * MINUTE + MINUTE);
    await settle(20);
    assert.equal(rounds.length, 0, 'the claim still counts until until + LEASE_SKEW_MS');
    await w.clock.advance(holderUntil + LEASE_SKEW_MS - w.clock.now() + MINUTE);
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

test('without a channel, a PausedError from the round holds the scope until it ends, with no retry while paused', async () => {
  const d = disk();
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
  const w = world(d, () => adapter);
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

test('one channel reader: over 10 idle minutes the primary reads the channel at most once a minute, the actor never', async () => {
  const d = disk();
  const rem = remote();
  const log = channelLog();
  const rounds: string[] = [];
  const w = channelWorld(d, rem, log, rounds);
  try {
    await w.host.start(ACCOUNT);
    await pump(w, 2 * MINUTE);
    assert.equal(w.host.status(ACCOUNT)!.lease?.role, 'primary');
    const before = log.reads + rounds.length;
    await pump(w, 10 * MINUTE);
    const total = log.reads + rounds.length - before;
    assert.ok(total <= 10, `${total} channel reads in 10 idle minutes`);
    assert.ok(total >= 9, 'the lease round still reads every minute');
    assert.equal(rounds.length, 0, "the actor's planned workflow step never reads the channel");
  } finally {
    await w.kill();
    d.cleanup();
  }
});

test('the lease round waits for the baseline sync, then reads alone', async () => {
  const d = disk();
  const rem = remote();
  const log = channelLog();
  const rounds: string[] = [];
  const gate = deferred();
  const adapter = new FakeAdapter(
    input => {
      const steps = [workflowStep(input)];
      if (!input.states.some(s => s.scope === 'window:inbox'))
        steps.push(step('window:inbox', 'incremental', 'baseline', input.trigger));
      return steps;
    },
    {
      'window:inbox': async (s, _state, ctx) => {
        await gate.promise;
        await governed(ctx, s, 1);
        return {
          nextStates: [{ scope: 'window:inbox', generation: 0, updatedAt: 0 }],
          done: true,
          costUnits: 1,
          baselineReached: true,
        };
      },
    },
  );
  adapter.workflow = portChannel(rounds);
  const w = world(d, () => adapter, {
    host: { workflowChannel: () => remoteChannel(rem, 'device-a', log) },
  });
  try {
    await w.host.start(ACCOUNT);
    await until(() => adapter.calls.length === 1, 'the baseline step');
    const source = w.deadlines.sources.get(`lease:${ACCOUNT}`)!;
    assert.equal(await source.next(), undefined, 'no lease deadline during the baseline');
    await fire(w);
    await settle();
    assert.equal(log.reads + rounds.length, 0, 'no channel read during the baseline');
    const changes = w.deadlines.changes.length;
    gate.resolve();
    await until(() => w.host.status(ACCOUNT)?.baselineDoneAt !== undefined, 'the baseline');
    await settle();
    assert.ok(
      w.deadlines.changes.slice(changes).includes(`lease:${ACCOUNT}`),
      'the baseline pokes the held lease deadline',
    );
    await pump(w, 2 * MINUTE);
    assert.ok(log.reads >= 1);
    assert.equal(log.maxInFlight, 1, 'never two channel reads at once');
    assert.equal(rounds.length, 0);
    assert.equal(w.host.status(ACCOUNT)!.lease?.role, 'primary');
  } finally {
    await w.kill();
    d.cleanup();
  }
});

test('the workflow cursor has one writer and is committed only when it moved', async () => {
  const d = disk();
  const rem = remote();
  const log = channelLog();
  const rounds: string[] = [];
  const base = remoteChannel(rem, 'device-a', log);
  const script: Partial<SyncState>[] = [
    { cursor: 'c1', pending: ['p1'] },
    { cursor: 'c1', pending: ['p1'] },
  ];
  const channel: HostWorkflowChannel = {
    ...base,
    async read(state, ctx) {
      const read = await base.read(state, ctx);
      const next = script.shift() ?? { cursor: 'c1' };
      return {
        ...read,
        nextState: {
          scope: 'workflow',
          generation: ctx.generation,
          updatedAt: ctx.clock.now(),
          ...next,
        },
      };
    },
  };
  const w = world(
    d,
    () => {
      const adapter = new FakeAdapter(input => [workflowStep(input)], {});
      adapter.workflow = portChannel(rounds);
      return adapter;
    },
    { host: { workflowChannel: () => channel } },
  );
  baselineDone(w);
  const commits: string[] = [];
  const commit = w.store.commit.bind(w.store);
  w.store.commit = input => {
    for (const write of input.writes)
      if (write.kind === 'syncState' && write.scope === 'workflow')
        commits.push(`${write.cursor}:${(write.pending ?? []).join(',')}`);
    return commit(input);
  };
  try {
    await w.host.start(ACCOUNT);
    await pump(w, 6 * MINUTE);
    assert.ok(log.reads >= 5);
    assert.deepEqual(
      commits,
      ['c1:p1', 'c1:'],
      'one commit per cursor change, none for idle reads',
    );
    assert.deepEqual(log.states[1].pending, ['p1'], 'each read resumes on the last one');
    assert.equal(rounds.length, 0, 'the actor never writes the row');
    assert.equal(stateOf(w.store, 'workflow')?.cursor, 'c1');
  } finally {
    await w.kill();
    d.cleanup();
  }
});

test('"Use this Mac" before start is queued: secondary until the own claim reads back; a release while stopped reaches the channel', async () => {
  const d = disk();
  const rem = remote();
  const log = channelLog();
  const w = channelWorld(d, rem, log, []);
  try {
    await w.host.claimLease(ACCOUNT);
    assert.equal(log.writes, 0, 'nothing written before start');
    await w.host.start(ACCOUNT);
    assert.equal(w.host.status(ACCOUNT)!.lease?.role, 'secondary', 'no primary before a read');
    assert.equal(w.governor.inspect(ACCOUNT, 'gmail').target, gmailBudget.target.secondary);
    await fire(w);
    await settle();
    assert.equal(claimOf(rem, 'device-a')?.pinned, true, 'the queued pin published');
    assert.equal(w.host.status(ACCOUNT)!.lease?.role, 'primary');
    assert.equal(w.host.status(ACCOUNT)!.lease?.pinned, true);

    await w.host.stop(ACCOUNT, 'restart');
    await w.host.releaseLease(ACCOUNT);
    assert.equal(claimOf(rem, 'device-a')?.pinned, true, 'nothing written while stopped');
    await w.host.start(ACCOUNT);
    await fire(w);
    await settle();
    assert.equal(claimOf(rem, 'device-a')?.pinned, false, 'the queued release reached the channel');
    assert.equal(w.host.status(ACCOUNT)!.lease?.pinned, false);
  } finally {
    await w.kill();
    d.cleanup();
  }
});

test('the restart seed is used once: a quit and a later start do not bring back a stale primary', async () => {
  const d = disk();
  const rem = remote();
  const log = channelLog();
  const w = channelWorld(d, rem, log, []);
  try {
    await w.host.start(ACCOUNT);
    await fire(w);
    await fire(w);
    await settle();
    assert.equal(w.host.status(ACCOUNT)!.lease?.role, 'primary');
    await w.host.stop(ACCOUNT, 'restart');
    await w.host.start(ACCOUNT);
    await w.host.stop(ACCOUNT, 'quit');
    assert.equal(claimOf(rem, 'device-a')?.until, 0, 'the quit retired the claim');
    const writes = log.writes;
    await w.host.start(ACCOUNT);
    assert.equal(w.host.status(ACCOUNT)!.lease?.role, 'secondary');
    await w.host.stop(ACCOUNT, 'quit');
    assert.equal(log.writes, writes, 'a controller that never held a claim publishes nothing');
  } finally {
    await w.kill();
    d.cleanup();
  }
});

test('channel failures are logged once per reason; a quit waits for the dead claim at most LEASE_STOP_WAIT_MS', async () => {
  const d = disk();
  const rem = remote();
  const channel = remoteChannel(rem, 'device-a');
  const adapter = new FakeAdapter(() => [], {});
  adapter.workflow = portChannel([]);
  const v = world(d, () => adapter, { host: { workflowChannel: () => channel } });
  baselineDone(v);
  const lines = (method: string) =>
    v.logs.filter(l => l.event === 'rpc.failed' && l.fields.method === method);
  try {
    await v.host.start(ACCOUNT);
    await fire(v);
    await fire(v);
    await settle();
    assert.equal(v.host.status(ACCOUNT)!.lease?.role, 'primary');
    const read = channel.read;
    channel.read = async () => {
      throw new ProviderError({
        class: 'transient',
        provider: 'gmail',
        method: 'gmail.history.list',
        reason: 'backendError',
      });
    };
    for (let i = 0; i < 3; i++) {
      await v.clock.advance(MINUTE);
      await fire(v);
    }
    assert.deepEqual(
      lines('lease.read').map(l => l.fields.reason),
      ['backendError'],
      'three failed reads, one line',
    );
    channel.read = read;
    channel.write = () => new Promise(() => {});
    let stopped = false;
    void v.host.stop(ACCOUNT, 'quit').then(() => {
      stopped = true;
    });
    await settle();
    assert.equal(stopped, false, 'the quit waits for the dead claim');
    await v.clock.advance(LEASE_STOP_WAIT_MS);
    await settle();
    assert.equal(stopped, true, 'but not longer than LEASE_STOP_WAIT_MS');
    assert.deepEqual(
      lines('lease.stop').map(l => l.fields.reason),
      ['timeout'],
    );
  } finally {
    await v.kill();
    d.cleanup();
  }
});
