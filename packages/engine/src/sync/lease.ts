import type { AccountId, AccountRuntime, Clock, DeviceId } from '../ports';

/**
 * The primary-device lease (ARCH 6.5, 13.1; plan 20 PV3): one device per account runs backfill, prefetch, background
 * AI and workflow compaction; the others stay at or under the secondary target. It rides the workflow channel as one
 * record per device, `lease:<deviceId>` = `LeaseClaim`, so every device sees every live claim and applies one rule to
 * the same set (the channel merges records last-writer-wins and never interprets them):
 *
 * 1. A claim counts when it is well formed, written by the device its key names, and live: `until` is ahead of the
 *    reader's clock by more than `-LEASE_SKEW_MS` (another device's claim), or by more than `LEASE_GIVE_UP_MS` (this
 *    device's own, so a holder gives up before anyone else can take over), and neither `until` nor `pinnedAt` is
 *    absurdly far ahead (a broken clock). The skew margin stands in for a server clock: the channel carries only the
 *    writers' own clocks.
 * 2. Among live claims a pin wins, the latest `pinnedAt` first ("Use this Mac" is the owner's latest intent); then a
 *    claim that already holds (`holder: true`), so a primary keeps the lease while its claim is live (hysteresis); then
 *    the lower DeviceId. Ties at every step go to the lower DeviceId.
 * 3. A device is primary only when its own *published* claim wins: it never promotes on a claim others have not been
 *    able to see, and its own record is always the last claim it wrote successfully (never a local-only one). So two
 *    devices starting together both write a candidacy first and converge on the lower id the round after, and a
 *    failed write keeps the role the last published claim gives, until that claim runs out.
 *
 * Handover: a holder that can no longer renew gives up `LEASE_GIVE_UP_MS` before its `until` (its own clock, and
 * `next()` wakes it then); another device takes over at `until + LEASE_SKEW_MS` (its clock). That leaves no overlap for
 * clocks within plus or minus 5 minutes of true time and a holder's tick up to one round late. Worst case, a vanished
 * holder's lease passes on `LEASE_TTL_MS + LEASE_SKEW_MS` plus one round after its last renewal (41 minutes); a quit
 * (`stop`) passes it on at the next round. The lease is soft (ARCH 6.5): a brief double primary is absorbed by AIMD.
 *
 * Clock gate: the rule above holds only for clocks within `LEASE_CLOCK_MAX_MS` of true time. After each write the host
 * compares the copy's `writtenAt` (this device's clock) with the server's receive time for it (`LeaseDeps.eligible`);
 * a device further off, or whose offset could not be measured after a write, publishes a claim that never counts
 * (`holder: false, until: 0`), stays secondary, and measures again with each `LEASE_RENEW_MS` rewrite of that claim.
 *
 * "Use this Mac" on device B overlaps the old primary A until A's next *successful* read shows B's pin: one round when
 * A's reads work, but up to A's own give-up time (`until - LEASE_GIVE_UP_MS`, about 28 minutes after its last renewal)
 * when A's reads fail or its data key is locked, since A then keeps the role its last published claim gives.
 *
 * Cost per device and account: one gated channel read a round (`LEASE_ROUND_MS`; about 2 Gmail units when nothing
 * changed), and a claim rewrite every `LEASE_RENEW_MS` (or on a role or pin change). On Gmail a rewrite is one sealed
 * whole-view copy (`messages.insert`, 25 units) plus the receive-time check (`messages.get` minimal, 20); the primary
 * then compacts what the copy supersedes (one 60-unit read-back per written copy, 20 per copy trashed, at most 25 a
 * call). About 120 + 6 x 45 = 390 units an hour per idle device, plus the primary's compaction.
 */

/** ARCH 6.5: a 30-minute TTL. */
export const LEASE_TTL_MS = 30 * 60_000;
/** A claim is rewritten once a third of its TTL has passed, so a live device's claim never comes near expiry. */
export const LEASE_RENEW_MS = LEASE_TTL_MS / 3;
/**
 * The clock difference between two devices the rule tolerates without a steal or an overlap: each device within
 * plus or minus 5 minutes of true time.
 */
export const LEASE_SKEW_MS = 10 * 60_000;
/** How often `tick` reads the channel (one gated round: the channel's idle cost when nothing changed). */
export const LEASE_ROUND_MS = 60_000;
/** A holder stops counting its own claim this long before `until`: one round of tick lateness, plus one round. */
export const LEASE_GIVE_UP_MS = 2 * LEASE_ROUND_MS;
/** The clock gate: a device whose clock is further than this from the server's may not hold the lease. */
export const LEASE_CLOCK_MAX_MS = 5 * 60_000;
/** After a failed write, the next try waits this long (four tries fit in the slack before the claim expires). */
export const LEASE_WRITE_RETRY_MS = 5 * 60_000;
export const LEASE_PREFIX = 'lease:';

const DEVICE_RE = /^[\w.-]{1,128}$/;

export type Lease = NonNullable<AccountRuntime['lease']>;

/** One device's claim, the value of its `lease:<deviceId>` record. `pinnedAt` is 0 when not pinned. */
export type LeaseClaim = {
  v: 1;
  holder: boolean;
  until: number;
  pinned: boolean;
  pinnedAt: number;
};

/** A merged workflow record, as the channel's view gives it (structural, so the engine needs no host import). */
export interface LeaseRecord {
  key: string;
  stamp: { at: number; gen: number; device: string };
  value: unknown;
}

/** The workflow channel as the lease uses it; the host adapts `WorkflowStateChannel` (`read` = one gated round). */
export interface LeaseChannel {
  read(): Promise<readonly LeaseRecord[]>;
  write(entries: { key: string; value: LeaseClaim }[]): Promise<unknown>;
}

export interface Claim extends LeaseClaim {
  device: DeviceId;
  stamp: LeaseRecord['stamp'];
}

export interface LeaseDecision {
  role: Lease['role'];
  /** The winning claim, if any claim is live. */
  winner?: Claim;
  /** This device's own valid claim from the channel, live or not. */
  own?: Claim;
  /** The latest `pinnedAt` among live claims (0 for none). */
  pinHigh: number;
}

export const leaseKey = (device: DeviceId) => `${LEASE_PREFIX}${device}`;

const isCount = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

function isClaimValue(v: unknown): v is LeaseClaim {
  const c = v as Partial<LeaseClaim> | null;
  if (!c || typeof c !== 'object' || c.v !== 1) return false;
  if (typeof c.holder !== 'boolean' || typeof c.pinned !== 'boolean') return false;
  return isCount(c.until) && isCount(c.pinnedAt);
}

/** A record as a claim, or undefined when it is not a lease claim, is malformed or was written by another device. */
export function parseClaim(record: LeaseRecord): Claim | undefined {
  if (!record || typeof record.key !== 'string' || !record.key.startsWith(LEASE_PREFIX)) return;
  const device = record.key.slice(LEASE_PREFIX.length);
  const stamp = record.stamp;
  if (!DEVICE_RE.test(device) || !stamp || stamp.device !== device) return;
  if (!isCount(stamp.at) || !isCount(stamp.gen)) return;
  const v = record.value;
  if (!isClaimValue(v)) return;
  return {
    v: 1,
    holder: v.holder,
    until: v.until,
    pinned: v.pinned,
    pinnedAt: v.pinnedAt,
    device,
    stamp: { at: stamp.at, gen: stamp.gen, device },
  };
}

/** Positive when `a` is the later write of the same key (stamp, then content, so duplicates resolve in any order). */
function later(a: Claim, b: Claim): number {
  if (a.stamp.at !== b.stamp.at) return a.stamp.at - b.stamp.at;
  if (a.stamp.gen !== b.stamp.gen) return a.stamp.gen - b.stamp.gen;
  const x = JSON.stringify([a.holder, a.until, a.pinned, a.pinnedAt]);
  const y = JSON.stringify([b.holder, b.until, b.pinned, b.pinnedAt]);
  return x === y ? 0 : x > y ? 1 : -1;
}

/** One claim per device: the latest write of its key. */
function claimsOf(records: readonly LeaseRecord[]): Map<DeviceId, Claim> {
  const claims = new Map<DeviceId, Claim>();
  for (const record of records) {
    const claim = parseClaim(record);
    if (!claim) continue;
    const held = claims.get(claim.device);
    if (!held || later(claim, held) > 0) claims.set(claim.device, claim);
  }
  return claims;
}

/**
 * Whether another device's claim running to `until` still counts at `now` on this device's clock (rule 1): honoured
 * until `until + LEASE_SKEW_MS`. Every place that asks "is that holder gone?" uses this one boundary.
 */
export function peerClaimLive(until: number, now: number): boolean {
  return until + LEASE_SKEW_MS > now;
}

function isLive(claim: Claim, self: DeviceId, now: number): boolean {
  const ceiling = now + LEASE_TTL_MS + LEASE_SKEW_MS;
  if (claim.until > ceiling || claim.pinnedAt > ceiling) return false;
  if (claim.device === self) return claim.until - LEASE_GIVE_UP_MS > now;
  return peerClaimLive(claim.until, now);
}

const lowerId = (a: Claim, b: Claim) => (a.device < b.device ? a : b);
const laterPin = (a: Claim, b: Claim) =>
  a.pinnedAt !== b.pinnedAt ? (a.pinnedAt > b.pinnedAt ? a : b) : lowerId(a, b);

function winnerOf(live: readonly Claim[]): Claim | undefined {
  const pinned = live.filter(c => c.pinned);
  if (pinned.length) return pinned.reduce(laterPin);
  const holders = live.filter(c => c.holder);
  if (holders.length) return holders.reduce(lowerId);
  return live.length ? live.reduce(lowerId) : undefined;
}

/** The lease rule (see the header): pure, and the same answer for any order of `records`. */
export function decideLease(
  records: readonly LeaseRecord[],
  self: DeviceId,
  now: number,
): LeaseDecision {
  const claims = claimsOf(records);
  const live = [...claims.values()].filter(c => isLive(c, self, now));
  const winner = winnerOf(live);
  const pinHigh = live.reduce((high, c) => (c.pinned ? Math.max(high, c.pinnedAt) : high), 0);
  return {
    role: winner?.device === self ? 'primary' : 'secondary',
    ...(winner ? { winner } : {}),
    ...(claims.has(self) ? { own: claims.get(self)! } : {}),
    pinHigh,
  };
}

export interface LeaseDeps {
  account: AccountId;
  device: DeviceId;
  clock: Pick<Clock, 'now'>;
  channel: LeaseChannel;
  /** `ActorHost.leaseChanged`: called with every change of role, holder, expiry or pin. */
  report(account: AccountId, lease: Lease): void;
  /** Awake and the account running; otherwise `tick` neither reads nor renews, and this device acts as secondary. */
  active?: () => boolean;
  /** The host's last reported lease, for a controller made on a restart; the first read supersedes it. */
  initial?: Lease;
  /**
   * The clock gate (see the header): false once a write showed this device's clock is more than `LEASE_CLOCK_MAX_MS`
   * from the server's, or could not show it. Then the controller publishes a claim that never counts and reports
   * secondary. Absent: always eligible.
   */
  eligible?: () => boolean;
}

export interface LeaseController {
  /**
   * "Use this Mac": writes a pinned claim, then reads once more. Resolves `pinned: false` when a later pin elsewhere
   * already won (the owner's latest intent); rejects, with the pin as it was, when the claim could not be written.
   */
  claim(): Promise<{ pinned: boolean }>;
  /** Back to automatic: drops this device's pin only, so a holder stays primary by the hysteresis rule. */
  release(): Promise<void>;
  /** One round: read, decide, renew when due; from the account actor's timer (`next()` as a `DeadlineSource`). */
  tick(): Promise<void>;
  /** Quit: best effort, publishes an expired claim so the lease passes on at the next round; then does nothing. */
  stop(): Promise<void>;
  /** When `tick` next has work (a primary's give-up time included). */
  next(): number;
  /** The lease now: a primary whose published claim ran out is secondary even before the next tick. */
  current(): Lease;
}

/** `undefined` until the first read tells whether a pinned claim of ours survived a restart. */
type Pin = { at: number } | null | undefined;

function claimFor(decision: LeaseDecision, pin: Pin, now: number): LeaseClaim {
  return {
    v: 1,
    holder: decision.role === 'primary',
    until: now + LEASE_TTL_MS,
    pinned: !!pin,
    pinnedAt: pin ? pin.at : 0,
  };
}

/** A claim is rewritten when missing, not live (a clock that jumped back), a third of its TTL old, or out of date. */
function writeDue(
  own: Claim | undefined,
  ownLive: boolean,
  next: LeaseClaim,
  now: number,
): boolean {
  if (!own || !ownLive || own.until - LEASE_TTL_MS + LEASE_RENEW_MS <= now) return true;
  return own.holder !== next.holder || own.pinned !== next.pinned || own.pinnedAt !== next.pinnedAt;
}

function leaseOf(decision: LeaseDecision, pin: Pin, written?: LeaseClaim): Lease {
  const w = decision.winner;
  const until = decision.role === 'primary' && written ? written.until : w?.until;
  return {
    role: decision.role,
    ...(w ? { holder: w.device } : {}),
    ...(until !== undefined ? { until } : {}),
    pinned: !!pin,
  };
}

const sameLease = (a: Lease, b: Lease) =>
  a.role === b.role && a.holder === b.holder && a.until === b.until && a.pinned === b.pinned;

/** Our own record as the rule must see it: the last claim this process published, never a local-only one. */
function withPublished(
  raw: unknown,
  device: DeviceId,
  published: LeaseClaim | undefined,
): LeaseRecord[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  if (!published) return raw as LeaseRecord[];
  const key = leaseKey(device);
  const others = (raw as LeaseRecord[]).filter(r => r?.key !== key);
  return [...others, { key, stamp: { at: 0, gen: 0, device }, value: published }];
}

type Intent = 'pin' | 'unpin';

interface RoundResult {
  read: boolean;
  wrote?: boolean;
  decision?: LeaseDecision;
}

export function createLeaseController(deps: LeaseDeps): LeaseController {
  const { account, device, clock, channel } = deps;
  // Seeded with the host's last reported lease so a controller made after a restart still knows it holds a live
  // claim: `stop` publishes the dead claim off that (its own `published` covers only this process's writes).
  let lease: Lease = deps.initial ? { ...deps.initial } : { role: 'secondary', pinned: false };
  let pin: Pin;
  let pinDirty = false;
  /** The last claim this process wrote successfully: our record as peers see it, and when. */
  let published: LeaseClaim | undefined;
  let publishedAt = 0;
  /** A write failed: peers may hold something other than `published` (an uncertain write), so rewrite when allowed. */
  let unsure = false;
  /** The previous round asked for an immediate re-read; one in a row at most, so nothing spins. */
  let immediate = false;
  let stopped = false;
  let nextAt = 0;
  let retryAt = 0;
  let queue: Promise<unknown> = Promise.resolve();

  /** One round at a time: an owner's `claim` never interleaves with a timer `tick`. */
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };

  const report = (next: Lease) => {
    if (sameLease(next, lease)) return;
    lease = next;
    deps.report(account, { ...next });
  };

  const demote = () => report({ role: 'secondary', pinned: !!pin });

  /** Without a fresh read the role is the last one, until this device's published claim runs out. */
  const expire = (now: number) => {
    if (lease.role === 'primary' && (lease.until ?? 0) - LEASE_GIVE_UP_MS <= now) demote();
  };

  /** A pin survives a restart through our claim; a later pin elsewhere replaces ours (the latest intent). */
  const adoptPin = (decision: LeaseDecision, now: number, intent?: Intent) => {
    if (pin === undefined) pin = decision.own?.pinned ? { at: decision.own.pinnedAt } : null;
    if (intent === 'pin') {
      pin = { at: Math.max(now, decision.pinHigh + 1) };
      pinDirty = true;
    } else if (intent === 'unpin') {
      if (pin) pinDirty = true;
      pin = null;
    } else if (pin && decision.pinHigh > pin.at && decision.winner?.device !== device) {
      pin = null;
      pinDirty = true;
    }
  };

  const write = async (claim: LeaseClaim, now: number): Promise<boolean> => {
    try {
      await channel.write([{ key: leaseKey(device), value: claim }]);
      published = claim;
      publishedAt = now;
      unsure = false;
      retryAt = 0;
      return true;
    } catch {
      unsure = true;
      retryAt = now + LEASE_WRITE_RETRY_MS;
      return false;
    }
  };

  const read = async (): Promise<LeaseRecord[] | undefined> => {
    try {
      return withPublished(await channel.read(), device, published);
    } catch {
      return undefined;
    }
  };

  const gated = () => deps.eligible !== undefined && !deps.eligible();

  /** A claim that never counts: what an ineligible or quitting device publishes. */
  const deadClaim = (): LeaseClaim => ({
    v: 1,
    holder: false,
    until: 0,
    pinned: !!pin,
    pinnedAt: pin ? pin.at : 0,
  });

  /** The dead claim is rewritten when it changed or once per `LEASE_RENEW_MS` (each write re-measures the clock). */
  const deadDue = (claim: LeaseClaim, now: number): boolean => {
    if (pinDirty || unsure || !published || published.until !== 0) return true;
    if (published.pinned !== claim.pinned || published.pinnedAt !== claim.pinnedAt) return true;
    return now - publishedAt >= LEASE_RENEW_MS;
  };

  /** A round on a device the clock gate refuses: decided on the other claims only, so it is never primary. */
  const gatedRound = async (
    records: LeaseRecord[],
    now: number,
    intent?: Intent,
  ): Promise<RoundResult> => {
    const own = decideLease(records, device, now).own;
    const others = records.filter(r => r?.key !== leaseKey(device));
    const decision: LeaseDecision = {
      ...decideLease(others, device, now),
      ...(own ? { own } : {}),
    };
    adoptPin(decision, now, intent);
    const claim = deadClaim();
    let wrote: boolean | undefined;
    if (deadDue(claim, now) && (intent || now >= retryAt)) {
      wrote = await write(claim, now);
      if (wrote) pinDirty = false;
    }
    report(leaseOf(decision, pin));
    return { read: true, ...(wrote !== undefined ? { wrote } : {}), decision };
  };

  const round = async (intent?: Intent): Promise<RoundResult> => {
    const now = clock.now();
    const wasImmediate = immediate;
    immediate = false;
    nextAt = now + LEASE_ROUND_MS;
    expire(now);
    const records = await read();
    if (!records) return { read: false };
    if (gated()) return gatedRound(records, now, intent);
    const decision = decideLease(records, device, now);
    adoptPin(decision, now, intent);
    const claim = claimFor(decision, pin, now);
    const ownLive = decision.own !== undefined && isLive(decision.own, device, now);
    const due = pinDirty || unsure || writeDue(decision.own, ownLive, claim, now);
    if (!due || (!intent && now < retryAt)) {
      report(leaseOf(decision, pin));
      return { read: true, decision };
    }
    const wrote = await write(claim, now);
    if (wrote) pinDirty = false;
    // A new candidacy or pin is decided on as soon as the channel shows it, not a whole round later; a write that
    // showed the clock is off is replaced by the dead claim at once.
    if (gated()) {
      demote();
      if (!wasImmediate) nextAt = now;
      immediate = !wasImmediate;
      return { read: true, wrote, decision };
    }
    const changed = !ownLive || claim.pinned !== decision.own?.pinned;
    if (wrote && changed && !wasImmediate) {
      nextAt = now;
      immediate = true;
    }
    report(leaseOf(decision, pin, wrote ? claim : undefined));
    return { read: true, wrote, decision };
  };

  /** `claim` and `release` answer the owner: a pin that could not be written is undone and reported as an error. */
  const change = async (intent: Intent) => {
    const before = pin;
    const result = await round(intent);
    // `wrote` is undefined when nothing needed writing (a release with no pin here).
    if (result.read && result.wrote !== false) return;
    pin = before;
    pinDirty = false;
    report({ ...lease, pinned: !!pin });
    throw new Error('The lease could not be shared on the workflow channel');
  };

  const claim = async () => {
    if (stopped) return { pinned: false };
    await change('pin');
    // Re-read: a pin made elsewhere at the same moment may already have won.
    const check = await round();
    if (!check.read) return { pinned: !!pin };
    return { pinned: !!pin && check.decision?.winner?.device === device };
  };

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    if (published || lease.role === 'primary') await write(deadClaim(), clock.now());
    demote();
  };

  return {
    claim: () => serial(claim),
    release: () =>
      serial(async () => {
        // Stopped, or known to hold no pin: nothing to share.
        if (!stopped && pin !== null) await change('unpin');
      }),
    tick: () =>
      serial(async () => {
        if (stopped) return;
        // Asleep or not running: no background work here, whatever the channel last said.
        if (deps.active && !deps.active()) return demote();
        await round();
      }),
    stop: () => serial(stop),
    next: () => {
      const now = clock.now();
      // A clock that jumped back since the last round makes the next round due now.
      if (nextAt > now + LEASE_ROUND_MS) return now;
      const giveUp = lease.role === 'primary' ? (lease.until ?? 0) - LEASE_GIVE_UP_MS : Infinity;
      return Math.min(nextAt, giveUp);
    },
    current: () => {
      if (!stopped) expire(clock.now());
      return { ...lease };
    },
  };
}
