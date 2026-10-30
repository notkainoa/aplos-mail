import type { Submission } from '@aplos/contract';
import type { CommitExtensionTx, SqlValue, StoreReader } from '../store';
import { KP, killpoint } from './killpoints';

/**
 * The outbox's writer for `submissions` (seam 2, registered by `extension.ts`): every state change goes through `store.commit` as a `submission`
 * write, applied here inside the commit transaction. Each transition is a compare-and-set on the row's current state
 * (`UPDATE ... WHERE id = ? AND state IN (...)`), so an undo racing the timer's `sending` commit, or two engines on one
 * store, can never both win: the loser's commit throws `SubmissionConflict` and rolls back whole.
 *
 * The lane has no columns of its own beyond the ones in 0001 and 0002, so the facts that have none (when it was queued,
 * the store rev, the `findSent` check state, the display fields, the Submission/set opId) live as one JSON object in
 * `submissions.error`, next to the problem. `error_until` stays the problem's `until`. A later migration can move these
 * into columns; `parseExtra` is the only reader.
 */

export type SubmissionState =
  'queued' | 'scheduled' | 'sending' | 'sent' | 'uncertain' | 'failed' | 'cancelled' | 'suspended';

/** States that hold the draft (FR-7): everything but `sent` and `cancelled`. */
export const LIVE_STATES: readonly SubmissionState[] = [
  'queued',
  'scheduled',
  'sending',
  'uncertain',
  'failed',
  'suspended',
];

export interface SubmissionProblem {
  reasonCode: string;
  message?: string;
  at?: number;
  until?: number;
}

/** Fixed at `send` and kept in the row's JSON. */
export interface SubmissionMeta {
  subject: string;
  toNames: string[];
  /** Contract thread id of the draft's thread. */
  threadId?: string;
  /** The provider thread id the send continues, for `SubmissionPayload.remoteThreadId`. */
  remoteThreadId?: string;
  envelope: { from: string; rcpt: string[] };
  attachments: number;
  /** The `Submission/set` opId that created it, so a replayed `send` answers with the same row. */
  opId?: string;
}

/** The JSON in `submissions.error` (see the file comment). */
export interface RowExtra extends SubmissionMeta {
  queuedAt: number;
  /** The store seq of the row's last change (`Submission.rev`). */
  rev: number;
  /** `findSent` checks made for an `uncertain` row, and when the next is due (none: absent). */
  checkCount: number;
  checkAt?: number;
  sentAt?: number;
  /** The `sending` marker was committed at least once: the bytes may have left, so they are never changed again. */
  attempted?: true;
  /** The send used the remote draft (`SendReceipt.draftConsumed`): it is gone, so nothing is left to delete. */
  draftConsumed?: true;
  problem?: Omit<SubmissionProblem, 'until'>;
}

export interface NewSubmission {
  id: string;
  draftId: string;
  accountId: string;
  internetId: string;
  mime: Uint8Array;
  revision: number;
  state: 'queued' | 'scheduled';
  queuedAt: number;
  notBefore: number;
  meta: SubmissionMeta;
}

/** Fields a transition may set; `null` clears. */
export interface SubmissionPatch {
  notBefore?: number;
  attemptAt?: number | null;
  /** `true` with the `sending` marker; `false` only when the send provably did not leave (paused). */
  attempted?: boolean;
  sentAt?: number;
  remoteMessageId?: string | null;
  remoteThreadId?: string | null;
  problem?: SubmissionProblem | null;
  checkCount?: number;
  checkAt?: number | null;
  /** The provider reported the remote draft consumed by the send. */
  draftConsumed?: true;
  /** Drops the pinned MIME: only once `sent` is committed. */
  dropMime?: true;
  /** The same message re-dated by a reschedule or Send now (same Message-ID); the move's state guard keeps it off a `sending` row. */
  mime?: Uint8Array;
}

export type SubmissionWrite =
  | { kind: 'submission'; op: 'create'; row: NewSubmission }
  | {
      kind: 'submission';
      op: 'move';
      id: string;
      /** The compare-and-set: the row must be in one of these states. */
      from: readonly SubmissionState[];
      to: SubmissionState;
      /** Extra guards the caller read before deciding (a stale timer or attempt loses). */
      ifNotBefore?: number;
      ifAttemptAt?: number;
      /**
       * The `findSent` checks are over and the owner was asked: no check is due or running (`checkAt` absent) and the
       * problem is `send.uncertain`. `sendAnyway` demands it inside the commit, so it cannot pass over a check that
       * could still find the message.
       */
      ifChecksDone?: true;
      /** Why the caller moves it (`transition`'s `why`); the kill point `during-commit` reports it. Changes nothing. */
      why?: string;
      set?: SubmissionPatch;
    };

declare module '../store/port' {
  interface ExtensionWrites {
    submission: SubmissionWrite;
  }
}

export type ConflictReason =
  | 'draftMissing'
  | 'draftRevision'
  | 'live'
  | 'alreadySent'
  | 'checking'
  | 'state'
  | 'unresolved'
  | 'bodyPending';

/** A compare-and-set lost: the row (or its draft) is not what the caller saw. Thrown inside the commit, so nothing lands. */
export class SubmissionConflict extends Error {
  override readonly name = 'SubmissionConflict';
  constructor(
    readonly reason: ConflictReason,
    readonly current?: SubmissionState,
  ) {
    super(`submission conflict: ${reason}`);
  }
}

export interface SubmissionRow {
  id: string;
  draft_id: string;
  account_id: string;
  internet_id: string;
  mime: Uint8Array | null;
  not_before: number;
  state: SubmissionState;
  attempt_at: number | null;
  error: string | null;
  error_until: number | null;
  remote_message_id: string | null;
  remote_thread_id: string | null;
  revision: number;
  [k: string]: SqlValue;
}

const LIVE_SQL = LIVE_STATES.map(s => `'${s}'`).join(', ');

export function readSubmission(q: StoreReader, id: string): SubmissionRow | undefined {
  return q.get<SubmissionRow>('SELECT * FROM submissions WHERE id = ?', id);
}

export function liveSubmissionOf(q: StoreReader, draftId: string): SubmissionRow | undefined {
  return q.get<SubmissionRow>(
    `SELECT * FROM submissions WHERE draft_id = ? AND state IN (${LIVE_SQL}) LIMIT 1`,
    draftId,
  );
}

const EMPTY_EXTRA: RowExtra = {
  subject: '',
  toNames: [],
  envelope: { from: '', rcpt: [] },
  attachments: 0,
  queuedAt: 0,
  rev: 0,
  checkCount: 0,
};

/** The JSON of a row; a row without one (never written by this lane) reads as empty, never throws. */
export function parseExtra(error: string | null): RowExtra {
  if (!error) return { ...EMPTY_EXTRA };
  try {
    return { ...EMPTY_EXTRA, ...(JSON.parse(error) as Partial<RowExtra>) };
  } catch {
    return { ...EMPTY_EXTRA };
  }
}

export function extraOf(row: SubmissionRow): RowExtra {
  return parseExtra(row.error);
}

/** Has a send of these bytes been started? Then they may be out there and must not change. */
export function hadAttempt(row: SubmissionRow): boolean {
  return row.attempt_at !== null || extraOf(row).attempted === true;
}

export function problemOf(row: SubmissionRow): SubmissionProblem | undefined {
  const { problem } = extraOf(row);
  if (!problem) return undefined;
  return row.error_until === null ? problem : { ...problem, until: row.error_until };
}

/** The contract `Submission` for a row. */
export function toSubmission(row: SubmissionRow): Submission {
  const extra = extraOf(row);
  const out: Submission = {
    id: row.id,
    rev: extra.rev,
    draftId: row.draft_id,
    accountId: row.account_id,
    internetId: row.internet_id,
    revision: row.revision,
    state: row.state,
    queuedAt: extra.queuedAt,
    notBefore: row.not_before,
    toNames: extra.toNames,
    subject: extra.subject,
  };
  if (extra.threadId !== undefined) out.threadId = extra.threadId;
  if (row.attempt_at !== null) out.attemptAt = row.attempt_at;
  if (extra.sentAt !== undefined) out.sentAt = extra.sentAt;
  const problem = problemOf(row);
  if (problem) out.problem = problem;
  return out;
}

interface DraftGate {
  revision: number;
  removing: number | null;
  conflicted: number;
  incomplete: number | null;
  [k: string]: SqlValue;
}

function create(tx: CommitExtensionTx, row: NewSubmission) {
  const draft = tx.get<DraftGate>(
    `SELECT revision,
            json_extract(data, '$._sync.removing') AS removing,
            json_extract(data, '$._sync.conflict') IS NOT NULL AS conflicted,
            json_extract(data, '$._sync.incomplete') AS incomplete
     FROM drafts WHERE id = ?`,
    row.draftId,
  );
  // A discarded draft waiting for its copy to go does not exist; one with a version from another device waiting for the
  // owner's choice is not sent (the send would delete the copy holding that version); one without its text is not either.
  if (!draft || draft.removing) throw new SubmissionConflict('draftMissing');
  if (draft.revision !== row.revision) throw new SubmissionConflict('draftRevision');
  if (draft.conflicted) throw new SubmissionConflict('unresolved');
  if (draft.incomplete) throw new SubmissionConflict('bodyPending');
  const live = tx.get<{ state: SubmissionState }>(
    `SELECT state FROM submissions WHERE draft_id = ? AND state IN (${LIVE_SQL}) LIMIT 1`,
    row.draftId,
  );
  if (live) throw new SubmissionConflict('live', live.state);
  // A revision that already went out is not sent again under a new Message-ID: the owner edits the draft first.
  const done = tx.get(
    "SELECT 1 FROM submissions WHERE draft_id = ? AND revision = ? AND state = 'sent' LIMIT 1",
    row.draftId,
    row.revision,
  );
  if (done) throw new SubmissionConflict('alreadySent', 'sent');
  const extra: RowExtra = { ...row.meta, queuedAt: row.queuedAt, rev: tx.seq, checkCount: 0 };
  tx.run(
    `INSERT INTO submissions(id, draft_id, account_id, internet_id, mime, not_before, state, revision, error)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    row.id,
    row.draftId,
    row.accountId,
    row.internetId,
    row.mime,
    row.notBefore,
    row.state,
    row.revision,
    JSON.stringify(extra),
  );
  tx.mark('Submission', row.id, 'u');
  tx.mark('Draft', row.draftId, 'u');
}

/** The JSON after a patch: `null` clears a field, absent keeps it. */
function patchedExtra(current: RowExtra, set: SubmissionPatch, seq: number): RowExtra {
  const next: RowExtra = { ...current, rev: seq };
  if (set.sentAt !== undefined) next.sentAt = set.sentAt;
  if (set.attempted === true) next.attempted = true;
  else if (set.attempted === false) delete next.attempted;
  if (set.draftConsumed) next.draftConsumed = true;
  if (set.checkCount !== undefined) next.checkCount = set.checkCount;
  if (set.checkAt === null) delete next.checkAt;
  else if (set.checkAt !== undefined) next.checkAt = set.checkAt;
  if (set.problem === null) delete next.problem;
  else if (set.problem !== undefined) {
    const { until: _until, ...problem } = set.problem;
    next.problem = problem;
  }
  return next;
}

/** `SET` terms for the plain columns of a patch, in a fixed order. */
function columnTerms(set: SubmissionPatch): { sql: string[]; params: SqlValue[] } {
  const sql: string[] = [],
    params: SqlValue[] = [];
  const put = (column: string, value: SqlValue) => {
    sql.push(`${column} = ?`);
    params.push(value);
  };
  if (set.notBefore !== undefined) put('not_before', set.notBefore);
  if (set.attemptAt !== undefined) put('attempt_at', set.attemptAt);
  if (set.remoteMessageId !== undefined) put('remote_message_id', set.remoteMessageId);
  if (set.remoteThreadId !== undefined) put('remote_thread_id', set.remoteThreadId);
  if (set.problem !== undefined) put('error_until', set.problem?.until ?? null);
  if (set.dropMime) sql.push('mime = NULL');
  else if (set.mime !== undefined) put('mime', set.mime);
  return { sql, params };
}

function move(tx: CommitExtensionTx, w: Extract<SubmissionWrite, { op: 'move' }>) {
  if (!w.from.length) throw new SubmissionConflict('state');
  const set = w.set ?? {};
  const current = tx.get<{ error: string | null }>(
    'SELECT error FROM submissions WHERE id = ?',
    w.id,
  );
  const terms = columnTerms(set);
  const where = [`id = ?`, `state IN (${w.from.map(() => '?').join(', ')})`];
  const extra = JSON.stringify(patchedExtra(parseExtra(current?.error ?? null), set, tx.seq));
  const params: SqlValue[] = [w.to, extra, ...terms.params, w.id, ...w.from];
  if (w.ifNotBefore !== undefined) {
    where.push('not_before = ?');
    params.push(w.ifNotBefore);
  }
  if (w.ifAttemptAt !== undefined) {
    where.push('attempt_at = ?');
    params.push(w.ifAttemptAt);
  }
  if (w.ifChecksDone)
    where.push(
      "json_extract(error, '$.checkAt') IS NULL",
      "json_extract(error, '$.problem.reasonCode') = 'send.uncertain'",
    );
  const { changes } = tx.run(
    `UPDATE submissions SET ${['state = ?', 'error = ?', ...terms.sql].join(', ')} WHERE ${where.join(' AND ')}`,
    ...params,
  );
  if (changes !== 1) {
    const now = tx.get<{ state: SubmissionState }>(
      'SELECT state FROM submissions WHERE id = ?',
      w.id,
    );
    const checking = w.ifChecksDone && now?.state === 'uncertain';
    throw new SubmissionConflict(checking ? 'checking' : 'state', now?.state);
  }
  tx.mark('Submission', w.id, 'u');
  if (w.to === 'sent' || w.to === 'cancelled') {
    // The draft's `submissionId` clears: it comes back unlocked (cancelled) or is done (sent).
    const row = tx.get<{ draft_id: string }>('SELECT draft_id FROM submissions WHERE id = ?', w.id);
    if (row) tx.mark('Draft', row.draft_id, 'u');
  }
  // Test builds only: die with the transaction open, so a restart proves an uncommitted move of any kind leaves nothing
  // behind. (The guard defaults to ON when the constant is not defined; see `killpoints.ts` before bundling the engine.)
  if (typeof __APLOS_TEST_MODE__ === 'undefined' || __APLOS_TEST_MODE__)
    killpoint(KP.DURING_COMMIT, `${w.from.join('+')}>${w.to}:${w.why ?? ''}`);
}

/** Applies one `submission` write inside the commit; `extension.ts` routes the lane's kinds here and to the drafts. */
export function applySubmission(write: { kind: string }, tx: CommitExtensionTx) {
  const w = write as SubmissionWrite;
  if (w.op === 'create') return create(tx, w.row);
  if (w.op === 'move') return move(tx, w);
  throw new Error(`Unknown submission write ${String((w as { op?: unknown }).op)}`);
}
