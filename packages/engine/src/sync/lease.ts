import type { AccountId, AccountRuntime, Clock, DeviceId } from '../ports';

/**
 * The primary-device lease (ARCH 6.5, 13.1; plan 20 PV3): one device per account runs backfill, prefetch, background
 * AI and workflow compaction; the others stay at or under the secondary target. It rides the workflow channel as one
 * record per device, `lease:<deviceId>` = `LeaseClaim`, so every device sees every live claim and applies one rule to
 * the same set (the channel merges records last-writer-wins and never interprets them):
 *
 * 1. A claim counts when it is well formed, written by the device its key names, and live: `until` is ahead of the
 *    reader's clock by more than `-LEASE_SKEW_MS` (another device's claim), or by more than `LEASE_ROUND_MS` (this
 *    device's own, so a holder gives up before anyone else can take over), and not absurdly far ahead (a broken
 *    clock). The skew margin stands in for a server clock: the channel carries only the writers' own clocks.
 * 2. Among live claims a pin wins, the latest `pinnedAt` first ("Use this Mac" is the owner's latest intent); then a
 *    claim that already holds (`holder: true`), so a primary keeps the lease while its claim is live (hysteresis); then
 *    the lower DeviceId. Ties at every step go to the lower DeviceId.
 * 3. A device is primary only when its own claim, as read from the channel, wins: it never promotes on a claim others
 *    have not been able to see. So two devices starting together both write a candidacy first and converge on the
 *    lower id the round after, and a failed write keeps the role the last written claim gives, until it expires.
 *
 * The lease is soft (ARCH 6.5): if two devices briefly both act as primary, AIMD and cooldowns absorb it.
 */

/** ARCH 6.5: a 30-minute TTL. */
export const LEASE_TTL_MS = 30 * 60_000;
/** A claim is rewritten once a third of its TTL has passed, so a live device's claim never comes near expiry. */
export const LEASE_RENEW_MS = LEASE_TTL_MS / 3;
/**
 * The clock difference between two devices the rule tolerates without a steal or an overlap: each device within
 * plus or minus 5 minutes of true time. A device offline longer than the TTL plus this margin loses the lease.
 */
export const LEASE_SKEW_MS = 10 * 60_000;
/** How often `tick` reads the channel (one gated round: the channel's idle cost when nothing changed). */
export const LEASE_ROUND_MS = 60_000;
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
  if (!DEVICE_RE.test(device) || record.stamp?.device !== device) return;
  const v = record.value;
  if (!isClaimValue(v)) return;
  return {
    v: 1,
    holder: v.holder,
    until: v.until,
    pinned: v.pinned,
    pinnedAt: v.pinnedAt,
    device,
    stamp: record.stamp,
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

function isLive(claim: Claim, self: DeviceId, now: number): boolean {
  if (claim.until > now + LEASE_TTL_MS + LEASE_SKEW_MS) return false;
  if (claim.device === self) return claim.until - LEASE_ROUND_MS > now;
  return claim.until + LEASE_SKEW_MS > now;
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
  /** Awake and the account running; `tick` neither reads nor renews otherwise. */
  active?: () => boolean;
}

export interface LeaseController {
  /** "Use this Mac": pins this device; it becomes primary the round after the pinned claim is written. */
  claim(): Promise<void>;
  /** Back to automatic: drops this device's pin only, so a holder stays primary by the hysteresis rule. */
  release(): Promise<void>;
  /** One round: read, decide, renew when due; from the account actor's timer (`next()` as a `DeadlineSource`). */
  tick(): Promise<void>;
  /** When `tick` next has work. */
  next(): number;
  current(): Lease;
}

/** `undefined` until the first read tells whether a live pinned claim of ours survived a restart. */
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

type Intent = 'pin' | 'unpin';

interface RoundResult {
  read: boolean;
  wrote?: boolean;
}

export function createLeaseController(deps: LeaseDeps): LeaseController {
  const { account, device, clock, channel } = deps;
  let lease: Lease = { role: 'secondary', pinned: false };
  let pin: Pin;
  let pinDirty = false;
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

  /** Without a fresh read the role is the last one, until this device's own claim runs out. */
  const expire = (now: number) => {
    if (lease.role === 'primary' && (lease.until ?? 0) - LEASE_ROUND_MS <= now)
      report({ role: 'secondary', pinned: !!pin });
  };

  /** A pin survives a restart through our live claim; a later pin elsewhere replaces ours (the latest intent). */
  const adoptPin = (decision: LeaseDecision, now: number, intent?: Intent) => {
    const own = decision.own;
    if (pin === undefined)
      pin = own?.pinned && isLive(own, device, now) ? { at: own.pinnedAt } : null;
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
      retryAt = 0;
      return true;
    } catch {
      retryAt = now + LEASE_WRITE_RETRY_MS;
      return false;
    }
  };

  const round = async (intent?: Intent): Promise<RoundResult> => {
    const now = clock.now();
    nextAt = now + LEASE_ROUND_MS;
    let records: readonly LeaseRecord[];
    try {
      records = await channel.read();
    } catch {
      expire(now);
      return { read: false };
    }
    const decision = decideLease(records, device, now);
    adoptPin(decision, now, intent);
    const claim = claimFor(decision, pin, now);
    const ownLive = decision.own !== undefined && isLive(decision.own, device, now);
    const due = pinDirty || writeDue(decision.own, ownLive, claim, now);
    if (!due || (!intent && now < retryAt)) {
      report(leaseOf(decision, pin));
      return { read: true };
    }
    const wrote = await write(claim, now);
    if (wrote) pinDirty = false;
    // A new candidacy or pin is decided on as soon as the channel shows it, not a whole round later.
    if (wrote && (!ownLive || claim.pinned !== decision.own?.pinned)) nextAt = now;
    report(leaseOf(decision, pin, wrote ? claim : undefined));
    return { read: true, wrote };
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

  return {
    claim: () => serial(() => change('pin')),
    release: () =>
      serial(async () => {
        // Known to hold no pin: nothing to share.
        if (pin !== null) await change('unpin');
      }),
    tick: () =>
      serial(async () => {
        if (deps.active && !deps.active()) return expire(clock.now());
        await round();
      }),
    // A clock that jumped back since the last round makes the next round due now.
    next: () => (nextAt > clock.now() + LEASE_ROUND_MS ? clock.now() : nextAt),
    current: () => ({ ...lease }),
  };
}
