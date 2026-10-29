import test from 'node:test';
import assert from 'node:assert/strict';
import { ContractError } from '@aplos/contract/contract-error';
import { clockReading, LEASE_CLOCK_MAX_MS, LEASE_CLOCK_SPAN_MS } from '../src/sync/lease';
import { ACCOUNT, MINUTE, disk, settle } from './sync-actor-helpers';
import { channelLog, channelWorld, claimOf, pump, remote, roles } from './sync-lease-rig';

/**
 * The lease's binding review (ARCH 6.5): the clock gate refuses "Use this Mac" and drops a stale pin, a blocked device
 * rewrites rarely and compacts its own copies, the offset is a bracket, a quit never waits on a compaction, and a
 * fresh process measures before it acts as primary.
 */

type World = ReturnType<typeof channelWorld>;

/** Fires the world's lease source when due without waiting for it, so a round stuck in a compaction cannot hang. */
async function drive(w: World, ms: number, until?: () => boolean): Promise<void> {
  const end = w.clock.now() + ms;
  let busy: Promise<void> | undefined;
  while (w.clock.now() < end && !until?.()) {
    await w.clock.advance(1_000);
    await settle(2);
    const source = w.deadlines.sources.get(`lease:${ACCOUNT}`);
    const next = await source?.next();
    if (!busy && source && next !== undefined && next <= w.now())
      busy = source.fire(w.now()).finally(() => (busy = undefined));
  }
}

/** Advances the clock a second at a time until `promise` settles (at most `ms`). */
async function settleWithin<T>(w: World, promise: Promise<T>, ms: number): Promise<T> {
  let done = false;
  const tracked = promise.finally(() => (done = true));
  tracked.catch(() => {});
  const end = w.clock.now() + ms;
  while (!done && w.clock.now() < end) {
    await w.clock.advance(1_000);
    await settle(2);
  }
  return tracked;
}

test('clockReading: ok only when the whole bracket is within the limit and the bracket is tight', () => {
  const max = LEASE_CLOCK_MAX_MS;
  assert.equal(clockReading({ lowMs: -1_000, highMs: 1_000 }), 'ok');
  assert.equal(clockReading({ lowMs: max - 10_000, highMs: max + 10_000 }), 'off', 'one end out');
  assert.equal(clockReading({ lowMs: -max - 1, highMs: -max + 5_000 }), 'off');
  assert.equal(clockReading({ lowMs: 0, highMs: LEASE_CLOCK_SPAN_MS + 1 }), 'unmeasurable');
  assert.equal(clockReading({ lowMs: 10, highMs: 0 }), 'unmeasurable', 'a bracket upside down');
  assert.equal(clockReading(undefined), 'unmeasurable');
});

test('"Use this Mac" is refused while the gate blocks: no pin is published or reported', async () => {
  const d = disk();
  const rem = remote();
  const log = channelLog();
  const a = channelWorld(d, rem, log, [], { skewMs: -12 * MINUTE });
  log.serverNow = () => a.clock.now();
  try {
    await a.host.start(ACCOUNT);
    await pump(a, 3 * MINUTE);
    assert.equal(claimOf(rem, 'device-a')?.until, 0, 'blocked');
    await assert.rejects(
      a.host.claimLease(ACCOUNT),
      (error: unknown) => error instanceof ContractError && /clock is off/.test(error.message),
    );
    assert.equal(claimOf(rem, 'device-a')?.pinned, false);
    assert.equal(claimOf(rem, 'device-a')?.pinnedAt, 0);
    assert.notEqual(a.host.status(ACCOUNT)!.lease?.pinned, true);
  } finally {
    await a.kill();
    d.cleanup();
  }
});

test('a pin is dropped when the gate starts blocking, so it cannot win once the clock is fixed', async () => {
  const rem = remote();
  const dA = disk();
  const dB = disk();
  const logA = channelLog();
  const logB = channelLog();
  const a = channelWorld(dA, rem, logA, []);
  const b = channelWorld(dB, rem, logB, [], { clock: a.clock, deviceId: 'device-b' });
  try {
    await b.host.start(ACCOUNT);
    await pump(b, 3 * MINUTE);
    await a.host.start(ACCOUNT);
    await pump([a, b], 2 * MINUTE);
    await a.host.claimLease(ACCOUNT);
    await pump([a, b], 2 * MINUTE);
    assert.equal(a.host.status(ACCOUNT)!.lease?.role, 'primary', 'the pin won');
    // Mac A's clock now runs 12 minutes fast: its next renewal measures that and the pin goes.
    logA.serverNow = () => a.clock.now() - 12 * MINUTE;
    await pump([a, b], 15 * MINUTE);
    assert.deepEqual(
      [claimOf(rem, 'device-a')?.pinned, claimOf(rem, 'device-a')?.pinnedAt],
      [false, 0],
    );
    assert.equal(a.host.status(ACCOUNT)!.lease?.pinned, false);
    assert.equal(b.host.status(ACCOUNT)!.lease?.role, 'primary');
    // The clock is fixed: A measures again within the blocked cadence, and B keeps the lease (no stale pin wins).
    logA.serverNow = () => a.clock.now();
    await pump([a, b], 40 * MINUTE);
    assert.ok(claimOf(rem, 'device-a')!.until > 0, 'A counts again');
    assert.equal(b.host.status(ACCOUNT)!.lease?.role, 'primary');
    assert.equal(a.host.status(ACCOUNT)!.lease?.holder, 'device-b');
  } finally {
    await a.kill();
    await b.kill();
    dA.cleanup();
    dB.cleanup();
  }
});

test('a Mac 45 minutes fast rewrites its dead claim twice an hour and compacts only its own copies', async () => {
  const d = disk();
  const rem = remote();
  const log = channelLog();
  const a = channelWorld(d, rem, log, [], { skewMs: 45 * MINUTE });
  log.serverNow = () => a.clock.now();
  const seen = roles(a);
  try {
    await a.host.start(ACCOUNT);
    await pump(a, 2 * MINUTE);
    const writes = log.writes;
    await pump(a, 60 * MINUTE);
    assert.ok(!seen.includes('primary'));
    assert.ok(log.writes - writes <= 2, `${log.writes - writes} writes in an idle hour`);
    assert.ok(log.ownCompacts >= 2, `its own copies compacted (${log.ownCompacts})`);
    assert.equal(log.compacts, 0, 'never a full compaction');
  } finally {
    await a.kill();
    d.cleanup();
  }
});

test('a quit during a compaction still publishes the dead claim within the stop wait', async () => {
  const d = disk();
  const rem = remote();
  const log = channelLog();
  const a = channelWorld(d, rem, log, []);
  try {
    await a.host.start(ACCOUNT);
    await pump(a, 3 * MINUTE);
    assert.equal(a.host.status(ACCOUNT)!.lease?.role, 'primary');
    // The renewal at 10 minutes compacts; that compaction takes 20 seconds.
    log.compactMs = 20_000;
    await drive(a, 10 * MINUTE, () => log.compacting);
    assert.ok(log.compacting, 'a compaction is running');
    await settleWithin(a, a.host.stop(ACCOUNT, 'quit'), MINUTE);
    assert.equal(claimOf(rem, 'device-a')?.until, 0, 'the dead claim was published');
  } finally {
    await a.kill();
    d.cleanup();
  }
});

test('a relaunched primary measures its clock at its first round: a clock now off never acts as primary', async () => {
  const rem = remote();
  const d1 = disk();
  const d2 = disk();
  const log1 = channelLog();
  const first = channelWorld(d1, rem, log1, []);
  try {
    await first.host.start(ACCOUNT);
    await pump(first, 3 * MINUTE);
    assert.equal(first.host.status(ACCOUNT)!.lease?.role, 'primary');
    // The app crashes (its claim stays live) and comes back with a clock 12 minutes fast.
    const log2 = channelLog();
    const again = channelWorld(d2, rem, log2, [], { clock: first.clock });
    log2.serverNow = () => first.clock.now() - 12 * MINUTE;
    const seen = roles(again);
    await again.host.start(ACCOUNT);
    await pump(again, 3 * MINUTE);
    assert.ok(log2.writes >= 1, 'the first round wrote, to measure');
    assert.ok(!seen.includes('primary'), `roles: ${seen.join(',')}`);
    assert.equal(claimOf(rem, 'device-a')?.until, 0);
    await again.kill();
  } finally {
    await first.kill();
    d1.cleanup();
    d2.cleanup();
  }
});

test('a restart carries a fresh clock reading: the new controller writes nothing extra', async () => {
  const d = disk();
  const rem = remote();
  const log = channelLog();
  const a = channelWorld(d, rem, log, []);
  try {
    await a.host.start(ACCOUNT);
    await pump(a, 3 * MINUTE);
    assert.equal(a.host.status(ACCOUNT)!.lease?.role, 'primary');
    const writes = log.writes;
    await a.host.stop(ACCOUNT, 'restart');
    await a.host.start(ACCOUNT);
    await pump(a, 3 * MINUTE);
    assert.equal(log.writes, writes, 'no measuring write after a restart');
    assert.equal(a.host.status(ACCOUNT)!.lease?.role, 'primary');
  } finally {
    await a.kill();
    d.cleanup();
  }
});
