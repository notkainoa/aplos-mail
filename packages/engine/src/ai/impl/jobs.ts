import type { AiJob } from '@aplos/contract';
import { ContractError } from '@aplos/contract/contract-error';
import type { StoreReader } from '../../store/port';
import { FLAG } from '../../store/commit';
import type { EngineServices } from '../../runtime/services';
import { splitId } from '../../views/compile';

/**
 * Job queue helpers (ARCH 8.1). Singleton keys `summary:<thread>:<input_hash>` make a second enqueue of the same
 * work a no-op; `priority` orders the queue (visible Home first, then unread Inbox newest first); Spam/Trash
 * threads are never auto-enqueued. `nextJob` and `claimJob` serve the `jobs` deadline source.
 */

export interface JobRow {
  [k: string]: string | number | null;
  id: number;
  kind: string;
  key: string;
  priority: number;
  payload: string;
  state: string;
  attempts: number;
  next_at: number;
  last_error: string | null;
}

/** Which background feature a job kind asks the gate for (consent covers all three, R2B-4). */
export const featureOf = (kind: string): 'summaries' | 'plans' | 'drafts' =>
  kind === 'plan'
    ? 'plans'
    : kind === 'followup' || kind === 'suggestAction'
      ? 'drafts'
      : 'summaries';

const JOB_KINDS = new Set(['summary', 'classify', 'plan', 'suggestAction', 'followup']);

/** The wire `AiJob` for one row. */
export function jobOf(row: JobRow): AiJob {
  const payload = parse(row.payload);
  const problem = problemOf(row.last_error);
  return {
    id: String(row.id),
    kind: JOB_KINDS.has(row.kind) ? (row.kind as AiJob['kind']) : 'summary',
    ...(typeof payload?.threadId === 'string' ? { threadId: payload.threadId } : {}),
    state: row.state as AiJob['state'],
    attempts: row.attempts,
    nextAt: row.next_at,
    ...(typeof payload?.model === 'object' && payload.model
      ? { model: payload.model as AiJob['model'] }
      : {}),
    ...(problem ? { problem } : {}),
  };
}

const parse = (raw: string): Record<string, unknown> | undefined => {
  try {
    const v: unknown = JSON.parse(raw);
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};

function problemOf(raw: string | null): NonNullable<AiJob['problem']> | undefined {
  if (!raw) return undefined;
  const code = parse(raw)?.reasonCode;
  return { reasonCode: typeof code === 'string' && code.length <= 60 ? code : 'ai.failed' };
}

/** Read a jobs row by id. */
export const jobRow = (q: StoreReader, id: number): JobRow | undefined =>
  q.get<JobRow>(
    'SELECT id, kind, key, priority, payload, state, attempts, next_at, last_error FROM jobs WHERE id = ?',
    id,
  );

/** FNV-1a over the given parts — the small deterministic hash behind the job singleton keys. */
const fnv = (parts: readonly string[]): string => {
  let h = 0x811c9dc5;
  for (const s of parts)
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
  return (h >>> 0).toString(16);
};

/** A small deterministic hash of the thread's summary inputs (a label change must not invalidate it). */
export function inputHashOf(
  q: StoreReader,
  threadRowId: number,
): { hash: string; messageCount: number } {
  const rows = q.all<{ remote_id: string; internal_date: number; snippet: string | null }>(
    'SELECT remote_id, internal_date, snippet FROM messages WHERE thread_id = ? ORDER BY id',
    threadRowId,
  );
  const hash = fnv(rows.map(r => `${r.remote_id}:${r.internal_date}:${r.snippet?.length ?? 0}\n`));
  return { hash, messageCount: rows.length };
}

/**
 * Priority of a thread's next job: 0 visible Home, 1 unread Inbox (newest first inside the class, via a
 * last-date-ordered `next_at`), 2 anything else. Spam/Trash-only threads return `undefined` (never queued).
 */
export function priorityOf(
  q: StoreReader,
  accountId: string,
  remoteThreadId: string,
): { priority: number; threadRowId: number; lastDate: number } | undefined {
  const t = q.get<{
    id: number;
    status: string;
    hidden_from_home: number;
    unread: number;
    last_date: number;
  }>(
    `SELECT t.id, w.status, w.hidden_from_home, t.unread_count AS unread, t.last_date
     FROM threads t LEFT JOIN thread_workflow w ON w.thread_id = t.id
     WHERE t.account_id = ? AND t.remote_id = ?`,
    accountId,
    remoteThreadId,
  );
  if (!t) return undefined;
  const roles = q
    .all<{ role: string | null }>(
      `SELECT f.role FROM thread_folders tf JOIN folders f ON f.id = tf.folder_id WHERE tf.thread_id = ?`,
      t.id,
    )
    .map(r => r.role);
  if (roles.some(r => r === 'trash' || r === 'spam')) return undefined;
  const home = t.status === 'new' && t.hidden_from_home !== 1;
  const priority = home ? 0 : t.unread > 0 && roles.includes('inbox') ? 1 : 2;
  return { priority, threadRowId: t.id, lastDate: t.last_date };
}

/** Enqueue one job under its singleton key; returns the stored row (the winner when it raced). */
export function enqueue(
  services: EngineServices,
  opId: string,
  job: {
    kind: string;
    key: string;
    priority: number;
    payload: Record<string, unknown>;
    nextAt: number;
  },
): JobRow {
  services.store.commit({
    opId,
    origin: 'local',
    writes: [
      {
        kind: 'job',
        action: 'enqueue',
        job: {
          kind: job.kind,
          key: job.key,
          priority: job.priority,
          payload: JSON.stringify(job.payload),
          nextAt: job.nextAt,
        },
      },
    ],
  });
  const row = services.store.read(q =>
    q.get<JobRow>(
      'SELECT id, kind, key, priority, payload, state, attempts, next_at, last_error FROM jobs WHERE key = ?',
      job.key,
    ),
  );
  services.deadlines.changed('jobs');
  if (!row)
    throw new ContractError({
      type: 'internal',
      message: 'The queued job could not be read back.',
    });
  return row;
}

/** A wire thread id back to `{accountId, remoteThreadId}`; `undefined` when unknown. */
export const splitThreadId = (q: StoreReader, threadId: string) => splitId(q, threadId);

// ------------------------------------------------------------ follow up

const DAY_MS = 86_400_000;
/** Follow-up jobs run after summaries (priorities 0-2). */
export const FOLLOWUP_PRIORITY = 3;

/** `mail.followUpDays` from Settings — the same read `viewEnv` makes for Home's Follow up lane. */
export function followUpDaysOf(q: StoreReader): number {
  const row = q.get<{ days: number | null }>(
    "SELECT json_extract(data, '$.mail.followUpDays') AS days FROM settings WHERE id = 1",
  );
  const days = Number(row?.days);
  return days > 0 ? days : 3;
}

/**
 * The thread's newest owner-sent message (never a draft), hashed like `inputHashOf`. A new reply or a new sent
 * message moves it — that is what retires a stored suggestion and re-keys the `followup:<thread>:<hash>` job.
 */
export function lastSentHashOf(
  q: StoreReader,
  threadRowId: number,
): { hash: string; remoteId: string } | undefined {
  const m = q.get<{ remote_id: string; internal_date: number }>(
    `SELECT remote_id, internal_date FROM messages
     WHERE thread_id = ? AND (flags & ?) = ? ORDER BY internal_date DESC, id DESC LIMIT 1`,
    threadRowId,
    FLAG.draft | FLAG.fromMe,
    FLAG.fromMe,
  );
  return m
    ? { hash: fnv([`${m.remote_id}:${m.internal_date}`]), remoteId: m.remote_id }
    : undefined;
}

/**
 * Home's Follow up lane on raw tables — `followOf`'s rules: the thread still awaits a reply, the owner's last
 * message went out more than `followUpDays` ago, nothing inbound is newer, and it sits in Sent, not Spam/Trash.
 */
export function followEligible(
  q: StoreReader,
  threadRowId: number,
  now: number,
  followUpDays: number,
): boolean {
  const t = q.get<{
    last_date: number;
    last_inbound_date: number | null;
    reply_status: string | null;
  }>(
    `SELECT t.last_date, t.last_inbound_date, w.reply_status
     FROM threads t LEFT JOIN thread_workflow w ON w.thread_id = t.id WHERE t.id = ?`,
    threadRowId,
  );
  if (!t || t.reply_status !== 'awaitingReply') return false;
  if (t.last_date > now - followUpDays * DAY_MS) return false;
  if (t.last_inbound_date !== null && t.last_inbound_date >= t.last_date) return false;
  const roles = q
    .all<{ role: string | null }>(
      `SELECT f.role FROM thread_folders tf JOIN folders f ON f.id = tf.folder_id WHERE tf.thread_id = ?`,
      threadRowId,
    )
    .map(r => r.role);
  if (roles.some(r => r === 'trash' || r === 'spam')) return false;
  return roles.includes('sent');
}

export interface FollowCandidate {
  [k: string]: string | number | null;
  id: number;
  account_id: string;
  remote_id: string;
  last_date: number;
}

/**
 * Threads on AI-allowed accounts meeting every Follow up rule but the wait (a `cutoff` requires it too),
 * longest-waiting first. The folder EXISTS/NOT EXISTS keeps Sent in and Spam/Trash out, exactly as
 * `priorityOf`'s ban does.
 */
export function followScan(
  q: StoreReader,
  cutoff: number | undefined,
  limit: number,
): FollowCandidate[] {
  const aged = cutoff === undefined ? '' : 'AND t.last_date <= ?';
  return q.all<FollowCandidate>(
    `SELECT t.id, t.account_id, t.remote_id, t.last_date
     FROM threads t
     JOIN accounts a ON a.id = t.account_id AND a.ai_allowed = 1
     JOIN thread_workflow w ON w.thread_id = t.id AND w.reply_status = 'awaitingReply'
     WHERE (t.last_inbound_date IS NULL OR t.last_inbound_date < t.last_date)
       ${aged}
       AND EXISTS (SELECT 1 FROM thread_folders tf JOIN folders f ON f.id = tf.folder_id
                   WHERE tf.thread_id = t.id AND f.role = 'sent')
       AND NOT EXISTS (SELECT 1 FROM thread_folders tf JOIN folders f ON f.id = tf.folder_id
                       WHERE tf.thread_id = t.id AND f.role IN ('trash','spam'))
     ORDER BY t.last_date
     LIMIT ?`,
    ...(cutoff === undefined ? [limit] : [cutoff, limit]),
  );
}

/** The bounded candidate set `nextFollowAt` scans; a miss only delays one thread until the next fire or wake. */
const FOLLOW_SCAN_LIMIT = 50;

/**
 * When the first not-yet-queued thread enters the Follow up lane — the `jobs` deadline's other clock, so a
 * drained queue still wakes for a thread that ages in. A candidate holding a job under its CURRENT last-sent
 * hash needs no wake (its row's own `next_at` covers it); a stale-keyed row does not suppress the new hash's
 * deadline, so a fresh sent message queues again.
 */
export function nextFollowAt(q: StoreReader): number | undefined {
  const days = followUpDaysOf(q);
  for (const r of followScan(q, undefined, FOLLOW_SCAN_LIMIT)) {
    const sent = lastSentHashOf(q, r.id);
    if (!sent) continue;
    const key = `followup:${r.account_id}:${r.remote_id}:${sent.hash}`;
    if (q.get('SELECT 1 AS one FROM jobs WHERE key = ?', key)) continue;
    return r.last_date + days * DAY_MS;
  }
  return undefined;
}
