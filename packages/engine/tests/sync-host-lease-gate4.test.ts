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

/** Holds the channel's next read until `release()` (the round is then inside `read`). */
function holdable(inner: HostWorkflowChannel) {
  let hold: Promise<void> | undefined;
  let release = () => {};
  let held = false;
  const channel: HostWorkflowChannel = {
    ...inner,
    async read(state, ctx) {
      if (hold) {
        const wait = hold;
        hold = undefined;
        held = true;
        await wait;
      }
      return inner.read(state, ctx);
    },
  };
  return {
    channel,
    holdNext: () => {
      hold = new Promise(resolve => (release = resolve));
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
