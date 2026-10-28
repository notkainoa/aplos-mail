import type { ClassifiedError, ErrorClass } from '@aplos/contract';

// Identity, lanes, request kinds and budgets: the vocabulary every other port uses (F3).

export type AccountId = string;
/** A device's stable id (the lease holder, `thread_workflow.edit_device`). */
export type DeviceId = string;
/** Mail adapters. CalDAV is not a kind: it is the `calendar` part of an `imap` or `jmap` adapter. */
export type ProviderKind = 'google' | 'microsoft' | 'imap' | 'jmap';

/**
 * The six sync lanes, highest priority first (ARCH 4.1). Named `SyncLane` because Home's `do|update|low` is also
 * called a lane (`HomeLane`, `laneFor`). AI is never a sync lane; it has its own budgets (`ai:*`).
 */
export type SyncLane =
  'interactive' | 'opFlush' | 'incremental' | 'prefetch' | 'backfill' | 'enrichment';

/**
 * What a governed call may do to remote state, which decides whether the governor may ever re-send it (ARCH 6.3).
 * `read` and `idempotentWrite` are re-sent on `transient` (1, 2, 4 s, three tries); `write` and `send` never are.
 */
export type RequestKind = 'read' | 'idempotentWrite' | 'write' | 'send';

/**
 * One rate budget, the `governor_state.budget` value. `oauth` is the token endpoint; `imapBytes` the daily byte cap
 * charged after each FETCH; `ai:<provider>:<model>` belongs to `eng-ai`'s governor, which shares the base class.
 */
export type BudgetId =
  'gmail' | 'gcal' | 'graph' | 'imap' | 'imapBytes' | 'jmap' | 'caldav' | 'oauth' | `ai:${string}`;

/** `governor_state.account_id` for project-wide blocks: `config`, and Gmail `dailyLimitExceeded` (a per-project limit). */
export const PROJECT = '*';
export type ProjectScope = typeof PROJECT;

/** The governor's no-I/O answer to "may this go out now?" (`Sync/request`, the timer loop and `SendPort` ask first). */
export type Admission =
  { ok: true } | { ok: false; cls: ErrorClass; reason: string; until?: number };

/**
 * A refusal or failure from a provider call, classified by the adapter's classifier (plan 20 section 3.3).
 * `scope: 'project'` makes the governor block every account on `PROJECT` (`config`, Gmail's per-project daily limit);
 * it sits here rather than in the F1 record because only the governor acts on it and the log already carries `class`.
 */
export class ProviderError extends Error {
  override readonly name = 'ProviderError';
  constructor(
    readonly error: ClassifiedError,
    readonly scope: 'account' | 'project' = 'account',
  ) {
    super(error.reason);
  }
}

/**
 * Thrown by `governor.run` before any I/O (token calls included) while the budget is in cooldown, a daily stop, a
 * send-limit block or an auth or config block, and by queued requests a pause rejects. An auth block applies to every
 * budget of the account; connect-time calls alone ignore it (`ConnectContext`). A send that gets it was provably not
 * sent. `until` is absent for auth and config blocks, which end only through `GovernorPort.clear`.
 */
export class PausedError extends Error {
  override readonly name = 'PausedError';
  constructor(
    readonly account: AccountId | ProjectScope,
    readonly budget: BudgetId,
    readonly cls: ErrorClass,
    readonly reason: string,
    readonly until?: number,
  ) {
    super(`paused: ${reason}`);
  }
}

/**
 * Proof that a submission's bytes never left: no connection, DNS failure, a refusal before the request was written,
 * a 4xx before acceptance, a send-limit refusal, mail over a provider's size cap. Anything else `send` throws, including
 * a plain `ProviderError` or a bug, is treated as uncertain and settled only through `findSent` (ARCH 7.1).
 */
export class NotSentError extends Error {
  override readonly name = 'NotSentError';
  constructor(readonly error: ClassifiedError) {
    super(error.reason);
  }
}
