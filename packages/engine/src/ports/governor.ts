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
  /**
   * Share of the target each lane may use; a lane left out may use none, so every lane the adapter plans needs one.
   * gmail: interactive 1, opFlush 1, incremental 0.9, prefetch 0.2, backfill 0.75, enrichment 0.1 (the workflow round,
   * which keeps the lease and Done/Later moving and also runs on a secondary device).
   */
  laneShare: Partial<Record<SyncLane, number>>;
  /**
   * In-flight slots, and how many are kept for `interactive` and `opFlush`: gmail 3 and 1; graph 4 and 0 with priority
   * admission. After a concurrency refusal (`ClassifiedError.concurrency`) the live limit (`inFlightLimit`) drops to 1
   * and grows back by 1 per 10 quiet minutes up to `inFlight`. The reserve is always min(`reservedInteractive`,
   * `inFlightLimit` - 1), so a limit of 1 reserves nothing and no lane is starved.
   */
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
  /**
   * In-flight weight: a Graph `$batch` of 20 takes 4. Clamped to the current `inFlightLimit`, so a request heavier than
   * the limit is still admitted and runs alone rather than never.
   */
  slots?: number;
  /** Default true: the governor fetches the access token (`TokenSource`) and owns the one forced refresh after a first 401. */
  auth?: boolean;
  /** The caller's own cancel (actor stop, a cancelled search), merged into `RequestIo.signal`. */
  signal?: AbortSignal;
}

/** What `fn` receives: the merged signal (caller cancel, plus a pause for `read` and `idempotentWrite` only) and the token. */
export interface RequestIo {
  signal: AbortSignal;
  accessToken?: string;
}

/**
 * Persisted to `governor_state` by the actor on every `onChange`, restored before the first request after a restart.
 * Snapshots are per budget, but an `auth` block is the account's: it is written to every budget of that account
 * (gmail, gcal, oauth) and `clear(account, 'auth')` lifts all of them.
 */
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
  /** Ends only through `clear`. `since` is `governor_state.blocked_since`. */
  blocked?: { cls: 'auth' | 'config'; since: number };
  cls?: ErrorClass;
  reason?: string;
  lastRefusalAt?: number;
}

/**
 * The governor's whole class-by-class policy (ARCH 6.3), frozen here: `GOVERNOR_CLASS_POLICY` is the machine-checked
 * half, so a new F1 `ErrorClass` fails the typecheck until it has a row, and the table below is the rest.
 *
 * - `throttle`: a cooldown on that budget for max(`retryAfterMs`, the escalation 60 s, 5 min, 15 min, 1 h; reset after
 *   10 quiet minutes). The AIMD target halves (never below `floor`) and regrows after 10 quiet minutes; `concurrency`
 *   drops `inFlightLimit` to 1 and halves the batch size. Not re-sent; `retryNow` admits one call per pause. Shows as
 *   `paused(until, 'throttle')` for a mail budget, per calendar for `gcal` and `caldav` (D12).
 * - `daily`: stops the budget until `resumeAt`; with `scope: 'project'` (Gmail `dailyLimitExceeded`) every account on
 *   `PROJECT`. Never re-sent. `paused(until, 'daily')`.
 * - `send_limit`: sets `sendBlockedUntil`, so `admission(.., 'send')` refuses until then; sync and every other kind go
 *   on. Never re-sent. The status does not change; the submission is `failed` "until HH:MM" (D7).
 * - `anti_abuse`: a cooldown of hours on that budget only (Google Calendar `quotaExceeded`). Never re-sent. Per
 *   calendar for a calendar budget, never the mail status (D12).
 * - `auth`: after a first 401, one forced token refresh and one re-send; otherwise `blocked` on every budget of the
 *   account, token calls included, until `clear(account, 'auth')`. `needsReauth`.
 * - `permission`: nothing on the budget; the gap is recorded as `AccountRuntime.missingPermissions`. Never re-sent.
 *   `needsPermission` only when the core mail scope is missing.
 * - `config`: `blocked` on `PROJECT` until `clear(PROJECT, 'config')`. Never re-sent. `misconfigured` on every account
 *   of the provider.
 * - `transient`: `read` and `idempotentWrite` are re-sent at 1, 2 and 4 s with jitter, each re-admitted; a `write` is
 *   `OpOutcome` `failed` with `uncertain`; a `send` is uncertain (`SendPort`, settled by `findSent`). `offline` while
 *   the network is down.
 * - `permanent`: nothing on the budget; the item fails alone (quarantine, `NotSentError` for a send). Never re-sent.
 * - `cancelled`: nothing; the caller's own abort, or a pause aborting a `read`, is never counted as a refusal.
 *
 * An edit that raced a remote change is a result (`CalendarWriteResult.conflict`, `DraftSaveResult.conflict`), not a
 * class. A class this engine does not know (the F1 enum is open) is treated as `transient`.
 */
export const GOVERNOR_CLASS_POLICY = {
  throttle: { pauses: 'budget', resend: 'never' },
  daily: { pauses: 'budget', resend: 'never' },
  send_limit: { pauses: 'sends', resend: 'never' },
  anti_abuse: { pauses: 'budget', resend: 'never' },
  auth: { pauses: 'account', resend: 'onceAfterRefresh' },
  permission: { pauses: 'nothing', resend: 'never' },
  config: { pauses: 'project', resend: 'never' },
  transient: { pauses: 'nothing', resend: 'readAndIdempotentWrite' },
  permanent: { pauses: 'nothing', resend: 'never' },
  cancelled: { pauses: 'nothing', resend: 'never' },
} as const satisfies Record<
  ErrorClass,
  {
    /** What a refusal of this class blocks: one budget (`daily` with `scope: 'project'` blocks it on `PROJECT`), sends only, every budget of the account, or every account. */
    pauses: 'budget' | 'sends' | 'account' | 'project' | 'nothing';
    resend: 'never' | 'onceAfterRefresh' | 'readAndIdempotentWrite';
  }
>;

/**
 * Implemented by `prov-gov` (`packages/engine/src/sync/governor.ts`); `eng-ai`'s AI governor shares its base class
 * for `ai:*` budgets. Called by the account actors (which bind it per account for adapters), the timer loop,
 * `Sync/request` and `SendPort`. Each class's action is `GOVERNOR_CLASS_POLICY` and the table above it.
 */
export interface GovernorPort {
  /**
   * Waits (never sends) until the budget, lane share and a slot allow the call, then runs `fn` once. Throws
   * `PausedError` before any I/O while paused or blocked; an `auth` block covers every budget of the account, token
   * calls included. Re-sends only `transient` failures of `read` and `idempotentWrite` (1, 2, 4 s jitter, each
   * re-admitted), and any kind once after a first 401 plus one forced refresh. A pause rejects queued calls and aborts
   * in-flight `read`/`idempotentWrite` on that budget; never a started `write` or `send`.
   *
   * For `kind: 'send'`, anything thrown before `fn` is invoked (the token refresh's network error, `invalid_grant`, a
   * pause that began while queued) is proof the mail never left: it surfaces as `PausedError` when a block or pause
   * caused it (including the auth block `invalid_grant` sets) and as `NotSentError` otherwise, never as a plain
   * `ProviderError`, so `SendPort` does not treat it as uncertain.
   *
   * Connect-time calls (`ConnectContext.governor`, the code exchange on `oauth`) ignore `auth` blocks, since a reconnect
   * is how an auth block ends, but still honour cooldowns, daily stops and `config` blocks.
   */
  run<T>(account: AccountId, req: GovernedRequest, fn: (io: RequestIo) => Promise<T>): Promise<T>;
  /**
   * A refusal found inside a successful reply (a 429 part of a 200 batch): same state change as a thrown one, never
   * aborts the caller. `scope` as on `ProviderError` (`project`: Gmail's `dailyLimitExceeded` in a batch part blocks every
   * account). Called after `run` resolves, never from inside `fn`, so the refusal is not counted against the call itself.
   */
  observe(
    account: AccountId,
    budget: BudgetId,
    error: ClassifiedError,
    scope?: 'account' | 'project',
  ): void;
  /** Post-hoc charge, e.g. IMAP bytes known only after the reply. */
  charge(account: AccountId, budget: BudgetId, amount: number): void;
  /** No I/O. `kind: 'send'` also checks `sendBlockedUntil`. */
  admission(account: AccountId, budget: BudgetId, lane: SyncLane, kind?: RequestKind): Admission;
  /** Current AIMD batch size (halved on a refusal, +growBy to max when quiet). */
  batchSize(account: AccountId, budget: BudgetId): number;
  /**
   * "Retry now" (`Sync/request` `force`, through `AccountActorHost.request`). During a `throttle` cooldown on `budget`,
   * lets the next `run` on that budget pass the cooldown once and keeps `cooldownStep`, so a new refusal escalates as
   * usual. At most once per pause: a second call in the same cooldown, or any other block (daily, send_limit,
   * anti_abuse, auth, config), returns the refusing `Admission` and changes nothing. `{ ok: true }` when not paused. No I/O.
   */
  retryNow(account: AccountId, budget: BudgetId): Admission;
  /** From the lease: a secondary device runs under the secondary target. */
  setRole(account: AccountId, role: 'primary' | 'secondary'): void;
  /** After a successful reconnect or config fix: the only way out of an auth or config block. */
  clear(account: AccountId | ProjectScope, cls: 'auth' | 'config'): void;
  snapshot(account: AccountId | ProjectScope): GovernorSnapshot[];
  restore(account: AccountId | ProjectScope, snapshots: GovernorSnapshot[]): void;
  onChange(
    listener: (account: AccountId | ProjectScope, snapshot: GovernorSnapshot) => void,
  ): () => void;
}

/**
 * `GovernorPort` bound to one account: the only network door an adapter gets (`AdapterContext.governor`). The one bound
 * into `ConnectContext` is built for connect and ignores the account's `auth` block (see `GovernorPort.run`).
 */
export interface BoundGovernor {
  run<T>(req: GovernedRequest, fn: (io: RequestIo) => Promise<T>): Promise<T>;
  observe(budget: BudgetId, error: ClassifiedError, scope?: 'account' | 'project'): void;
  charge(budget: BudgetId, amount: number): void;
  batchSize(budget: BudgetId): number;
}
