import test from 'node:test';
import assert from 'node:assert/strict';
import type { HostWorkflowChannel } from '../src/sync/host';
import { ACCOUNT, FakeAdapter, MINUTE, disk, settle, world } from './sync-actor-helpers';
import {
  baselineDone,
  channelLog,
  channelWorld,
  claimOf,
  portChannel,
  pump,
  remote,
  remoteChannel,
  roles,
  workflowStep,
  type ChannelLog,
  type Remote,
} from './sync-lease-rig';

/**
 * The lease's follow-ups after #127 (ARCH 6.5): a clock set back hours never freezes the retry or the probe, a
 * 'restart' while an owner's lift is in place leaves no stale controller acting on the lift, and two devices, one of
 * them 12 minutes slow, keep at most one primary on the unproven and lift paths.
 */

const HOUR = 60 * MINUTE;

/** Holds the channel's next read (or write, with `holdNext('write')`) until `release()`. */
function holdable(inner: HostWorkflowChannel) {
  const holds: { read?: Promise<void>; write?: Promise<void> } = {};
  let release = () => {};
  let held = false;
  const wait = async (kind: 'read' | 'write') => {
    const hold = holds[kind];
    if (!hold) return;
    holds[kind] = undefined;
    held = true;
    await hold;
  };
  const channel: HostWorkflowChannel = {
    ...inner,
    async read(state, ctx) {
      await wait('read');
      return inner.read(state, ctx);
    },
    async write(entries, ctx) {
      await wait('write');
      return inner.write(entries, ctx);
    },
  };
  return {
    channel,
    holdNext: (kind: 'read' | 'write' = 'read') => {
      held = false;
      holds[kind] = new Promise(resolve => (release = resolve));
    },
    isHeld: () => held,
    release: () => release(),
  };
}

function heldWorld(d: ReturnType<typeof disk>, rem: Remote, log: ChannelLog) {
  const held = holdable(remoteChannel(rem, 'device-a', log));
  const w = world(
    d,
    () => {
      const adapter = new FakeAdapter(input => [workflowStep(input)], {});
      adapter.workflow = portChannel([]);
      return adapter;
    },
    { host: { workflowChannel: () => held.channel } },
  );
  baselineDone(w);
  return { w, held };
}

test('a Mac whose clock was 3 hours fast with failing checks measures at once when the clock is set right', async () => {
  const d = disk();
  const log = channelLog();
  let skew = 3 * HOUR;
  const a = channelWorld(d, remote(), log, [], { skew: () => skew });
  log.serverNow = () => a.clock.now();
  log.nextOffset = () => undefined;
  try {
    await a.host.start(ACCOUNT);
    // The candidacy, the 1, 2, 4 and 5-minute backoff, then the slow 30-minute wait with a probe every 5 minutes.
    await pump(a, 20 * MINUTE, 10_000);
    assert.equal(a.host.status(ACCOUNT)!.lease?.role, 'secondary');
    // NTP sets the clock back 3 hours and the checks work again.
    skew = 0;
    log.nextOffset = undefined;
    const [writes, probes] = [log.writes, log.probes];
    await pump(a, 5 * MINUTE);
    assert.ok(log.writes + log.probes > writes + probes, 'measured again, not 3 hours on');
    assert.equal(a.host.status(ACCOUNT)!.lease?.role, 'primary');
  } finally {
    await a.kill();
    d.cleanup();
  }
});

test('a primary whose renewal fails just before its clock is set back 3 hours is primary again within minutes', async () => {
  const d = disk();
  const log = channelLog();
  let skew = 0;
  const a = channelWorld(d, remote(), log, [], { skew: () => skew });
  try {
    await a.host.start(ACCOUNT);
    await pump(a, 3 * MINUTE);
    assert.equal(a.host.status(ACCOUNT)!.lease?.role, 'primary');
    log.failWrites = 1;
    const attempts = log.attempts;
    while (log.attempts === attempts) await pump(a, 10_000);
    skew = -3 * HOUR;
    await pump(a, 3 * MINUTE);
    assert.equal(a.host.status(ACCOUNT)!.lease?.role, 'primary', 'not frozen for 3 hours');
  } finally {
    await a.kill();
    d.cleanup();
  }
});

test('a restart while an owner lift is in place: the old controller stops, the new one measures, never a stale primary', async () => {
  const d = disk();
  const rem = remote();
  const log = channelLog();
  log.clockOffsetMs = 12 * MINUTE;
  const { w: a, held } = heldWorld(d, rem, log);
  const seen = roles(a);
  try {
    await a.host.start(ACCOUNT);
    await pump(a, 3 * MINUTE);
    assert.equal(claimOf(rem, 'device-a')?.until, 0, 'blocked: the dead claim');
    // The owner fixes the clock and asks: the measuring write reads ok and lifts the block for the pin; the pin's
    // round is then held in its read while the account restarts.
    log.clockOffsetMs = 0;
    const reads = log.reads;
    const claimed = a.host.claimLease(ACCOUNT).then(
      () => 'resolved',
      () => 'rejected',
    );
    while (log.reads === reads) await settle(2);
    held.holdNext();
    while (!held.isHeld()) await settle(2);
    await a.host.stop(ACCOUNT, 'restart');
    await a.host.start(ACCOUNT);
    const writes = log.writes;
    held.release();
    assert.equal(await claimed, 'rejected', 'the pin the old controller was writing is refused');
    await pump(a, 12 * MINUTE);
    assert.ok(log.writes > writes, 'the new controller measures with its own write');
    assert.equal(claimOf(rem, 'device-a')?.until, 0, 'still the dead claim');
    assert.ok(!seen.includes('primary'), `roles: ${seen.join(',')}`);
    assert.equal(a.host.status(ACCOUNT)!.lease?.pinned ?? false, false);
    // Asked again on the new controller, one fresh ok reading is enough, as before.
    await a.host.claimLease(ACCOUNT);
    await pump(a, 2 * MINUTE);
    assert.deepEqual(
      [a.host.status(ACCOUNT)!.lease?.role, a.host.status(ACCOUNT)!.lease?.pinned],
      ['primary', true],
    );
  } finally {
    await a.kill();
    d.cleanup();
  }
});

test('two Macs, one 12 minutes slow with failing checks: one primary, the honest one, until the owner pins the fixed one', async () => {
  const rem = remote();
  const [dA, dB] = [disk(), disk()];
  const [logA, logB] = [channelLog(), channelLog()];
  let skewA = -12 * MINUTE;
  const a = channelWorld(dA, rem, logA, [], { skew: () => skewA });
  const b = channelWorld(dB, rem, logB, [], { clock: a.clock, deviceId: 'device-b' });
  logA.serverNow = logB.serverNow = () => a.clock.now();
  // The slow Mac's checks measure nothing at first (the unproven path), then show its clock off (the block).
  logA.nextOffset = () => undefined;
  const role = (w: typeof a) => w.host.status(ACCOUNT)!.lease?.role;
  const primaries = () => [a, b].filter(w => role(w) === 'primary').map(w => (w === a ? 'a' : 'b'));
  const watch = async (ms: number, expect: string[]) => {
    for (let t = 0; t < ms; t += 10_000) {
      await pump([a, b], 10_000);
      assert.deepEqual(primaries(), expect);
    }
  };
  try {
    await a.host.start(ACCOUNT);
    await b.host.start(ACCOUNT);
    await pump([a, b], 3 * MINUTE);
    await watch(40 * MINUTE, ['b']);
    logA.nextOffset = undefined;
    await watch(40 * MINUTE, ['b']);
    assert.equal(claimOf(rem, 'device-a')?.until, 0, 'the slow Mac publishes the dead claim');
    // The owner fixes the slow Mac's clock and pins it: the honest Mac hands over at its next round.
    skewA = 0;
    await a.host.claimLease(ACCOUNT);
    await pump([a, b], 2 * MINUTE);
    await watch(60 * MINUTE, ['a']);
    assert.equal(a.host.status(ACCOUNT)!.lease?.pinned, true);
  } finally {
    await a.kill();
    await b.kill();
    dA.cleanup();
    dB.cleanup();
  }
});

for (const lead of [0, 5, 8, 11, 14]) {
  test(`a Mac whose clock jumps back 3 hours with failing checks is never primary, not even when its clock catches up (${3 * 60 + lead} minutes)`, async () => {
    const rem = remote();
    const [dA, dB] = [disk(), disk()];
    const [logA, logB] = [channelLog(), channelLog()];
    let skewA = 0;
    const a = channelWorld(dA, rem, logA, [], { skew: () => skewA });
    const b = channelWorld(dB, rem, logB, [], { clock: a.clock, deviceId: 'device-b' });
    logA.serverNow = logB.serverNow = () => a.clock.now();
    const role = (w: typeof a) => w.host.status(ACCOUNT)!.lease?.role;
    const seenA = roles(a);
    try {
      await a.host.start(ACCOUNT);
      await b.host.start(ACCOUNT);
      await pump([a, b], 5 * MINUTE);
      assert.equal(role(a), 'primary', 'an ok reading, the lower id');
      // The clock is set back 3 hours (still 3 hours slow) and every check fails from then on.
      skewA = -(3 * HOUR + lead * MINUTE);
      logA.nextOffset = () => undefined;
      seenA.length = 0;
      for (let t = 0; t < 3 * HOUR + lead * MINUTE + 20 * MINUTE; t += 10_000) {
        await pump([a, b], 10_000, 10_000);
        assert.notEqual(role(a), 'primary', `primary ${t / MINUTE} minutes in`);
      }
      assert.ok(!seenA.includes('primary'), `roles: ${seenA.join(',')}`);
      assert.equal(role(b), 'primary', 'the honest Mac holds the lease meanwhile');
      // The checks work again but show the clock off: still no primary.
      logA.nextOffset = undefined;
      await pump([a, b], 10 * MINUTE, 10_000);
      assert.notEqual(role(a), 'primary');
      skewA = 0;
      // The clock is set right: two ok readings lift the block and the live claim is back, behind the incumbent.
      for (let t = 0; t < 90 * MINUTE; t += 10_000) {
        await pump([a, b], 10_000, 10_000);
        assert.ok(![role(a), role(b)].every(r => r === 'primary'), 'never two primaries');
      }
      assert.ok((claimOf(rem, 'device-a')?.until ?? 0) > 0, 'a live claim again');
      assert.equal(role(b), 'primary');
    } finally {
      await a.kill();
      await b.kill();
      dA.cleanup();
      dB.cleanup();
    }
  });
}

test('a restart while the pin is being written: "Use this Mac" says so, and a second try pins', async () => {
  const d = disk();
  const rem = remote();
  const log = channelLog();
  const { w: a, held } = heldWorld(d, rem, log);
  try {
    await a.host.start(ACCOUNT);
    await pump(a, 3 * MINUTE);
    assert.equal(a.host.status(ACCOUNT)!.lease?.role, 'primary');
    held.holdNext('write');
    const claimed = a.host.claimLease(ACCOUNT).then(
      () => 'resolved',
      (error: unknown) => (error instanceof Error ? error.message : 'rejected'),
    );
    while (!held.isHeld()) await settle(2);
    await a.host.stop(ACCOUNT, 'restart');
    await a.host.start(ACCOUNT);
    held.release();
    assert.match(await claimed, /restarted before this Mac could be set as the main Mac/);
    await pump(a, 3 * MINUTE);
    await a.host.claimLease(ACCOUNT);
    await pump(a, 2 * MINUTE);
    assert.deepEqual(
      [a.host.status(ACCOUNT)!.lease?.role, a.host.status(ACCOUNT)!.lease?.pinned],
      ['primary', true],
    );
  } finally {
    await a.kill();
    d.cleanup();
  }
});

/** Two Macs on one shared clock; each has its own skew and its own receive-time checks. */
function pair() {
  const rem = remote();
  const [dA, dB] = [disk(), disk()];
  const [logA, logB] = [channelLog(), channelLog()];
  const skew = { a: 0, b: 0 };
  const a = channelWorld(dA, rem, logA, [], { skew: () => skew.a });
  const b = channelWorld(dB, rem, logB, [], {
    clock: a.clock,
    deviceId: 'device-b',
    skew: () => skew.b,
  });
  logA.serverNow = logB.serverNow = () => a.clock.now();
  const role = (w: typeof a) => w.host.status(ACCOUNT)!.lease?.role;
  const cleanup = async () => {
    await a.kill();
    await b.kill();
    dA.cleanup();
    dB.cleanup();
  };
  return { rem, a, b, logA, logB, skew, role, cleanup };
}

test('two Macs, both clocks off and fixed at once, both asked to be the main Mac: one primary within minutes', async () => {
  const { a, b, skew, role, cleanup } = pair();
  try {
    skew.a = 12 * MINUTE;
    skew.b = -12 * MINUTE;
    await a.host.start(ACCOUNT);
    await b.host.start(ACCOUNT);
    await pump([a, b], 10 * MINUTE);
    assert.notEqual(role(a), 'primary');
    assert.notEqual(role(b), 'primary');
    skew.a = skew.b = 0;
    await pump([a, b], 2 * MINUTE);
    await Promise.all([a.host.claimLease(ACCOUNT), b.host.claimLease(ACCOUNT)]);
    await pump([a, b], 5 * MINUTE);
    for (let t = 0; t < 30 * MINUTE; t += 10_000) {
      await pump([a, b], 10_000, 10_000);
      const primaries = [role(a), role(b)].filter(r => r === 'primary').length;
      assert.equal(primaries, 1, `${primaries} primaries ${t / MINUTE} minutes on`);
    }
  } finally {
    await cleanup();
  }
});

test('a clock jumped forward by days with failing checks: never primary, and not after it is set back either', async () => {
  const { a, b, logA, skew, role, cleanup } = pair();
  try {
    await a.host.start(ACCOUNT);
    await b.host.start(ACCOUNT);
    await pump([a, b], 5 * MINUTE);
    assert.equal(role(a), 'primary');
    skew.a = 3 * 24 * HOUR;
    logA.nextOffset = () => undefined;
    for (let t = 0; t < 2 * HOUR; t += 10_000) {
      await pump([a, b], 10_000, 10_000);
      assert.notEqual(role(a), 'primary', `primary ${t / MINUTE} minutes after the jump`);
    }
    assert.equal(role(b), 'primary');
    skew.a = 0;
    for (let t = 0; t < 2 * HOUR; t += 10_000) {
      await pump([a, b], 10_000, 10_000);
      assert.notEqual(role(a), 'primary', `primary ${t / MINUTE} minutes after it was set back`);
    }
  } finally {
    await cleanup();
  }
});
