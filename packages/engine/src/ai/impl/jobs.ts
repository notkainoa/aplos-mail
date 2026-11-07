import type { AiJob } from '@aplos/contract';
import type { StoreReader } from '../../store/port';
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

/** A small deterministic hash of the thread's summary inputs (a label change must not invalidate it). */
export function inputHashOf(
  q: StoreReader,
  threadRowId: number,
): { hash: string; messageCount: number } {
  const rows = q.all<{ remote_id: string; internal_date: number; snippet: string | null }>(
    'SELECT remote_id, internal_date, snippet FROM messages WHERE thread_id = ? ORDER BY id',
    threadRowId,
  );
  let h = 0x811c9dc5;
  const mix = (s: string) => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
  };
  for (const r of rows) mix(`${r.remote_id}:${r.internal_date}:${r.snippet?.length ?? 0}\n`);
  return { hash: (h >>> 0).toString(16), messageCount: rows.length };
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
  if (roles.length > 0 && roles.every(r => r === 'trash' || r === 'spam')) return undefined;
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
  if (!row) throw new Error('job enqueue did not land');
  return row;
}

/** A wire thread id back to `{accountId, remoteThreadId}`; `undefined` when unknown. */
export const splitThreadId = (q: StoreReader, threadId: string) => splitId(q, threadId);
