import type { AccountId, AccountRuntime, Clock, DeviceId } from '../ports';
import { contractError } from '../runtime/errors';

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
 *    failed write keeps the role the last published claim gives, until that claim runs out or the clock reading goes
 *    stale (below).
 *
 * Handover: a holder that can no longer renew gives up `LEASE_GIVE_UP_MS` before its `until` (its own clock, and
 * `next()` wakes it then); another device takes over at `until + LEASE_SKEW_MS` (its clock). That leaves no overlap for
 * clocks within plus or minus 5 minutes of true time and a holder's tick up to one round late. Worst case, a vanished
 * holder's lease passes on `LEASE_TTL_MS + LEASE_SKEW_MS` plus one round after its last renewal (41 minutes); a quit
 * (`stop`) passes it on at the next round. The lease is soft (ARCH 6.5): a brief double primary is absorbed by AIMD.
 *
 * Clock gate: the rule above holds only for clocks within `LEASE_CLOCK_MAX_MS` of true time. After each write the host
 * brackets the server's receive time for the copy with this device's clock just before and just after the insert
 * (`clockReading`, `LeaseDeps.clockGate`). The whole bracket within the limit reads `ok`; the whole bracket beyond it
 * reads `off`; a bracket that straddles the limit, or none at all (the check failed), measures nothing
 * (`unmeasurable`). Only `off` blocks: the device publishes a claim that never counts (`holder: false, until: 0`)
 * without a pin (a pin's time would come from the wrong clock), stays secondary, and rewrites that claim once per
 * `LEASE_GATED_RENEW_MS` only, to measure again. A block holds until `LEASE_CLOCK_OK_STREAK` ok readings at least a
 * round apart (`measureClock`), and after a dead claim no live claim is written for `LEASE_RENEW_MS` (an owner's pin
 * aside), so a reading flapping around the limit stays at that cadence. An owner's "Use this Mac" needs one fresh ok
 * reading only (`ownerGate`). An `unmeasurable` write keeps the last ok reading and asks for another measuring write
 * at the next round (`remeasure`), so one failed check never demotes a primary. A device is primary only on an `ok`
 * reading younger than `LEASE_CLOCK_FRESH_MS` (`gateReading`); with none (`unmeasured`: a fresh process, or checks
 * that kept failing) it is secondary, and once a measuring write has failed or measured nothing it publishes the dead
 * claim, so a live candidacy of its can never win the lower-id rule and leave the account without a primary. A
 * measuring write that failed or measured nothing is retried after one round, backing off 1, 2, 4, then 5 minutes
 * (`LEASE_WRITE_RETRY_MS`); once that backoff has topped out, a measuring write that landed yet measured nothing again
 * is followed by the next only after `LEASE_GATED_RENEW_MS`, a blocked device's cadence (each one is a whole copy, and
 * a device whose checks always fail would otherwise write one every 5 minutes). Meanwhile it checks the last copy's
 * receive time again every `LEASE_WRITE_RETRY_MS` without writing (`LeaseChannel.probe`, one 20-unit get); the first
 * probe that measures ends the slow wait at once, so a check that failed for a while (Gmail's gets failing while its
 * inserts work) costs a primary at most one probe interval after it recovers. Such a device, like a blocked one,
 * compacts its own superseded copies after each write. "Use this Mac" is refused unless the gate reads `ok` after one
 * fresh measuring write.
 *
 * A pin is published by the very write that measures the clock, so a clock that went off since its last reading shows
 * only after that write; the next round (at once) replaces the claim with the dead one, without the pin. That one
 * round errs safe: peers judge its `until` and `pinnedAt` by their own clocks (rule 1), so a fast clock's pin is
 * ignored as absurd and a slow one's loses to any later pin.
 *
 * "Use this Mac" on device B overlaps the old primary A until A's next *successful* read shows B's pin: one round when
 * A's reads work, but up to A's own give-up time (`until - LEASE_GIVE_UP_MS`, about 28 minutes after its last renewal)
 * when A's reads fail or its data key is locked, since A then keeps the role its last published claim gives.
 *
 * A clock set back: every wait is kept with the clock reading it started at, and a reading earlier than that ends it at
 * once (`Wait`: the retry backoff and the probe interval; the dead claim's cadence and the cool-down after it go by
 * `publishedAt` the same way; `next()` makes a round due at once when its time is more than a round ahead). An ok
 * reading from "the future" is no reading, and is forgotten the first time the clock is seen behind it
 * (`forgetFuture`, by the host before every gate read), so it never comes back to life when the clock catches up with
 * it, and the next round measures again. A jump of hours costs
 * one measuring write, never hours without renewals or probes. A jump forward simply makes them due.
 *
 * Cost per device and account: one gated channel read a round (`LEASE_ROUND_MS`; about 2 Gmail units when nothing
 * changed), and a claim rewrite every `LEASE_RENEW_MS` (or on a role or pin change). On Gmail a rewrite is one sealed
 * whole-view copy (`messages.insert`, 25 units) plus the receive-time check (`messages.get` minimal, 20); the primary
 * then compacts what the copy supersedes (one 60-unit read-back per written copy, 20 per copy trashed, at most 25 a
 * call). About 120 + 6 x 45 = 390 units an hour per idle device, plus the primary's compaction. A blocked device, and
 * one whose checks keep measuring nothing once its backoff tops out, writes twice an hour and compacts only its own
 * superseded copies, so its copies never pile up: an own copy whose digest the Gmail channel no longer holds is trashed
 * by id on a floor readers honour, and otherwise downloaded once more to match it, at most 3 per compaction (60 units
 * each, once per such copy, `OWN_REREADS` in `workflow-state.ts`). One that still holds a record the new copy lacks
 * stays on the label.
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
/** A blocked device rewrites its dead claim this often, only to measure its clock again. */
export const LEASE_GATED_RENEW_MS = LEASE_TTL_MS;
/**
 * An ok reading is trusted this long: a renewal re-measures every `LEASE_RENEW_MS`, plus slack for a late tick, so a
 * healthy primary never sees its reading go stale; one whose renewal failed does.
 */
export const LEASE_CLOCK_FRESH_MS = LEASE_RENEW_MS + LEASE_GIVE_UP_MS;
/** Ok readings in a row, at least `LEASE_ROUND_MS` apart, that lift a block. */
export const LEASE_CLOCK_OK_STREAK = 2;
/** After a failed write, the next try waits this long (four tries fit in the slack before the claim expires). */
export const LEASE_WRITE_RETRY_MS = 5 * 60_000;
/** Measuring writes on the 1, 2, 4, 5-minute backoff before one that lands but measures nothing waits the slow cadence. */
export const LEASE_MEASURE_BACKOFF_STEPS = 4;
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
  /** The receive-time check on the last copy written, again (no new copy): true when it measured. Never throws. */
  probe?(): Promise<boolean>;
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

/**
 * This device's clock minus the server's receive time for a copy it just wrote, as a bracket: `lowMs` from this
 * device's clock just before the insert went out, `highMs` from just after it returned (the receive time lies between).
 */
export interface ClockOffset {
  lowMs: number;
  highMs: number;
}

/**
 * The clock gate's reading: `ok`, `off` (beyond `LEASE_CLOCK_MAX_MS`), `unmeasurable` (one write's check told nothing;
 * never a gate state) or `unmeasured` (no fresh ok reading). Only `off` blocks the device.
 */
export type ClockReading = 'ok' | 'off' | 'unmeasurable' | 'unmeasured';

/**
 * One write's reading: `ok` when the whole bracket is within the limit and `off` when the whole bracket is beyond it,
 * whatever its width (a slow insert only widens it); a bracket across the limit, or none, is `unmeasurable`.
 */
export function clockReading(offset: ClockOffset | undefined): ClockReading {
  if (!offset || !Number.isFinite(offset.lowMs) || !Number.isFinite(offset.highMs))
    return 'unmeasurable';
  const { lowMs, highMs } = offset;
  if (highMs < lowMs) return 'unmeasurable';
  if (lowMs > LEASE_CLOCK_MAX_MS || highMs < -LEASE_CLOCK_MAX_MS) return 'off';
  return lowMs >= -LEASE_CLOCK_MAX_MS && highMs <= LEASE_CLOCK_MAX_MS ? 'ok' : 'unmeasurable';
}

const blocks = (reading: ClockReading) => reading === 'off';

/** What the host keeps of this device's clock between writes (and across a 'restart'). */
export interface ClockGate {
  /** Set by an off reading; held until `LEASE_CLOCK_OK_STREAK` ok readings a round apart. */
  blocked?: 'off';
  /** Ok readings counted toward lifting the block. */
  okStreak: number;
  /** When the last counted ok reading was taken (this device's clock). */
  okAt?: number;
  /** The last write measured nothing: measure again at the next round, before the last ok reading goes stale. */
  remeasure?: boolean;
}

export const unmeasuredGate = (): ClockGate => ({ okStreak: 0 });

/**
 * The gate once an ok reading from "the future" is forgotten: a clock set back (it now reads before the reading was
 * taken) proves nothing about the clock it has now, and must not come back to life when that clock catches up with it.
 * A block stays, with its count of ok readings started over.
 */
export function forgetFuture(gate: ClockGate, now: number): ClockGate {
  if (gate.okAt === undefined || gate.okAt <= now) return gate;
  return gate.blocked ? { blocked: gate.blocked, okStreak: 0 } : { okStreak: 0 };
}

/**
 * `holder`'s gate with an ok reading from the future forgotten (also in the gate an owner's lift will restore). The
 * host reads every gate through here, so the reading is gone before the clock catches up with it, whatever the checks
 * did meanwhile.
 */
export function gateNow(
  holder: { gate: ClockGate; ownerLift?: ClockGate },
  now: number,
): ClockGate {
  const gate = forgetFuture(holder.gate, now);
  if (gate === holder.gate) return gate;
  if (holder.ownerLift) holder.ownerLift = forgetFuture(holder.ownerLift, now);
  holder.gate = gate;
  return gate;
}

/** The gate after one write's measurement at `now` (hysteresis: see the header). */
export function measureClock(
  gate: ClockGate,
  offset: ClockOffset | undefined,
  now: number,
): ClockGate {
  const reading = clockReading(offset);
  gate = forgetFuture(gate, now);
  if (reading === 'off') return { blocked: 'off', okStreak: 0 };
  // Nothing learned: a block stays a block, and an ok reading stays until it ages out.
  if (reading === 'unmeasurable') return { ...gate, remeasure: !gate.blocked };
  if (!gate.blocked) return { okStreak: 1, okAt: now };
  const apart = gate.okAt === undefined || now - gate.okAt >= LEASE_ROUND_MS;
  if (!apart) return gate;
  const okStreak = gate.okStreak + 1;
  if (okStreak >= LEASE_CLOCK_OK_STREAK) return { okStreak, okAt: now };
  return { blocked: gate.blocked, okStreak, okAt: now };
}

/** The gate as the lease reads it at `now`: blocked, `ok` while the last ok reading is fresh, else `unmeasured`. */
export function gateReading(gate: ClockGate, now: number): ClockReading {
  if (gate.blocked) return gate.blocked;
  if (gate.okAt === undefined) return 'unmeasured';
  const age = now - gate.okAt;
  return age >= 0 && age < LEASE_CLOCK_FRESH_MS ? 'ok' : 'unmeasured';
}

/** The next round should write to measure: no fresh ok reading, or the last write measured nothing. */
export function needsMeasure(gate: ClockGate, now: number): boolean {
  return gateReading(gate, now) === 'unmeasured' || (!gate.blocked && gate.remeasure === true);
}

/**
 * The gate as an owner's "Use this Mac" may use it: a block whose latest reading, taken within the last round, was ok
 * is lifted (the hysteresis guards automatic claims only, and the owner just fixed the clock).
 */
export function ownerGate(gate: ClockGate, now: number): ClockGate {
  if (!gate.blocked || gate.okAt === undefined) return gate;
  const age = now - gate.okAt;
  if (age < 0 || age >= LEASE_ROUND_MS) return gate;
  return { okStreak: LEASE_CLOCK_OK_STREAK, okAt: gate.okAt };
}

/** The owner's "Use this Mac" refused because of this device's clock (the sentence the UI shows). */
function clockRefusal(reading: ClockReading): Error {
  const message =
    reading === 'off'
      ? "This Mac's clock is off by more than 5 minutes, so it cannot be the main Mac. Fix the clock and try again."
      : 'This Mac could not check its clock against the server yet, so it cannot be the main Mac. Try again in a minute.';
  return contractError({ type: 'unavailable', message });
}

/** The owner's "Use this Mac" interrupted by the account restarting (the sentence the UI shows). */
function restartRefusal(): Error {
  const message = 'The account restarted before this Mac could be set as the main Mac. Try again.';
  return contractError({ type: 'unavailable', message });
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
   * The clock gate (see the header), read before and after every write. While it blocks, the controller publishes a
   * claim that never counts, drops its pin and reports secondary; `claim` is refused unless it reads `ok`. Absent:
   * always `ok`.
   */
  clockGate?: () => ClockReading;
  /** The last write measured nothing, or no ok reading is fresh: write at the next allowed round to measure. */
  remeasure?: () => boolean;
  /** The gate for an owner's pin (`ownerGate`): may lift a block on one fresh ok reading. Absent: `clockGate`. */
  ownerClock?: () => ClockReading;
  /** A 'restart' replaced this controller: an owner's `claim` that finishes now is refused (its pin is not confirmed). */
  stale?: () => boolean;
}

export interface LeaseController {
  /**
   * "Use this Mac": writes a pinned claim, then reads once more. Resolves `pinned: false` when a later pin elsewhere
   * already won (the owner's latest intent); rejects, with the pin as it was, when the claim could not be written,
   * and with a `ContractError` (no pin) when the clock gate does not read `ok` after a fresh measurement.
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

/**
 * A wait on this device's clock, from `from` until `at`. A clock that jumped back before `from` ends it at once, as
 * `deadDue` treats a claim published "in the future": a backwards jump never freezes a retry or a probe for the
 * length of the jump.
 */
interface Wait {
  from: number;
  at: number;
}

const NO_WAIT: Wait = { from: 0, at: 0 };
const waitFor = (now: number, ms: number): Wait => ({ from: now, at: now + ms });
const waiting = (wait: Wait, now: number): boolean => now >= wait.from && now < wait.at;

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
  /** The backoff after a failed or unmeasured write: no automatic write while it waits. */
  let retry = NO_WAIT;
  /** The published dead claim was written under an `off` block (the cool-down after it applies; `coolingDown`). */
  let deadWhileOff = false;
  /** Measuring writes failed in a row: their retry backs off from one round to `LEASE_WRITE_RETRY_MS`. */
  let measureFails = 0;
  /** The pending retry is the slow one (`LEASE_GATED_RENEW_MS`): `probe` may end it early, once `probeWait` ends. */
  let slow = false;
  let probeWait = NO_WAIT;
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

  const reading = (): ClockReading => deps.clockGate?.() ?? 'ok';
  const gated = () => blocks(reading());

  /**
   * Without a fresh read the role is the last one, until this device's published claim runs out or its clock reading
   * is no longer a fresh `ok` (a primary only ever acts on a checked clock).
   */
  const expire = (now: number) => {
    if (lease.role !== 'primary') return;
    if ((lease.until ?? 0) - LEASE_GIVE_UP_MS <= now || reading() !== 'ok') demote();
  };

  /** The decision as this device may act on it: primary only on a fresh `ok` clock reading. */
  const trusted = (decision: LeaseDecision): LeaseDecision =>
    reading() === 'ok' ? decision : { ...decision, role: 'secondary' };

  const remeasure = (): boolean => deps.remeasure?.() ?? reading() === 'unmeasured';
  /**
   * No fresh ok reading, and a measuring write already failed or measured nothing: publish the dead claim (a live
   * candidacy could win the lower-id rule and leave the account with no primary), measuring again on the backoff.
   */
  const unproven = (): boolean => reading() === 'unmeasured' && measureFails > 0;
  const ownerReading = (): ClockReading => deps.ownerClock?.() ?? reading();

  /**
   * A measuring write that failed or measured nothing is retried after one round, doubling up to
   * `LEASE_WRITE_RETRY_MS`; any other failed write after that. Once the backoff has topped out, a measuring write that
   * landed (a whole copy) and measured nothing again waits `LEASE_GATED_RENEW_MS`; a failed one keeps the 5 minutes,
   * so a device back online measures soon.
   */
  const retryDelay = (landed: boolean): number => {
    if (!remeasure()) return LEASE_WRITE_RETRY_MS;
    slow = landed && measureFails >= LEASE_MEASURE_BACKOFF_STEPS;
    const delay = slow
      ? LEASE_GATED_RENEW_MS
      : Math.min(LEASE_ROUND_MS * 2 ** measureFails, LEASE_WRITE_RETRY_MS);
    measureFails++;
    return delay;
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
      slow = false;
      if (remeasure()) {
        retry = waitFor(now, retryDelay(true));
      } else {
        retry = NO_WAIT;
        measureFails = 0;
      }
      probeWait = waitFor(now, LEASE_WRITE_RETRY_MS);
      return true;
    } catch {
      unsure = true;
      slow = false;
      retry = waitFor(now, retryDelay(false));
      return false;
    }
  };

  /** During the slow wait, a probe every `LEASE_WRITE_RETRY_MS`; one that measures makes the retry due now. */
  const probeSlowWait = async (now: number): Promise<void> => {
    if (!slow || !waiting(retry, now) || waiting(probeWait, now) || !channel.probe) return;
    probeWait = waitFor(now, LEASE_WRITE_RETRY_MS);
    if (!(await channel.probe())) return;
    slow = false;
    retry = NO_WAIT;
  };

  const read = async (): Promise<LeaseRecord[] | undefined> => {
    try {
      return withPublished(await channel.read(), device, published);
    } catch {
      return undefined;
    }
  };

  /** A claim that never counts: what an ineligible or quitting device publishes. */
  const deadClaim = (): LeaseClaim => ({
    v: 1,
    holder: false,
    until: 0,
    pinned: !!pin,
    pinnedAt: pin ? pin.at : 0,
  });

  /**
   * The dead claim is rewritten when it changed, or once per `LEASE_GATED_RENEW_MS` to measure the clock again (a
   * clock jumped back counts as due). Not every `LEASE_RENEW_MS`: nobody compacts a blocked device's copies but itself.
   */
  const deadDue = (claim: LeaseClaim, now: number): boolean => {
    if (pinDirty || unsure || !published || published.until !== 0) return true;
    if (published.pinned !== claim.pinned || published.pinnedAt !== claim.pinnedAt) return true;
    return now - publishedAt >= LEASE_GATED_RENEW_MS || now < publishedAt;
  };

  /** After a dead claim written while off, no automatic live claim for `LEASE_RENEW_MS` (a flapping reading's cadence). */
  const coolingDown = (now: number): boolean =>
    deadWhileOff &&
    published?.until === 0 &&
    now >= publishedAt &&
    now - publishedAt < LEASE_RENEW_MS;

  /**
   * A round on a device the clock gate refuses, or whose clock is unproven (`unproven`): decided on the other claims
   * only, so it is never primary, and it publishes the dead claim. Its pin goes:
   * the pin's time came from this clock, so a stale pin must never win once the gate opens again.
   */
  const gatedRound = async (
    records: LeaseRecord[],
    now: number,
    intent: Intent | undefined,
    measure: boolean,
  ): Promise<RoundResult> => {
    const own = decideLease(records, device, now).own;
    const others = records.filter(r => r?.key !== leaseKey(device));
    const decision: LeaseDecision = {
      ...decideLease(others, device, now),
      ...(own ? { own } : {}),
    };
    adoptPin(decision, now, intent);
    if (pin) pinDirty = true;
    pin = null;
    const claim = deadClaim();
    const off = gated();
    let wrote: boolean | undefined;
    const due = measure || deadDue(claim, now);
    if (due && (intent || measure || !waiting(retry, now))) {
      wrote = await write(claim, now);
      if (wrote) pinDirty = false;
      if (wrote) deadWhileOff = off;
    }
    report(leaseOf(decision, pin));
    return { read: true, ...(wrote !== undefined ? { wrote } : {}), decision };
  };

  /** An unproven clock measures again with its dead claim once the backoff allows. */
  const measureDead = (measure: boolean, now: number): boolean =>
    measure || (unproven() && !waiting(retry, now));

  /** An automatic live write waits for the retry backoff and the cool-down after an `off` block. */
  const held = (now: number): boolean => waiting(retry, now) || coolingDown(now);

  /** `measure`: write even when nothing is due, so the write measures the clock (the owner's "Use this Mac"). */
  const round = async (intent?: Intent, measure = false): Promise<RoundResult> => {
    const now = clock.now();
    const wasImmediate = immediate;
    immediate = false;
    nextAt = now + LEASE_ROUND_MS;
    expire(now);
    await probeSlowWait(now);
    const records = await read();
    if (!records) return { read: false };
    if (gated() || unproven()) return gatedRound(records, now, intent, measureDead(measure, now));
    const decision = decideLease(records, device, now);
    adoptPin(decision, now, intent);
    const claim = claimFor(decision, pin, now);
    const ownLive = decision.own !== undefined && isLive(decision.own, device, now);
    // No fresh reading (a fresh process, a failed renewal): write now, so the clock is checked before this device
    // acts on the claim.
    const force = measure || pinDirty || unsure || remeasure();
    const due = force || writeDue(decision.own, ownLive, claim, now);
    if (!due || (!intent && !measure && held(now))) {
      report(leaseOf(trusted(decision), pin));
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
    report(leaseOf(trusted(decision), pin, wrote ? claim : undefined));
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

  /** A pin's time is this device's clock: only a clock the gate reads `ok` may set one (one fresh write measures it). */
  const refuseUnlessMeasured = async () => {
    if (ownerReading() !== 'ok') await round(undefined, true);
    const now = ownerReading();
    if (now !== 'ok') throw clockRefusal(now);
  };

  const claim = async () => {
    if (stopped) return { pinned: false };
    await refuseUnlessMeasured();
    await change('pin');
    // Replaced while the pin was being written: the new controller owns the claim now, and nothing here confirms it.
    if (deps.stale?.()) throw restartRefusal();
    // Re-read: a pin made elsewhere at the same moment may already have won. If the pin's own write showed the clock
    // is off, this round drops the pin again and the owner hears why.
    const check = await round();
    const after = reading();
    if (blocks(after)) throw clockRefusal(after);
    if (deps.stale?.()) throw restartRefusal();
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
