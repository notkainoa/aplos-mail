import test from 'node:test';
import assert from 'node:assert/strict';
import {
  gateReading,
  LEASE_CLOCK_FRESH_MS,
  measureClock,
  needsMeasure,
  unmeasuredGate,
  type ClockOffset,
} from '../src/sync/lease';
import { ACCOUNT, MINUTE, disk } from './sync-actor-helpers';
import { channelLog, channelWorld, pump, remote, roles } from './sync-lease-rig';

/**
 * The clock gate's second review (ARCH 6.5): primary only on a fresh, measured-ok clock, and hysteresis so a reading
 * that flaps around the limit cannot drive the writes past the blocked cadence.
 */

const at = (ms: number): ClockOffset => ({ lowMs: ms, highMs: ms });
const OK = at(4.8 * MINUTE);
const OFF = at(5.2 * MINUTE);

test('measureClock: a block lifts after two ok readings a round apart; an ok reading goes stale', () => {
  let gate = measureClock(unmeasuredGate(), OFF, 0);
  assert.equal(gateReading(gate, 0), 'off');
  gate = measureClock(gate, OK, MINUTE);
  assert.equal(gateReading(gate, MINUTE), 'off', 'one ok reading is not enough');
  gate = measureClock(gate, OK, MINUTE + 10_000);
  assert.equal(gateReading(gate, MINUTE + 10_000), 'off', 'not a round apart');
  gate = measureClock(gate, OK, 2 * MINUTE);
  assert.equal(gateReading(gate, 2 * MINUTE), 'ok');
  assert.equal(gateReading(gate, 2 * MINUTE + LEASE_CLOCK_FRESH_MS), 'unmeasured', 'stale');
  const failed = measureClock(gate, undefined, 3 * MINUTE);
  assert.equal(gateReading(failed, 3 * MINUTE), 'ok', 'a failed check keeps the last ok reading');
  assert.ok(needsMeasure(failed, 3 * MINUTE), 'and asks for another measurement');
  assert.equal(gateReading(measureClock(failed, OFF, 4 * MINUTE), 4 * MINUTE), 'off');
});

test('a relaunched holder whose measuring write fails stays secondary and retries after one round', async () => {
  const rem = remote();
  const d1 = disk();
  const d2 = disk();
  const first = channelWorld(d1, rem, channelLog(), []);
  try {
    await first.host.start(ACCOUNT);
    await pump(first, 3 * MINUTE);
    assert.equal(first.host.status(ACCOUNT)!.lease?.role, 'primary');
    // A crash: the live holder claim stays in the channel. The relaunch's first writes fail.
    const log = channelLog();
    log.failWrites = 2;
    const again = channelWorld(d2, rem, log, [], { clock: first.clock });
    const seen = roles(again);
    await again.host.start(ACCOUNT);
    await pump(again, 150_000);
    assert.equal(log.attempts, 2, 'retried one round after the failure');
    assert.ok(!seen.includes('primary'), `never primary on an unchecked clock: ${seen.join(',')}`);
    await pump(again, 3 * MINUTE);
    assert.ok(log.attempts >= 3);
    assert.equal(again.host.status(ACCOUNT)!.lease?.role, 'primary', 'primary once measured');
    await again.kill();
  } finally {
    await first.kill();
    d1.cleanup();
    d2.cleanup();
  }
});

test('a reading flapping around the limit, with failed checks, keeps the writes at the slow cadence', async () => {
  const d = disk();
  const rem = remote();
  const log = channelLog();
  const pattern = [OK, OFF, OK, OK, undefined, OK, OK, OFF];
  let n = 0;
  log.nextOffset = () => pattern[n++ % pattern.length];
  const a = channelWorld(d, rem, log, []);
  try {
    await a.host.start(ACCOUNT);
    await pump(a, 2 * MINUTE);
    const writes = log.writes;
    await pump(a, 60 * MINUTE);
    assert.ok(log.writes - writes <= 6, `${log.writes - writes} writes in an idle hour`);
  } finally {
    await a.kill();
    d.cleanup();
  }
});

/** The roles reported from the first `primary` on. */
const fromPrimary = (seen: string[]) => seen.slice(Math.max(0, seen.indexOf('primary')));

test('one failed clock check does not demote a primary: the next round measures again', async () => {
  const d = disk();
  const rem = remote();
  const log = channelLog();
  let failNext = false;
  log.nextOffset = () => {
    const failed = failNext;
    failNext = false;
    return failed ? undefined : at(0);
  };
  const a = channelWorld(d, rem, log, []);
  const seen = roles(a);
  try {
    await a.host.start(ACCOUNT);
    await pump(a, 3 * MINUTE);
    assert.equal(a.host.status(ACCOUNT)!.lease?.role, 'primary');
    failNext = true;
    const writes = log.writes;
    await pump(a, 25 * MINUTE);
    assert.deepEqual(fromPrimary(seen), ['primary'], `roles: ${seen.join(',')}`);
    assert.ok(log.writes - writes <= 4, `${log.writes - writes} writes`);
  } finally {
    await a.kill();
    d.cleanup();
  }
});

test('a slow insert on a right clock (a wide bracket wholly within the limit) leaves a primary primary', async () => {
  const d = disk();
  const rem = remote();
  const log = channelLog();
  log.offset = { lowMs: -2 * MINUTE, highMs: 0 };
  const a = channelWorld(d, rem, log, []);
  const seen = roles(a);
  try {
    await a.host.start(ACCOUNT);
    await pump(a, 60 * MINUTE);
    assert.deepEqual(fromPrimary(seen), ['primary'], `roles: ${seen.join(',')}`);
  } finally {
    await a.kill();
    d.cleanup();
  }
});

test('checks that keep failing leave the device secondary and back the measuring writes off', async () => {
  const d = disk();
  const rem = remote();
  const log = channelLog();
  log.nextOffset = () => undefined;
  const a = channelWorld(d, rem, log, []);
  const seen = roles(a);
  try {
    await a.host.start(ACCOUNT);
    await pump(a, 60 * MINUTE);
    assert.ok(!seen.includes('primary'));
    assert.ok(log.writes <= 15, `${log.writes} writes in an hour`);
  } finally {
    await a.kill();
    d.cleanup();
  }
});

test('"Use this Mac" right after the owner fixes the clock succeeds on one fresh ok reading', async () => {
  const d = disk();
  const rem = remote();
  const log = channelLog();
  const a = channelWorld(d, rem, log, [], { skewMs: -12 * MINUTE });
  log.serverNow = () => a.clock.now();
  try {
    await a.host.start(ACCOUNT);
    await pump(a, 3 * MINUTE);
    assert.equal(a.host.status(ACCOUNT)!.lease?.pinned ?? false, false);
    // The owner fixes the clock (the device now agrees with the server) and asks at once.
    log.serverNow = () => a.now();
    await a.host.claimLease(ACCOUNT);
    assert.equal(a.host.status(ACCOUNT)!.lease?.pinned, true);
    await pump(a, 2 * MINUTE);
    assert.equal(a.host.status(ACCOUNT)!.lease?.role, 'primary');
  } finally {
    await a.kill();
    d.cleanup();
  }
});
