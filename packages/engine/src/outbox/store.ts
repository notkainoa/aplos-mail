import type { Submission } from '@aplos/contract';
import type { CommitExtension, CommitExtensionTx, SqlValue, StoreReader } from '../store';

/**
 * The outbox's writer for `submissions` (seam 2): every state change goes through `store.commit` as a `submission`
 * write, applied here inside the commit transaction. Each transition is a compare-and-set on the row's current state
 * (`UPDATE ... WHERE id = ? AND state IN (...)`), so an undo racing the timer's `sending` commit, or two engines on one
 * store, can never both win: the loser's commit throws `SubmissionConflict` and rolls back whole.
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

/** Fixed at `send` and kept in `submissions.meta`. */
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

/** Columns a transition may set; `null` clears. */
export interface SubmissionPatch {
  notBefore?: number;
  attemptAt?: number | null;
  sentAt?: number;
  remoteMessageId?: string | null;
  remoteThreadId?: string | null;
  problem?: SubmissionProblem | null;
  checkCount?: number;
  checkAt?: number | null;
  /** Drops the pinned MIME: only once `sent` is committed. */
  dropMime?: true;
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
      set?: SubmissionPatch;
    };

declare module '../store/port' {
  interface ExtensionWrites {
    submission: SubmissionWrite;
  }
}

/** A compare-and-set lost: the row (or its draft) is not what the caller saw. Thrown inside the commit, so nothing lands. */
export class SubmissionConflict extends Error {
  override readonly name = 'SubmissionConflict';
  constructor(
    readonly reason: 'draftMissing' | 'draftRevision' | 'live' | 'state',
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
  queued_at: number;
  sent_at: number | null;
  rev: number;
  check_count: number;
  check_at: number | null;
  meta: string;
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

export function parseMeta(row: SubmissionRow): SubmissionMeta {
  try {
    const meta = JSON.parse(row.meta) as Partial<SubmissionMeta>;
    return {
      subject: meta.subject ?? '',
      toNames: meta.toNames ?? [],
      threadId: meta.threadId,
      remoteThreadId: meta.remoteThreadId,
      envelope: meta.envelope ?? { from: '', rcpt: [] },
      attachments: meta.attachments ?? 0,
      opId: meta.opId,
    };
  } catch {
    return { subject: '', toNames: [], envelope: { from: '', rcpt: [] }, attachments: 0 };
  }
}

function parseProblem(row: SubmissionRow): SubmissionProblem | undefined {
  if (!row.error) return undefined;
  try {
    const problem = JSON.parse(row.error) as SubmissionProblem;
    return row.error_until === null ? problem : { ...problem, until: row.error_until };
  } catch {
    return undefined;
  }
}

/** The contract `Submission` for a row. */
export function toSubmission(row: SubmissionRow): Submission {
  const meta = parseMeta(row);
  const out: Submission = {
    id: row.id,
    rev: row.rev,
    draftId: row.draft_id,
    accountId: row.account_id,
    internetId: row.internet_id,
    revision: row.revision,
    state: row.state,
    queuedAt: row.queued_at,
    notBefore: row.not_before,
    toNames: meta.toNames,
    subject: meta.subject,
  };
  if (meta.threadId !== undefined) out.threadId = meta.threadId;
  if (row.attempt_at !== null) out.attemptAt = row.attempt_at;
  if (row.sent_at !== null) out.sentAt = row.sent_at;
  const problem = parseProblem(row);
  if (problem) out.problem = problem;
  return out;
}

function create(tx: CommitExtensionTx, row: NewSubmission) {
  const draft = tx.get<{ revision: number }>(
    'SELECT revision FROM drafts WHERE id = ?',
    row.draftId,
  );
  if (!draft) throw new SubmissionConflict('draftMissing');
  if (draft.revision !== row.revision) throw new SubmissionConflict('draftRevision');
  const live = tx.get<{ state: SubmissionState }>(
    `SELECT state FROM submissions WHERE draft_id = ? AND state IN (${LIVE_SQL}) LIMIT 1`,
    row.draftId,
  );
  if (live) throw new SubmissionConflict('live', live.state);
  tx.run(
    `INSERT INTO submissions(id, draft_id, account_id, internet_id, mime, not_before, state, revision, queued_at, rev, meta)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    row.id,
    row.draftId,
    row.accountId,
    row.internetId,
    row.mime,
    row.notBefore,
    row.state,
    row.revision,
    row.queuedAt,
    tx.seq,
    JSON.stringify(row.meta),
  );
  tx.mark('Submission', row.id, 'u');
  tx.mark('Draft', row.draftId, 'u');
}

/** `SET` terms for a patch, in a fixed order. */
function patchTerms(set: SubmissionPatch = {}): { sql: string[]; params: SqlValue[] } {
  const sql: string[] = [],
    params: SqlValue[] = [];
  const put = (column: string, value: SqlValue) => {
    sql.push(`${column} = ?`);
    params.push(value);
  };
  if (set.notBefore !== undefined) put('not_before', set.notBefore);
  if (set.attemptAt !== undefined) put('attempt_at', set.attemptAt);
  if (set.sentAt !== undefined) put('sent_at', set.sentAt);
  if (set.remoteMessageId !== undefined) put('remote_message_id', set.remoteMessageId);
  if (set.remoteThreadId !== undefined) put('remote_thread_id', set.remoteThreadId);
  if (set.checkCount !== undefined) put('check_count', set.checkCount);
  if (set.checkAt !== undefined) put('check_at', set.checkAt);
  if (set.problem !== undefined) {
    const { until, ...problem } = set.problem ?? { reasonCode: '' };
    put('error', set.problem ? JSON.stringify(problem) : null);
    put('error_until', set.problem && until !== undefined ? until : null);
  }
  if (set.dropMime) sql.push('mime = NULL');
  return { sql, params };
}

function move(tx: CommitExtensionTx, w: Extract<SubmissionWrite, { op: 'move' }>) {
  if (!w.from.length) throw new SubmissionConflict('state');
  const terms = patchTerms(w.set);
  const where = [`id = ?`, `state IN (${w.from.map(() => '?').join(', ')})`];
  const params: SqlValue[] = [w.to, tx.seq, ...terms.params, w.id, ...w.from];
  if (w.ifNotBefore !== undefined) {
    where.push('not_before = ?');
    params.push(w.ifNotBefore);
  }
  if (w.ifAttemptAt !== undefined) {
    where.push('attempt_at = ?');
    params.push(w.ifAttemptAt);
  }
  const { changes } = tx.run(
    `UPDATE submissions SET ${['state = ?', 'rev = ?', ...terms.sql].join(', ')} WHERE ${where.join(' AND ')}`,
    ...params,
  );
  if (changes !== 1) {
    const now = tx.get<{ state: SubmissionState }>(
      'SELECT state FROM submissions WHERE id = ?',
      w.id,
    );
    throw new SubmissionConflict('state', now?.state);
  }
  tx.mark('Submission', w.id, 'u');
  if (w.to === 'sent' || w.to === 'cancelled') {
    // The draft's `submissionId` clears: it comes back unlocked (cancelled) or is done (sent).
    const row = tx.get<{ draft_id: string }>('SELECT draft_id FROM submissions WHERE id = ?', w.id);
    if (row) tx.mark('Draft', row.draft_id, 'u');
  }
}

function apply(write: { kind: string }, tx: CommitExtensionTx) {
  const w = write as SubmissionWrite;
  if (w.op === 'create') return create(tx, w.row);
  if (w.op === 'move') return move(tx, w);
  throw new Error(`Unknown submission write ${String((w as { op?: unknown }).op)}`);
}

/** Pass to `openStore({ extensions })`. Stateless, so one value serves every store. */
export const outboxExtension: CommitExtension = {
  lane: 'eng-time',
  kinds: ['submission'],
  changeTypes: ['Submission', 'Draft'],
  apply,
};
