import test from 'node:test';
import assert from 'node:assert/strict';
import { gmailBudget } from '../src/sync/budgets';
import {
  ACCOUNT,
  FakeAdapter,
  FakeClock,
  MINUTE,
  T0,
  disk,
  governed,
  settle,
  world,
} from './sync-actor-helpers';
import {
  remote,
  claimOf,
  channelLog,
  remoteChannel,
  baselineDone,
  pump,
  channelWorld,
  portChannel,
  step,
  fire,
  roles,
} from './sync-lease-rig';

/**
 * The lease's second review (ARCH 6.5): the clock gate, the live role on every actor turn, the primary's compaction,
 * and outside `leaseChanged` calls ignored while a controller runs.
 */

test('the clock gate: a Mac 12 minutes slow publishes a claim that never counts and never takes the lease', async () => {
  const rem = remote();
  const dA = disk();
  const dB = disk();
  const logA = channelLog();
  const logB = channelLog();
  const a = channelWorld(dA, rem, logA, [], { skewMs: -12 * MINUTE });
  const b = channelWorld(dB, rem, logB, [], { clock: a.clock, deviceId: 'device-b' });
  logA.serverNow = logB.serverNow = () => a.clock.now();
  const rolesA = roles(a);
  try {
    await a.host.start(ACCOUNT);
    await b.host.start(ACCOUNT);
    await pump([a, b], 25 * MINUTE);
    assert.ok(!rolesA.includes('primary'), 'the slow Mac is never primary (it has the lower id)');
    assert.equal(b.host.status(ACCOUNT)!.lease?.role, 'primary');
    assert.equal(b.host.status(ACCOUNT)!.lease?.holder, 'device-b');
    const claim = claimOf(rem, 'device-a')!;
    assert.deepEqual([claim.holder, claim.until], [false, 0], 'its claim never counts');
    const lines = a.logs.filter(l => l.event === 'rpc.failed' && l.fields.method === 'lease.clock');
    assert.deepEqual(
      lines.map(l => l.fields.reason),
      ['off'],
      'logged once',
    );
  } finally {
    await a.kill();
    await b.kill();
    dA.cleanup();
    dB.cleanup();
  }
});

test('the clock gate: an offset that could not be measured after a write keeps the device secondary', async () => {
  const d = disk();
  const rem = remote();
  const log = channelLog();
  log.clockOffsetMs = undefined;
  const w = channelWorld(d, rem, log, []);
  const seen = roles(w);
  try {
    await w.host.start(ACCOUNT);
    await pump(w, 5 * MINUTE);
    assert.ok(!seen.includes('primary'));
    assert.equal(claimOf(rem, 'device-a')?.until, 0);
  } finally {
    await w.kill();
    d.cleanup();
  }
});

test('a primary whose claim ran out while the actor slept runs no background step on waking, and status says so', async () => {
  const d = disk();
  const rem = remote();
  const start = T0;
  const calls: string[] = [];
  const adapter = new FakeAdapter(
    input => [step('backfill:inbox', 'backfill', 'backfill', input.trigger, start + 29 * MINUTE)],
    {
      'backfill:inbox': async (s, _state, ctx) => {
        calls.push(s.scope);
        await governed(ctx, s, 1);
        return { nextStates: [], done: true, costUnits: 1 };
      },
    },
  );
  adapter.workflow = portChannel([]);
  const w = world(d, () => adapter, {
    clock: new FakeClock({ start, auto: false }),
    host: { workflowChannel: () => remoteChannel(rem, 'device-a') },
  });
  baselineDone(w);
  try {
    await w.host.start(ACCOUNT);
    await fire(w);
    await fire(w);
    await settle();
    assert.equal(w.host.status(ACCOUNT)!.lease?.role, 'primary');
    // No lease tick fires: the claim's give-up time (28 min) passes while the actor sleeps until its step (29 min).
    await w.clock.advance(29 * MINUTE + 1_000);
    await settle(20);
    assert.deepEqual(calls, [], 'no backfill on an expired primary role');
    assert.equal(w.host.status(ACCOUNT)!.lease?.role, 'secondary');
    assert.equal(w.governor.inspect(ACCOUNT, 'gmail').target, gmailBudget.target.secondary);
  } finally {
    await w.kill();
    d.cleanup();
  }
});

test('the primary compacts after its renewals; a secondary and the quit-time dead claim never do', async () => {
  const rem = remote();
  const dA = disk();
  const dB = disk();
  const logA = channelLog();
  const logB = channelLog();
  const a = channelWorld(dA, rem, logA, []);
  const b = channelWorld(dB, rem, logB, [], { clock: a.clock, deviceId: 'device-b' });
  try {
    await a.host.start(ACCOUNT);
    await b.host.start(ACCOUNT);
    await pump([a, b], 25 * MINUTE);
    assert.equal(a.host.status(ACCOUNT)!.lease?.role, 'primary');
    assert.ok(logA.compacts >= 2, `the primary compacted after its renewals (${logA.compacts})`);
    assert.equal(logB.compacts, 0, 'a secondary never compacts');
    const compacts = logA.compacts;
    await a.host.stop(ACCOUNT, 'quit');
    assert.equal(claimOf(rem, 'device-a')?.until, 0);
    assert.equal(logA.compacts, compacts, 'the dead claim does not compact');
  } finally {
    await a.kill();
    await b.kill();
    dA.cleanup();
    dB.cleanup();
  }
});

test('leaseChanged from outside is ignored while the account has a lease controller', async () => {
  const d = disk();
  const rem = remote();
  const w = channelWorld(d, rem, channelLog(), []);
  try {
    await w.host.start(ACCOUNT);
    w.host.leaseChanged(ACCOUNT, { role: 'primary', holder: 'device-a', until: w.now() + MINUTE });
    assert.equal(w.host.status(ACCOUNT)!.lease?.role, 'secondary');
    assert.equal(w.governor.inspect(ACCOUNT, 'gmail').target, gmailBudget.target.secondary);
  } finally {
    await w.kill();
    d.cleanup();
  }
});
