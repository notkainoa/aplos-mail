import type { ErrorClass } from '@aplos/contract';
import type {
  AccountId,
  Admission,
  BudgetId,
  BudgetSpec,
  GovernedRequest,
  ProjectScope,
  RequestKind,
  SyncLane,
} from '../ports';
import { LANES } from './budgets';
import { SlidingWindow, type Charge } from './window';

/** Throttle cooldowns: 60 s, then 5 min, then 15 min, then 1 h at most (ARCH 6.3). */
export const COOLDOWN_STEPS_MS: readonly number[] = [60_000, 300_000, 900_000, 3_600_000];
/** Quiet time that resets the escalation, starts AIMD regrowth and gives back one in-flight slot. */
export const QUIET_MS = 600_000;
/** AIMD regrows once per minute after the quiet period. */
export const REGROW_INTERVAL_MS = 60_000;
/** Transient failures of reads and idempotent writes: three tries in total, waiting 1 s then 2 s (jittered). */
export const TRANSIENT_TRIES = 3;
export const TRANSIENT_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000];
/** Google Calendar's anti-abuse `quotaExceeded` when the provider gives no time (plan 20). */
export const ANTI_ABUSE_MS = 3 * 3600_000;
/**
 * A send limit with no stated end blocks sends for an hour (proto-google 2.5: "can persist for hours"). A design
 * choice: the submission fails "until HH:MM" and the user may try again then.
 */
export const SEND_LIMIT_MS = 3600_000;
/**
 * The persisted window spend (`windowSpent`) is reserved in steps of this share of the primary target and refreshed
 * at least this often while units are spent, so `onChange` fires a few times a minute under load, not per request.
 */
export const RESERVE_STEP_SHARE = 0.1;
export const RESERVE_REFRESH_MS = 15_000;
/** A cached access token closer than this to expiry is refreshed first. */
export const TOKEN_EARLY_MS = 60_000;
/** The latest instant a Date can hold; longer waits are clamped to it. */
export const MAX_TIME = 8.64e15;

export type DeviceRole = 'primary' | 'secondary';
export type Scope = AccountId | ProjectScope;

/** What `run` may be told beyond the port: connect-time calls ignore the account's auth block (F3 `ConnectContext`). */
export interface RunMode {
  ignoreAuth?: boolean;
}

/** Live numbers that change on every request, for tests and diagnostics; never persisted. */
export interface MeterView {
  used: number;
  inFlight: number;
  inFlightLimit: number;
  target: number;
  queued: number;
}

export const KNOWN_CLASSES: ReadonlySet<string> = new Set<ErrorClass>([
  'auth',
  'permission',
  'throttle',
  'daily',
  'send_limit',
  'anti_abuse',
  'config',
  'transient',
  'permanent',
  'cancelled',
]);
/** Classes that change governor state (`GOVERNOR_CLASS_POLICY` rows whose `pauses` is not `nothing`). */
export const REFUSING: ReadonlySet<ErrorClass> = new Set<ErrorClass>([
  'throttle',
  'daily',
  'anti_abuse',
  'send_limit',
  'auth',
  'config',
]);

export interface Block {
  account: Scope;
  budget: BudgetId;
  cls: ErrorClass;
  reason: string;
  /** Absent for auth and config blocks, which end only through `clear`. */
  until?: number;
}

/** What an admitted request holds. `retry` marks the one call `retryNow` let through a cooldown. */
export interface Ticket {
  signal: AbortSignal;
  charge?: Charge;
  retry?: boolean;
}

export interface Waiter {
  req: GovernedRequest;
  mode: RunMode;
  cost: number;
  slots: number;
  queuedAt: number;
  resolve: (ticket: Ticket) => void;
  reject: (error: unknown) => void;
  detach: () => void;
}

/** A signal that never aborts, for a send or write that has no caller signal. */
export const NEVER = new AbortController().signal;

/** State of one budget of one account, or of `PROJECT` (project-wide daily stops and config blocks only). */
export class Meter {
  window: SlidingWindow;
  /** AIMD target after a refusal, before regrowth and the role's cap; undefined when not in force. */
  aimdTarget?: number;
  /**
   * End of the last throttle cooldown. It stays after the cooldown passes, as the start of the quiet period, until
   * AIMD and the in-flight limit have regrown, so a restart restores both exactly (it is the persisted quiet mark).
   */
  cooldownUntil?: number;
  cooldownStep = 0;
  cooldownReason?: string;
  /** End of a daily or anti-abuse stop. */
  blockUntil?: number;
  blockCls?: ErrorClass;
  blockReason?: string;
  /** A send limit: refuses sends only. */
  sendBlockedUntil?: number;
  sendReason?: string;
  /** `PROJECT` meters only: a config block, until `clear`. */
  stop?: { reason: string; since: number };
  lastRefusalAt?: number;
  /** In-flight limit after a concurrency refusal, before regrowth (+1 per quiet 10 minutes); undefined when lifted. */
  capBase?: number;
  /** HTTP batch size before quiet growth, and when growth (+growBy per quiet 10 minutes) started counting. */
  batchBase: number;
  batchSince: number;
  inFlight = 0;
  /** The persisted upper bound on window spend and when it was set (see `reserve`). */
  reservedSpent = 0;
  reservedAt?: number;
  /** Aborted when a pause starts; every admitted read and idempotent write's signal follows it. */
  epoch = new AbortController();
  readonly queues = new Map<SyncLane, Waiter[]>(LANES.map(lane => [lane, []]));
  timer?: { at: number; controller: AbortController };
  pauseActive = false;
  pausedAt?: number;
  /** `retryNow` granted one call through this cooldown (`retryUsedFor` is the cooldown it was granted for). */
  retryPass = false;
  retryUsedFor?: number;
  /** The "Retry now" call, parked until the calls still in flight finish: it goes alone (prov-gov-attack-09). */
  retryWaiter?: Waiter;
  lastKey = '';

  constructor(
    readonly account: Scope,
    public spec: BudgetSpec,
    public role: DeviceRole,
    now: number,
  ) {
    this.window = new SlidingWindow(spec.windowMs);
    this.batchBase = spec.batch?.start ?? 1;
    this.batchSince = now;
  }

  queued(): Waiter[] {
    return [...this.queues.values()].flat();
  }
}

/** Whether a pause may abort the request in flight: never a send or write whose bytes may have left. */
export function abortable(kind: RequestKind): boolean {
  return kind === 'read' || kind === 'idempotentWrite';
}

export const keyOf = (account: Scope, budget: BudgetId) => `${account}\u0000${budget}`;

/** Marks an error raised before `fn` ran, so `run` maps it for sends instead of classifying it as a failure. */
export class BeforeCall {
  constructor(readonly error: unknown) {}
}

export function refusalOf(block: Block | undefined): Admission {
  if (!block) return { ok: true };
  return block.until === undefined
    ? { ok: false, cls: block.cls, reason: block.reason }
    : { ok: false, cls: block.cls, reason: block.reason, until: block.until };
}

export function dropUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}
