/**
 * Provisional copy of the proposed F3 ports; replaced by imports from ports.ts after the freeze.
 *
 * Source: plans/providers/port-proposal.md sections 2 and 4. Only the types the governor needs are
 * copied. Additions are marked "governor addition" and are proposed for the freeze. The proposal's
 * `windowSpent`/`windowAt` are optional here only so older hand-written snapshots still restore.
 */

export type AccountId = string;
export type ProviderKind = 'google' | 'microsoft' | 'imap' | 'jmap';
/** ARCH 4.1, priority order. */
export type Lane = 'interactive' | 'opFlush' | 'incremental' | 'prefetch' | 'backfill' | 'enrichment';
export type RequestKind = 'read' | 'write' | 'idempotentWrite' | 'send';
export type BudgetId = 'gmail' | 'gcal' | 'graph' | 'imap' | 'jmap' | 'caldav';
export type DeviceRole = 'primary' | 'secondary';

export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export type ErrorClass =
  | 'auth'
  | 'permission'
  | 'throttle'
  | 'daily'
  | 'send_limit'
  | 'anti_abuse'
  | 'config'
  | 'transient'
  | 'permanent'
  | 'cancelled';

export interface ClassifiedError {
  class: ErrorClass;
  provider: ProviderKind | 'gcal' | 'oauth' | 'caldav';
  method: string;
  reason: string;
  status?: number;
  retryAfterMs?: number;
  resumeAt?: number;
  concurrency?: boolean;
  uncertain?: boolean;
  missingScopes?: string[];
  item?: string;
  providerMessage?: string;
}

export class ProviderError extends Error {
  constructor(readonly error: ClassifiedError, options?: ErrorOptions) {
    super(error.reason, options);
    this.name = 'ProviderError';
  }
}

export class PausedError extends Error {
  constructor(readonly budget: BudgetId, readonly until: number, readonly cls: ErrorClass, readonly reason: string) {
    super('paused');
    this.name = 'PausedError';
  }
}

export interface BudgetSpec {
  id: BudgetId;
  unit: 'units' | 'requests' | 'commands' | 'bytes';
  windowMs: number;
  ceiling: number;
  targets: Record<DeviceRole, number>;
  floor: number;
  laneShare: Partial<Record<Lane, number>>;
  inFlight: number;
  reservedInteractive: number;
  /** Governor addition: AIMD regrowth per quiet minute (Gmail 250). */
  regrowPerMinute?: number;
}

export interface GovernedRequest {
  budget: BudgetId;
  lane: Lane;
  cost: number;
  slots?: number;
  kind: RequestKind;
  method: string;
  signal?: AbortSignal;
}

export type Admission = { ok: true } | { ok: false; until: number; cls: ErrorClass; reason: string };

export interface GovernorPort {
  run<T>(account: AccountId, req: GovernedRequest, fn: (signal: AbortSignal) => Promise<T>): Promise<T>;
  observe(account: AccountId, budget: BudgetId, error: ClassifiedError): void;
  /** No I/O. With `kind: 'send'` it also refuses while a send limit is in force. */
  admission(account: AccountId, budget: BudgetId, lane: Lane, kind?: RequestKind): Admission;
  setRole(account: AccountId, role: DeviceRole): void;
  snapshot(account: AccountId): GovernorSnapshot[];
  onChange(listener: (account: AccountId, snap: GovernorSnapshot) => void): () => void;
}

export interface BoundGovernor {
  run<T>(req: GovernedRequest, fn: (signal: AbortSignal) => Promise<T>): Promise<T>;
  observe(budget: BudgetId, error: ClassifiedError): void;
}

export interface GovernorSnapshot {
  budget: BudgetId;
  target: number;
  usedInWindow: number;
  /**
   * An upper bound on the units spent in any 60 s window up to `windowAt` plus a short refresh
   * interval. Persisted so a restart cannot re-spend the same minute (PV2 "does not hammer").
   */
  windowSpent?: number;
  windowAt?: number;
  inFlight: number;
  cooldownUntil?: number;
  cooldownStep: number;
  dailyBlockUntil?: number;
  /** send_limit blocks sends only; sync continues. */
  sendBlockedUntil?: number;
  /** An auth or config stop, until `resume`. */
  blocked?: { cls: 'auth' | 'config'; since: number };
  /** The class and reason of the pause or send block in force, if any. */
  reason?: string;
  cls?: ErrorClass;
  lastRefusalAt?: number;
  quietSince?: number;
  /** Governor addition: set to 1 after a concurrency refusal, until 10 quiet minutes pass; restored after a restart. */
  inFlightCap?: number;
  /**
   * Governor addition: the halved AIMD target before regrowth and before the role's cap, so a
   * restart or a role flip restores it exactly. Absent when AIMD is not holding the target down.
   */
  aimdTarget?: number;
}
