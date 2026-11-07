import type { EngineServices } from '../../runtime/services';
import { enqueue, inputHashOf, priorityOf } from './jobs';

/**
 * The one-shot Setup backfill (ai-3): when the first-sync screen ends, queue a `summary` job for every thread that
 * is visible on Home or unread in the Inbox, on accounts with `ai_allowed = 1`, that has no summary for its current
 * input hash. Never Spam/Trash-only threads. The queue's own gate decides when they actually run — a setup that
 * ends before consent just leaves the jobs waiting, and `Consent/grant`'s wake pulls them forward.
 */
const BACKFILL_LIMIT = 500;

interface Candidate {
  accountId: string;
  remoteId: string;
  threadRowId: number;
  priority: number;
}

function candidates(services: EngineServices): Candidate[] {
  return services.store.read(q => {
    const out: Candidate[] = [];
    for (const t of q.all<{
      id: number;
      account_id: string;
      remote_id: string;
      status: string;
      hidden_from_home: number;
      unread: number;
    }>(
      `SELECT t.id, t.account_id, t.remote_id, w.status, w.hidden_from_home, t.unread_count AS unread
       FROM threads t
       JOIN accounts a ON a.id = t.account_id AND a.ai_allowed = 1
       LEFT JOIN thread_workflow w ON w.thread_id = t.id
       WHERE t.msg_count > 0
       ORDER BY t.last_date DESC
       LIMIT ?`,
      BACKFILL_LIMIT * 4,
    )) {
      const p = priorityOf(q, t.account_id, t.remote_id);
      if (p === undefined || p.priority > 1) continue;
      const { hash, messageCount } = inputHashOf(q, t.id);
      if (!messageCount) continue;
      const fresh = q.get(
        'SELECT 1 AS one FROM summaries WHERE thread_id = ? AND input_hash = ? AND state != ?',
        t.id,
        hash,
        'failed',
      );
      if (fresh) continue;
      out.push({
        accountId: t.account_id,
        remoteId: t.remote_id,
        threadRowId: t.id,
        priority: p.priority,
      });
      if (out.length >= BACKFILL_LIMIT) break;
    }
    return out;
  });
}

/** Queue a `summary` job per eligible thread; idempotent — the singleton key makes a re-run a no-op. */
export function backfillSummaries(services: EngineServices): number {
  const now = services.clock.now();
  let queued = 0;
  for (const c of candidates(services)) {
    const { hash } = services.store.read(q => inputHashOf(q, c.threadRowId));
    enqueue(services, `ai-backfill-${c.threadRowId}-${hash}`, {
      kind: 'summary',
      key: `summary:${c.accountId}:${c.remoteId}:${hash}`,
      priority: c.priority,
      nextAt: now,
      payload: {
        threadId: `${c.accountId}:${c.remoteId}`,
        accountId: c.accountId,
        remoteThreadId: c.remoteId,
        inputHash: hash,
      },
    });
    queued++;
  }
  return queued;
}
