import test from 'node:test';
import assert from 'node:assert/strict';
import type { ClockOffset } from '../src/sync/lease';
import { ACCOUNT, MINUTE, disk } from './sync-actor-helpers';
import { channelLog, channelWorld, claimOf, pump, remote, roles } from './sync-lease-rig';

/**
 * The lease's follow-ups after #100 (ARCH 6.5): a device whose clock checks always measure nothing settles at the
 * blocked cadence and compacts its own copies, probing between writes so a recovered check ends the wait (D1), and an
 * owner's "Use this Mac" that lifted a block but could not publish a measured pin re-arms the block (D2).
 */

const at = (ms: number): ClockOffset => ({ lowMs: ms, highMs: ms });
const DAY = 24 * 60 * MINUTE;

test('a lone Mac whose clock checks always fail writes about 50 copies an idle day and compacts its own', async () => {
  const d = disk();
  const log = channelLog();
  log.nextOffset = () => undefined;
  const a = channelWorld(d, remote(), log, []);
  const seen = roles(a);
  try {
    await a.host.start(ACCOUNT);
    await pump(a, DAY, 10_000);
    assert.ok(!seen.includes('primary'), 'never primary on an unproven clock');
    // One candidacy, the 1, 2, 4 and 5-minute backoff, then one every 30 minutes: 5 + 47.
    assert.ok(log.writes <= 52, `${log.writes} copies written in an idle day`);
    assert.ok(log.writes >= 40, `${log.writes}: it keeps measuring`);
    assert.ok(log.ownCompacts >= log.writes - 1, `${log.ownCompacts} own-only compactions`);
    assert.equal(log.compacts, 0, 'never a full compaction');
  } finally {
    await a.kill();
    d.cleanup();
  }
});

test('the slow cadence is for checks that measure nothing: a device back online measures within 5 minutes', async () => {
  const d = disk();
  const log = channelLog();
  log.clockOffsetMs = 0;
  log.failWrites = 1_000;
  const a = channelWorld(d, remote(), log, []);
  try {
    await a.host.start(ACCOUNT);
    await pump(a, 3 * 60 * MINUTE, 10_000);
    const attempts = log.attempts;
    log.failWrites = 0;
    await pump(a, 5 * MINUTE + 5_000);
    assert.ok(log.attempts > attempts, 'retried within the 5-minute backoff');
    await pump(a, 3 * MINUTE);
    assert.equal(a.host.status(ACCOUNT)!.lease?.role, 'primary');
  } finally {
    await a.kill();
    d.cleanup();
  }
});

test('"Use this Mac" whose pin write fails after the owner fixed the clock re-arms the block', async () => {
  const d = disk();
  const rem = remote();
  const log = channelLog();
  log.clockOffsetMs = 12 * MINUTE;
  const a = channelWorld(d, rem, log, []);
  const seen = roles(a);
  try {
    await a.host.start(ACCOUNT);
    await pump(a, 3 * MINUTE);
    assert.equal(claimOf(rem, 'device-a')?.until, 0, 'blocked: the dead claim');
    // The owner fixes the clock: the measuring write reads ok (one ok reading lifts the block for the pin), and the
    // pin's own write then fails.
    log.nextOffset = () => {
      log.nextOffset = undefined;
      log.clockOffsetMs = 0;
      log.failWrites = 1;
      return at(0);
    };
    await assert.rejects(a.host.claimLease(ACCOUNT));
    assert.equal(a.host.status(ACCOUNT)!.lease?.pinned ?? false, false);
    // Re-armed: a second ok reading (the retry, 5 minutes on) lifts the block, and the cool-down after that dead claim
    // holds the live claim 10 minutes more. Lifted for good, this Mac would publish a live claim and take the lease
    // as soon as the cool-down after the measuring write ran out, 10 minutes on.
    await pump(a, 12 * MINUTE);
    assert.equal(claimOf(rem, 'device-a')?.until, 0, 'still the dead claim');
    assert.ok(!seen.includes('primary'), `roles: ${seen.join(',')}`);
    // The owner asks again with the writes working: one fresh ok reading is enough, as before.
    await a.host.claimLease(ACCOUNT);
    assert.equal(a.host.status(ACCOUNT)!.lease?.pinned, true);
    await pump(a, 2 * MINUTE);
    assert.equal(a.host.status(ACCOUNT)!.lease?.role, 'primary');
  } finally {
    await a.kill();
    d.cleanup();
  }
});

test('a primary whose receive-time checks fail for 12 minutes is primary again one probe after they recover', async () => {
  const d = disk();
  const rem = remote();
  const log = channelLog();
  const a = channelWorld(d, rem, log, []);
  try {
    await a.host.start(ACCOUNT);
    await pump(a, 3 * MINUTE);
    assert.equal(a.host.status(ACCOUNT)!.lease?.role, 'primary');
    // Gmail's gets fail from the next renewal on, for that write and its 1, 2, 4 and 5-minute retries (12 minutes),
    // while its inserts work; the fifth empty write starts the slow wait.
    let failing = 5;
    log.nextOffset = () => (failing-- > 0 ? undefined : at(0));
    while (failing > 0) await pump(a, 10_000);
    assert.equal(a.host.status(ACCOUNT)!.lease?.role, 'secondary', 'demoted on a stale reading');
    const [writes, probes] = [log.writes, log.probes];
    await pump(a, 5 * MINUTE + 2 * MINUTE);
    assert.equal(
      a.host.status(ACCOUNT)!.lease?.role,
      'primary',
      'primary again, not 30 minutes on',
    );
    assert.ok(log.probes > probes, 'probed without a new copy');
    // The measuring dead claim, then the candidacy and the holder claim it is decided on at once.
    assert.ok(log.writes - writes <= 3, `${log.writes - writes} copies`);
  } finally {
    await a.kill();
    d.cleanup();
  }
});

test('"Use this Mac" whose pin write lands but measures nothing re-arms the block', async () => {
  const d = disk();
  const rem = remote();
  const log = channelLog();
  log.clockOffsetMs = 12 * MINUTE;
  const a = channelWorld(d, rem, log, []);
  const seen = roles(a);
  try {
    await a.host.start(ACCOUNT);
    await pump(a, 3 * MINUTE);
    // The owner fixes the clock: the measuring write reads ok, the pin's write lands but its check fails.
    const readings = [at(0), undefined];
    log.clockOffsetMs = 0;
    log.nextOffset = () => (readings.length ? readings.shift() : at(0));
    await assert.rejects(a.host.claimLease(ACCOUNT));
    assert.equal(a.host.status(ACCOUNT)!.lease?.pinned ?? false, false);
    assert.equal(claimOf(rem, 'device-a')?.until, 0, 'back to the dead claim');
    await pump(a, 3 * MINUTE);
    assert.ok(!seen.includes('primary'), `roles: ${seen.join(',')}`);
  } finally {
    await a.kill();
    d.cleanup();
  }
});
