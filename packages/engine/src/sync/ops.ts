import {
  GOVERNOR_CLASS_POLICY,
  type AccountId,
  type OpChange,
  type OpOutcome,
  type PendingOp,
  type StorePort,
  type StoreWrite,
} from '../ports';
import type { OpSettleWrite } from '../store/port';

/**
 * `ops.payload` for provider ops, as `prov-gov` drains them: one message and one change (F3 `PendingOp`). The ports
 * leave `payload` opaque ("provider-lane JSON"), so this is the format `eng-views` must write when it enqueues a
 * provider op; anything else is settled `failed` with `invalidPayload` and holds back the account's later ops.
 */
export interface OpPayload {
  remoteId: string;
  change: OpChange;
}

export function opPayload(remoteId: string, change: OpChange): string {
  return JSON.stringify({ remoteId, change } satisfies OpPayload);
}

const CHANGE_KINDS = new Set(['folders', 'flags', 'trash', 'untrash']);

export function parseOpPayload(payload: string): OpPayload | undefined {
  try {
    const value = JSON.parse(payload) as Partial<OpPayload>;
    if (typeof value?.remoteId !== 'string' || !value.remoteId) return undefined;
    const change = value.change as { kind?: unknown; add?: unknown; remove?: unknown } | undefined;
    if (!change || !CHANGE_KINDS.has(change.kind as string)) return undefined;
    if (change.kind === 'folders' && !(Array.isArray(change.add) && Array.isArray(change.remove)))
      return undefined;
    return { remoteId: value.remoteId, change: value.change as OpChange };
  } catch {
    return undefined;
  }
}

export interface OpRow {
  opId: string;
  seq: number;
  state: string;
  attempts: number;
  nextAt?: number;
  lastError?: string;
  payload: string;
}

/** The account's open ops, FIFO (`ops.seq`). */
export function readOps(store: StorePort, account: AccountId): OpRow[] {
  return store
    .read(q =>
      q.all<{
        op_id: string;
        seq: number;
        state: string;
        attempts: number;
        next_at: number | null;
        last_error: string | null;
        payload: string;
      }>(
        'SELECT op_id, seq, state, attempts, next_at, last_error, payload FROM ops WHERE account_id = ? ORDER BY seq',
        account,
      ),
    )
    .map(r => ({
      opId: r.op_id,
      seq: r.seq,
      state: r.state,
      attempts: r.attempts,
      nextAt: r.next_at ?? undefined,
      lastError: r.last_error ?? undefined,
      payload: r.payload,
    }));
}

/** The earliest op retry time across every account (`ops` deadline source). */
export function nextOpRetry(store: StorePort): number | undefined {
  const row = store.read(q =>
    q.get<{ at: number | null }>(
      "SELECT MIN(next_at) AS at FROM ops WHERE state = 'queued' AND next_at IS NOT NULL",
    ),
  );
  return row?.at ?? undefined;
}

/**
 * The mutation fence for an interactive read (open, search) that runs beside the actor's op flush. The read's
 * `ctx.generation` alone does not fence an edit made before it whose op is still open: if the flush settles that op
 * (`synced` deletes the row, so it is no longer replayed) while the read is out, the read's older answer would undo the
 * edit (prov-gov-attack-02). So the fence sits just below the oldest op still queued or in flight when the read starts;
 * history reconciles anything it holds back.
 */
export function readFence(store: StorePort, account: AccountId, generation: number): number {
  const row = store.read(q =>
    q.get<{ seq: number | null }>(
      "SELECT MIN(created_seq) AS seq FROM ops WHERE account_id = ? AND state IN ('queued', 'inflight')",
      account,
    ),
  );
  return row?.seq != null ? Math.min(generation, row.seq - 1) : generation;
}

/** Why an op is not flushed now. */
export type OpHold = { kind: 'retryAt'; at: number } | { kind: 'failed' } | { kind: 'uncertain' };

/**
 * The ops to flush now, in order, up to the first that holds the rest back: a `failed` or `conflict` row (waits for
 * Retry or discard), a retry time in the future, or a write whose outcome is unknown (held until the next incremental
 * pass shows whether it landed). ARCH 4.3: one failure holds back only this account's later ops.
 */
export function flushable(
  rows: OpRow[],
  now: number,
  heldUncertain: boolean,
): { ops: OpRow[]; hold?: OpHold } {
  const ops: OpRow[] = [];
  for (const row of rows) {
    if (row.state === 'failed' || row.state === 'conflict')
      return { ops, hold: { kind: 'failed' } };
    if (row.lastError === UNCERTAIN && heldUncertain) return { ops, hold: { kind: 'uncertain' } };
    if (row.nextAt !== undefined && row.nextAt > now)
      return { ops, hold: { kind: 'retryAt', at: row.nextAt } };
    ops.push(row);
  }
  return { ops };
}

export const UNCERTAIN = 'uncertain';
/** Transient op failures retry at 30 s, doubling, at most 15 minutes. */
export function opRetryDelay(attempts: number): number {
  return Math.min(900_000, 30_000 * 2 ** Math.max(0, attempts - 1));
}

export function pendingOp(row: OpRow, payload: OpPayload): PendingOp {
  return { opId: row.opId, seq: row.seq, remoteId: payload.remoteId, change: payload.change };
}

/**
 * A refusal the governor holds (a throttle, daily or anti-abuse stop, an auth or config block, a send limit) or a
 * cancel: the op did nothing wrong, so it stays `queued` (still replayed) and goes again once the pause ends. Marking it
 * `failed` would stop its replay and let the next page undo the local edit (prov-gov-attack-01).
 */
export function heldByGovernor(cls: string | undefined): boolean {
  if (cls === 'cancelled') return true;
  const policy = GOVERNOR_CLASS_POLICY[cls as keyof typeof GOVERNOR_CLASS_POLICY];
  return policy !== undefined && policy.pauses !== 'nothing';
}

/** How one outcome settles its op (ARCH 4.3, F3 `OpOutcome`), plus any placements the provider reported. */
export function settleWrites(
  account: AccountId,
  row: OpRow,
  outcome: OpOutcome,
  now: number,
): { writes: StoreWrite[]; holds: boolean; paused?: boolean } {
  const settle = (patch: Omit<OpSettleWrite, 'kind' | 'opId'>): StoreWrite => ({
    kind: 'opSettle',
    opId: row.opId,
    ...patch,
  });
  const placements: StoreWrite[] = (outcome.placements ?? []).map(p => {
    const target =
      p.remoteId !== undefined ? { remoteId: p.remoteId } : { folder: p.folder, uid: p.uid! };
    const ref = p.uid === undefined ? { folder: p.folder } : { folder: p.folder, uid: p.uid };
    return p.present
      ? { kind: 'placements', accountId: account, target, add: [ref], remove: [] }
      : { kind: 'placements', accountId: account, target, add: [], remove: [p.folder] };
  });
  if (outcome.result === 'applied')
    return { writes: [...placements, settle({ state: 'synced' })], holds: false };
  // A 404 drops the op: the next commit shows provider truth.
  if (outcome.result === 'notFound')
    return { writes: [settle({ state: 'cancelled' })], holds: false };
  const error = outcome.error;
  const attempts = row.attempts + 1;
  if (error?.uncertain) {
    // Never re-sent blind: held (still replayed) until the next incremental pass, then tried once more.
    return {
      writes: [settle({ state: 'queued', attempts, nextAt: null, lastError: UNCERTAIN })],
      holds: true,
    };
  }
  if (heldByGovernor(error?.class)) {
    // Not an attempt: nothing reached the provider, or the provider refused the budget, not the op.
    return {
      writes: [settle({ state: 'queued', nextAt: null, lastError: error!.reason || error!.class })],
      holds: true,
      paused: true,
    };
  }
  if (!error || error.class === 'transient') {
    return {
      writes: [
        settle({
          state: 'queued',
          attempts,
          nextAt: now + opRetryDelay(attempts),
          lastError: error?.reason ?? 'unclassified',
        }),
      ],
      holds: true,
    };
  }
  return {
    writes: [
      settle({ state: 'failed', attempts, nextAt: null, lastError: error.reason || error.class }),
    ],
    holds: true,
  };
}
