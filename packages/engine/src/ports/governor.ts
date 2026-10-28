import type { ClassifiedError, ErrorClass } from '@aplos/contract';
import type { AccountId, Admission, BudgetId, ProjectScope, RequestKind, SyncLane } from './base';

// The governor: the single retry layer and the only door to the network (ARCH 6, plan 20 PV2).

/**
 * One budget's limits for one account. Static for Gmail, Google Calendar and Graph; for JMAP and IMAP derived from
 * the session or host table the adapter saved in `provider_memory` at connect.
 */
export interface BudgetSpec {
  id: BudgetId;
  unit: 'units' | 'requests' | 'commands' | 'bytes';
  /** Sliding window: gmail 60_000, gcal 60_000, graph 600_000, imapBytes 86_400_000. */
  windowMs: number;
  /** The provider's hard number: gmail 6,000, gcal 600, graph 10,000. */
  ceiling: number;
  /** AIMD start target by device role: gmail 4,500 primary and 1,500 secondary (ARCH 6.2, 6.5). */
  target: { primary: number; secondary: number };
  /** AIMD floor: gmail 1,000. */
  floor: number;
  /** Share of the target each lane may use; a lane left out may use none. gmail: interactive 1, opFlush 1, incremental 0.9, prefetch 0.2, backfill 0.75. */
  laneShare: Partial<Record<SyncLane, number>>;
  /** In-flight slots, and how many are kept for `interactive` and `opFlush`: gmail 3 and 1; graph 4 and 0 with priority admission. */
  inFlight: number;
  reservedInteractive: number;
  /** HTTP batch sizing (Neverest's curve): gmail start 10, min 1, max 25, grow 5. */
  batch?: { start: number; min: number; max: number; growBy: number };
}

/** One call's ticket. `cost` is on `budget`; `costs` adds other budgets the same call spends. */
export interface GovernedRequest {
  budget: BudgetId;
  lane: SyncLane;
  kind: RequestKind;
  /** Catalog method id for logs and diagnostics: `gmail.threads.get`, `oauth.token`, `imap.UID FETCH`. */
  method: string;
  cost: number;
  costs?: Partial<Record<BudgetId, number>>;
  /** In-flight weight: a Graph `$batch` of 20 takes 4. Must not exceed `inFlight - reservedInteractive` outside `interactive`. */
  slots?: number;
  /** Default true: the governor fetches the access token (`TokenSource`) and owns the one forced refresh after a first 401. */
  auth?: boolean;
  /** The caller's own cancel (actor stop, a cancelled search), merged into `RequestIo.signal`. */
  signal?: AbortSignal;
}

/** What `fn` receives: the merged signal (caller cancel, plus a pause for `read` and `idempotentWrite` only) and the token. */
export interface RequestIo { signal: AbortSignal; accessToken?: string }

/** Persisted to `governor_state` by the actor on every `onChange`, restored before the first request after a restart. */
export interface GovernorSnapshot {
  budget: BudgetId;
  target: number;
  inFlightLimit: number;
  batchSize: number;
  /** Units spent in the current window and when it started, so a restart cannot re-spend the same minute. */
  windowSpent: number;
  windowAt: number;
  cooldownUntil?: number;
  /** Escalation position: 60 s, 5 min, 15 min, 1 h; reset after 10 quiet minutes. */
  cooldownStep: number;
  dailyBlockUntil?: number;
  /** `send_limit` blocks sends only; sync continues. */
  sendBlockedUntil?: number;
  /** Ends only through `clear`. */
  blocked?: { cls: 'auth' | 'config'; since: number };
  cls?: ErrorClass;
  reason?: string;
  lastRefusalAt?: number;
}

/**
 * Implemented by `prov-gov` (`packages/engine/src/sync/governor.ts`); `eng-ai`'s AI governor shares its base class
 * for `ai:*` budgets. Called by the account actors (which bind it per account for adapters), the timer loop,
 * `Sync/request` and `SendPort`. The class-by-class policy is the Providers proposal's table (section 4).
 */
export interface GovernorPort {
  /**
   * Waits (never sends) until the budget, lane share and a slot allow the call, then runs `fn` once. Throws
   * `PausedError` before any I/O while paused or blocked. Re-sends only `transient` failures of `read` and
   * `idempotentWrite` (1, 2, 4 s jitter, each re-admitted), and any kind once after a first 401 plus one forced refresh.
   * A pause rejects queued calls and aborts in-flight `read`/`idempotentWrite` on that budget; never a started `write` or `send`.
   */
  run<T>(account: AccountId, req: GovernedRequest, fn: (io: RequestIo) => Promise<T>): Promise<T>;
  /** A refusal found inside a successful reply (a 429 part of a 200 batch): same state change as a thrown one, never aborts the caller. */
  observe(account: AccountId, budget: BudgetId, error: ClassifiedError): void;
  /** Post-hoc charge, e.g. IMAP bytes known only after the reply. */
  charge(account: AccountId, budget: BudgetId, amount: number): void;
  /** No I/O. `kind: 'send'` also checks `sendBlockedUntil`. */
  admission(account: AccountId, budget: BudgetId, lane: SyncLane, kind?: RequestKind): Admission;
  /** Current AIMD batch size (halved on a refusal, +growBy to max when quiet). */
  batchSize(account: AccountId, budget: BudgetId): number;
  /** From the lease: a secondary device runs under the secondary target. */
  setRole(account: AccountId, role: 'primary' | 'secondary'): void;
  /** After a successful reconnect or config fix: the only way out of an auth or config block. */
  clear(account: AccountId | ProjectScope, cls: 'auth' | 'config'): void;
  snapshot(account: AccountId | ProjectScope): GovernorSnapshot[];
  restore(account: AccountId | ProjectScope, snapshots: GovernorSnapshot[]): void;
  onChange(listener: (account: AccountId | ProjectScope, snapshot: GovernorSnapshot) => void): () => void;
}

/** `GovernorPort` bound to one account: the only network door an adapter gets (`AdapterContext.governor`). */
export interface BoundGovernor {
  run<T>(req: GovernedRequest, fn: (io: RequestIo) => Promise<T>): Promise<T>;
  observe(budget: BudgetId, error: ClassifiedError): void;
  charge(budget: BudgetId, amount: number): void;
  batchSize(budget: BudgetId): number;
}
