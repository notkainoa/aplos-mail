import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LEASE_RENEW_MS,
  LEASE_ROUND_MS,
  LEASE_SKEW_MS,
  LEASE_TTL_MS,
  LEASE_WRITE_RETRY_MS,
  createLeaseController,
  decideLease,
  leaseKey,
  type Lease,
  type LeaseClaim,
  type LeaseController,
  type LeaseRecord,
} from '../src/sync/lease';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T0 = Date.UTC(2026, 9, 29, 9);
const ACCOUNT = 'acct-lease';

// ---- a shared in-memory workflow channel and simulated devices ----

/** One channel two or three devices share: last writer wins per key, by a global write counter. */
class FakeChannel {
  readonly records = new Map<string, LeaseRecord>();
  /** Records that are not lease claims, or are damaged or forged, as other writers might leave them. */
  readonly junk: LeaseRecord[] = [];
  private gen = 0;

  put(device: string, key: string, value: unknown, at: number): void {
    this.records.set(key, { key, stamp: { at, gen: ++this.gen, device }, value });
  }
  view(): LeaseRecord[] {
    return [...this.records.values(), ...this.junk];
  }
}

interface Device {
  id: string;
  ctl: LeaseController;
  reports: Lease[];
  reads: number;
  writes: number;
  /** Write attempts, failed ones included. */
  tries: number;
  /** Wall-clock offset from real time. */
  skew: number;
  offline: boolean;
  failWrites: boolean;
  failReads: boolean;
  active: boolean;
  now(): number;
}

class World {
  t = T0;
  readonly channel = new FakeChannel();
  readonly devices: Device[] = [];

  device(id: string, skew = 0): Device {
    const d: Device = {
      id,
      reports: [],
      reads: 0,
      writes: 0,
      tries: 0,
      skew,
      offline: false,
      failWrites: false,
      failReads: false,
      active: true,
      now: () => this.t + d.skew,
      ctl: undefined as unknown as LeaseController,
    };
    d.ctl = createLeaseController({
      account: ACCOUNT,
      device: id,
      clock: { now: () => d.now() },
      active: () => d.active,
      report: (account, lease) => {
        assert.equal(account, ACCOUNT);
        d.reports.push(lease);
      },
      channel: {
        read: async () => {
          if (d.failReads) throw new Error('read failed');
          d.reads++;
          return this.channel.view();
        },
        write: async entries => {
          d.tries++;
          if (d.failWrites) throw new Error('write failed');
          d.writes++;
          for (const e of entries) this.channel.put(id, e.key, e.value, d.now());
        },
      },
    });
    this.devices.push(d);
    return d;
  }

  /** Every online device whose round is due ticks, in order, until none is due at this instant. */
  async tickDue(): Promise<void> {
    for (let pass = 0; pass < 5; pass++) {
      const due = this.devices.filter(d => !d.offline && d.ctl.next() <= d.now());
      if (!due.length) return;
      for (const d of due) await d.ctl.tick();
    }
  }

  /** Advances real time in `step`s, ticking due devices; `check` runs after every step. */
  async run(ms: number, check?: () => void, step = 5_000): Promise<void> {
    const end = this.t + ms;
    while (this.t < end) {
      this.t += step;
      await this.tickDue();
      check?.();
    }
  }
}

const role = (d: Device) => d.ctl.current().role;
const primaries = (w: World) => w.devices.filter(d => !d.offline && role(d) === 'primary');
/** Role changes reported since report number `from`. */
const roleFlips = (d: Device, from = 0) =>
  d.reports.filter((r, i) => i > from && r.role !== d.reports[i - 1].role).length;

// ---- the pure rule ----

const claim = (
  device: string,
  value: Partial<LeaseClaim> & { until: number },
  stamp: Partial<LeaseRecord['stamp']> = {},
): LeaseRecord => ({
  key: leaseKey(device),
  stamp: { at: T0, gen: 0, device, ...stamp },
  value: { v: 1, holder: false, pinned: false, pinnedAt: 0, ...value },
});

const live = T0 + LEASE_TTL_MS;

test('decideLease: no claims means secondary with no holder', () => {
  const d = decideLease([], 'mac-a', T0);
  assert.equal(d.role, 'secondary');
  assert.equal(d.winner, undefined);
});

test('decideLease: candidacies go to the lower DeviceId', () => {
  const records = [claim('mac-b', { until: live }), claim('mac-a', { until: live })];
  assert.equal(decideLease(records, 'mac-a', T0).role, 'primary');
  assert.equal(decideLease(records, 'mac-b', T0).role, 'secondary');
  assert.equal(decideLease(records, 'mac-b', T0).winner?.device, 'mac-a');
});

test('decideLease: a live holder keeps the lease against a lower DeviceId (hysteresis)', () => {
  const records = [claim('mac-a', { until: live }), claim('mac-b', { until: live, holder: true })];
  assert.equal(decideLease(records, 'mac-b', T0).role, 'primary');
  assert.equal(decideLease(records, 'mac-a', T0).winner?.device, 'mac-b');
  // Two holders (two devices that started together): the lower id.
  const both = [claim('mac-a', { until: live, holder: true }), records[1]];
  assert.equal(decideLease(both, 'mac-b', T0).winner?.device, 'mac-a');
});

test('decideLease: a pin wins over a holder; the latest pin wins; equal pins go to the lower id', () => {
  const holder = claim('mac-a', { until: live, holder: true });
  const pinned = claim('mac-c', { until: live, pinned: true, pinnedAt: T0 });
  assert.equal(decideLease([holder, pinned], 'mac-a', T0).winner?.device, 'mac-c');
  const later = claim('mac-b', { until: live, pinned: true, pinnedAt: T0 + 1 });
  assert.equal(decideLease([holder, pinned, later], 'mac-a', T0).winner?.device, 'mac-b');
  const tie = claim('mac-b', { until: live, pinned: true, pinnedAt: T0 });
  assert.equal(decideLease([pinned, tie], 'mac-a', T0).winner?.device, 'mac-b');
  assert.equal(decideLease([pinned, tie], 'mac-a', T0).pinHigh, T0);
});

test('decideLease: others stay live for the skew margin past `until`, our own claim only until `until`', () => {
  const records = [claim('mac-a', { until: T0, holder: true }), claim('mac-b', { until: live })];
  // At `until`, mac-a no longer counts itself, but mac-b still counts it for the skew margin.
  assert.equal(decideLease(records, 'mac-a', T0).role, 'secondary');
  assert.equal(decideLease(records, 'mac-b', T0 + LEASE_SKEW_MS - 1).winner?.device, 'mac-a');
  assert.equal(decideLease(records, 'mac-b', T0 + LEASE_SKEW_MS).role, 'primary');
});

test('decideLease: foreign, damaged, unknown and far-future records are ignored', () => {
  const good = claim('mac-b', { until: live });
  const records: LeaseRecord[] = [
    good,
    // mac-z forging mac-a's claim: the key's device did not write it.
    claim('mac-a', { until: live, holder: true }, { device: 'mac-z' }),
    // A clock hours ahead (or a hostile writer) would hold the lease forever.
    claim('mac-0', { until: T0 + 3 * HOUR, holder: true }),
    { key: leaseKey('mac-1'), stamp: { at: T0, gen: 0, device: 'mac-1' }, value: null },
    { key: leaseKey('mac-1'), stamp: { at: T0, gen: 1, device: 'mac-1' }, value: 'primary' },
    {
      key: leaseKey('mac-2'),
      stamp: { at: T0, gen: 0, device: 'mac-2' },
      value: { v: 2, holder: true, until: live, pinned: false, pinnedAt: 0 },
    },
    {
      key: leaseKey('mac-3'),
      stamp: { at: T0, gen: 0, device: 'mac-3' },
      value: { v: 1, holder: 'yes', until: live, pinned: false, pinnedAt: 0 },
    },
    {
      key: leaseKey('mac-4'),
      stamp: { at: T0, gen: 0, device: 'mac-4' },
      value: { v: 1, holder: true, until: -1, pinned: false, pinnedAt: 0 },
    },
    {
      key: leaseKey('bad id!'),
      stamp: { at: T0, gen: 0, device: 'bad id!' },
      value: { v: 1, holder: true, until: live, pinned: true, pinnedAt: T0 },
    },
    { key: 'lease', stamp: { at: T0, gen: 0, device: 'mac-0' }, value: { holder: 'mac-0' } },
    { key: 'thread:abc', stamp: { at: T0, gen: 0, device: 'mac-0' }, value: { status: 'done' } },
    null as unknown as LeaseRecord,
  ];
  const d = decideLease(records, 'mac-b', T0);
  assert.equal(d.role, 'primary');
  assert.equal(d.winner?.device, 'mac-b');
});

/** A small seeded generator, so a failure names its seed. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1_664_525 + 1_013_904_223) >>> 0;
    return s / 2 ** 32;
  };
}

function randomRecords(next: () => number): LeaseRecord[] {
  const ids = ['mac-a', 'mac-b', 'mac-c', 'mac-d'];
  const out: LeaseRecord[] = [];
  const count = Math.floor(next() * 8);
  for (let i = 0; i < count; i++) {
    const device = ids[Math.floor(next() * ids.length)];
    const until = T0 + Math.floor((next() - 0.3) * 2 * LEASE_TTL_MS);
    const pinned = next() < 0.25;
    const stamp = { at: T0 + Math.floor(next() * 3), gen: Math.floor(next() * 2), device };
    out.push(
      claim(
        device,
        { until, holder: next() < 0.4, pinned, pinnedAt: pinned ? T0 + Math.floor(next() * 3) : 0 },
        next() < 0.1 ? { ...stamp, device: 'mac-z' } : stamp,
      ),
    );
  }
  return out;
}

function shuffled<T>(items: readonly T[], next: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

test('decideLease property: any order (and duplicates) of the records gives the same answer', () => {
  for (let seed = 1; seed <= 500; seed++) {
    const next = rng(seed);
    const records = randomRecords(next);
    for (const self of ['mac-a', 'mac-c']) {
      const now = T0 + Math.floor(next() * LEASE_TTL_MS);
      const expected = decideLease(records, self, now);
      for (let k = 0; k < 4; k++) {
        const mixed = shuffled([...records, ...records.slice(0, k)], next);
        assert.deepEqual(decideLease(mixed, self, now), expected, `seed ${seed}`);
      }
    }
  }
});

test('decideLease property: devices that see the same live claims agree on one primary', () => {
  for (let seed = 1; seed <= 500; seed++) {
    const next = rng(seed);
    const records = randomRecords(next);
    // Far from every expiry edge, every device sees the same live set.
    const now = T0 - 4 * LEASE_SKEW_MS;
    const selves = ['mac-a', 'mac-b', 'mac-c', 'mac-d'];
    const decisions = selves.map(self => decideLease(records, self, now));
    const winners = new Set(decisions.map(d => d.winner?.device));
    const ownsLive = selves.every(
      (self, i) => decisions[i].own === undefined || decisions[i].own!.until > now + LEASE_SKEW_MS,
    );
    if (!ownsLive) continue;
    assert.ok(winners.size <= 1, `seed ${seed}: ${[...winners].join(',')}`);
    assert.ok(decisions.filter(d => d.role === 'primary').length <= 1, `seed ${seed}`);
  }
});

// ---- the controller over a shared channel ----

test('two devices starting at the same instant converge on the lower id and never flap', async () => {
  const w = new World();
  const a = w.device('mac-a');
  const b = w.device('mac-b');
  await b.ctl.tick();
  await a.ctl.tick();
  // First round: candidacies only, nobody promotes on a claim the other could not see yet.
  assert.deepEqual([role(a), role(b)], ['secondary', 'secondary']);
  await w.tickDue();
  assert.deepEqual([role(a), role(b)], ['primary', 'secondary']);
  const [atA, atB] = [a.reports.length - 1, b.reports.length - 1];
  await w.run(6 * HOUR, () => assert.ok(primaries(w).length <= 1));
  assert.deepEqual([role(a), role(b)], ['primary', 'secondary']);
  assert.equal(roleFlips(a, atA), 0, 'promoted once, then never back');
  assert.equal(roleFlips(b, atB), 0);
  assert.ok(b.reports.every(r => r.role === 'secondary'));
  assert.equal(b.ctl.current().holder, 'mac-a');
});

test('a lone device becomes primary on its second round and renews at a third of the TTL', async () => {
  const w = new World();
  const a = w.device('mac-a');
  await a.ctl.tick();
  await w.tickDue();
  assert.equal(role(a), 'primary');
  assert.equal(a.ctl.current().until, w.t + LEASE_TTL_MS);
  const writes = a.writes;
  const reads = a.reads;
  await w.run(HOUR);
  assert.equal(a.writes - writes, HOUR / LEASE_RENEW_MS, 'one renewal per 10 minutes');
  // Every round is one read; a round with nothing due writes nothing.
  assert.equal(a.reads - reads, HOUR / LEASE_ROUND_MS);
  assert.equal(role(a), 'primary');
});

test('a primary keeps the lease when a lower DeviceId joins', async () => {
  const w = new World();
  const b = w.device('mac-b');
  await b.ctl.tick();
  await w.tickDue();
  assert.equal(role(b), 'primary');
  const a = w.device('mac-a');
  await w.run(3 * HOUR, () => assert.equal(primaries(w).length, 1));
  assert.deepEqual([role(a), role(b)], ['secondary', 'primary']);
  assert.equal(roleFlips(a), 0);
});

test('a device offline longer than the TTL loses the lease; back online it stays secondary', async () => {
  const w = new World();
  const a = w.device('mac-a');
  const b = w.device('mac-b');
  await w.run(5 * MINUTE);
  assert.equal(role(a), 'primary');
  a.offline = true;
  const until = a.ctl.current().until!;
  await w.run(until + LEASE_SKEW_MS - w.t - 5_000, () => assert.equal(role(b), 'secondary'));
  await w.run(LEASE_ROUND_MS + 10_000);
  assert.equal(role(b), 'primary', 'taken over within one round of TTL + skew margin');
  a.offline = false;
  await w.run(2 * HOUR, () => assert.ok(primaries(w).length <= 1));
  assert.deepEqual([role(a), role(b)], ['secondary', 'primary']);
});

for (const [holderSkew, otherSkew] of [
  [-LEASE_SKEW_MS / 2, LEASE_SKEW_MS / 2],
  [LEASE_SKEW_MS / 2, -LEASE_SKEW_MS / 2],
]) {
  test(`clock skew ${holderSkew / MINUTE} / ${otherSkew / MINUTE} min: the other neither steals early nor overlaps`, async () => {
    const w = new World();
    const holder = w.device('mac-b', holderSkew);
    await holder.ctl.tick();
    await w.tickDue();
    assert.equal(role(holder), 'primary');
    const other = w.device('mac-a', otherSkew);
    await w.run(4 * HOUR, () => assert.equal(primaries(w).length, 1));
    assert.equal(role(holder), 'primary', 'a renewing holder is never stolen from');

    // The holder can still read but no write lands: it keeps its role until its own claim runs out (by its own
    // clock), and the other takes over only after that, so the two are never primary at once.
    holder.failWrites = true;
    let handover = 0;
    await w.run(2 * HOUR, () => {
      assert.ok(primaries(w).length <= 1, `two primaries at ${(w.t - T0) / MINUTE} min`);
      if (!handover && role(other) === 'primary') handover = w.t;
    });
    assert.equal(role(other), 'primary');
    assert.equal(role(holder), 'secondary');
    assert.ok(handover > 0);
  });
}

test('"Use this Mac" moves the lease; release drops only the pin and the holder stays primary', async () => {
  const w = new World();
  const a = w.device('mac-a');
  const b = w.device('mac-b');
  await w.run(5 * MINUTE);
  assert.equal(role(a), 'primary');
  await b.ctl.claim();
  assert.equal(b.ctl.current().pinned, true);
  await w.run(2 * LEASE_ROUND_MS, () =>
    assert.ok(primaries(w).length <= 1 || role(b) === 'primary'),
  );
  assert.deepEqual([role(a), role(b)], ['secondary', 'primary']);
  assert.equal(a.ctl.current().holder, 'mac-b');
  await b.ctl.release();
  assert.equal(b.ctl.current().pinned, false);
  await w.run(3 * HOUR, () => assert.equal(primaries(w).length, 1));
  assert.deepEqual([role(a), role(b)], ['secondary', 'primary'], 'release is not a hand-back');
  // Releasing again is a no-op that writes nothing.
  const writes = b.writes;
  await b.ctl.release();
  assert.equal(b.writes, writes);
});

test("a later pin elsewhere wins and replaces this device's pin", async () => {
  const w = new World();
  const a = w.device('mac-a');
  const b = w.device('mac-b');
  await w.run(5 * MINUTE);
  await a.ctl.claim();
  await w.run(5 * MINUTE);
  await b.ctl.claim();
  await w.run(HOUR, () => assert.ok(primaries(w).length <= 2));
  assert.deepEqual([role(a), role(b)], ['secondary', 'primary']);
  assert.equal(a.ctl.current().pinned, false, 'the older pin is dropped');
  assert.equal(b.ctl.current().pinned, true);
});

test('a pin survives a restart through the live claim', async () => {
  const w = new World();
  const b = w.device('mac-b');
  w.device('mac-a');
  await w.run(5 * MINUTE);
  await b.ctl.claim();
  await w.run(5 * MINUTE);
  assert.equal(role(b), 'primary');
  // Restart: a fresh controller on mac-b.
  w.devices.splice(w.devices.indexOf(b), 1);
  const again = w.device('mac-b');
  await again.ctl.tick();
  assert.equal(again.ctl.current().pinned, true);
  assert.equal(role(again), 'primary', 'its live pinned claim on the channel still wins');
});

test('write failures keep the previous role until expiry, and the claim retries on a backoff', async () => {
  const w = new World();
  const a = w.device('mac-a');
  await w.run(5 * MINUTE);
  const until = a.ctl.current().until!;
  a.failWrites = true;
  const [tries, failedAt] = [a.tries, w.t];
  await w.run(until - LEASE_ROUND_MS - w.t - 5_000, () => assert.equal(role(a), 'primary'));
  await w.run(LEASE_ROUND_MS);
  assert.equal(role(a), 'secondary');
  // Not one write per round: one per retry interval once the renewal is due.
  const window = w.t - failedAt - (LEASE_RENEW_MS - 5 * MINUTE);
  assert.ok(
    a.tries - tries <= Math.ceil(window / LEASE_WRITE_RETRY_MS) + 1,
    `${a.tries - tries} tries`,
  );
  assert.ok(a.tries - tries >= 2);
  a.failWrites = false;
  await w.run(LEASE_WRITE_RETRY_MS + 2 * LEASE_ROUND_MS);
  assert.equal(role(a), 'primary', 'back once a write lands');
});

test('read failures keep the role until our own claim runs out', async () => {
  const w = new World();
  const a = w.device('mac-a');
  await w.run(5 * MINUTE);
  const until = a.ctl.current().until!;
  a.failReads = true;
  await w.run(until - LEASE_ROUND_MS - w.t - 5_000, () => assert.equal(role(a), 'primary'));
  await w.run(LEASE_ROUND_MS);
  assert.equal(role(a), 'secondary');
});

test('claim() that cannot be written rejects and leaves the pin as it was', async () => {
  const w = new World();
  const a = w.device('mac-a');
  const b = w.device('mac-b');
  await w.run(5 * MINUTE);
  b.failWrites = true;
  await assert.rejects(b.ctl.claim());
  assert.equal(b.ctl.current().pinned, false);
  b.failWrites = false;
  await w.run(HOUR);
  assert.deepEqual([role(a), role(b)], ['primary', 'secondary']);
});

test('asleep or stopped: no reads and no renewal, so the lease lapses to the other device', async () => {
  const w = new World();
  const a = w.device('mac-a');
  const b = w.device('mac-b');
  await w.run(5 * MINUTE);
  a.active = false;
  const reads = a.reads;
  await w.run(LEASE_TTL_MS + LEASE_SKEW_MS + 2 * LEASE_ROUND_MS);
  assert.equal(a.reads, reads);
  assert.deepEqual([role(a), role(b)], ['secondary', 'primary']);
});

test('a corrupted or forged claim in the channel changes nothing', async () => {
  const w = new World();
  const a = w.device('mac-a');
  const b = w.device('mac-b');
  w.channel.junk.push(
    claim('mac-0', { until: T0 + 10 * HOUR, holder: true, pinned: true, pinnedAt: T0 }),
    claim(
      'mac-b',
      { until: T0 + LEASE_TTL_MS, holder: true, pinned: true, pinnedAt: T0 + HOUR },
      { device: 'mac-z' },
    ),
    {
      key: leaseKey('mac-0'),
      stamp: { at: T0, gen: 9, device: 'mac-0' },
      value: '{"holder":true}',
    },
  );
  await w.run(2 * HOUR, () => assert.ok(primaries(w).length <= 1));
  assert.deepEqual([role(a), role(b)], ['primary', 'secondary']);
});

test('a clock that jumps back rewrites its claim instead of waiting out a far-future one', async () => {
  const w = new World();
  const a = w.device('mac-a');
  const b = w.device('mac-b');
  await w.run(5 * MINUTE);
  b.skew = -2 * HOUR;
  await w.run(5 * MINUTE);
  a.offline = true;
  await w.run(LEASE_TTL_MS + LEASE_SKEW_MS + 2 * LEASE_ROUND_MS);
  assert.equal(role(b), 'primary');
});

test('claim() and tick() at the same moment run one after the other', async () => {
  const w = new World();
  const a = w.device('mac-a');
  const b = w.device('mac-b');
  await w.run(5 * MINUTE);
  const writes = b.writes;
  await Promise.all([b.ctl.tick(), b.ctl.claim(), b.ctl.tick()]);
  assert.equal(
    b.writes - writes,
    2,
    'the pinned claim, then the holder flag on the round that sees it',
  );
  assert.deepEqual([role(b), b.ctl.current().pinned], ['primary', true]);
  await w.run(2 * LEASE_ROUND_MS);
  assert.deepEqual([role(a), role(b)], ['secondary', 'primary']);
});
