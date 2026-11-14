import type { EngineServices } from '../../runtime/services';
import { StoreError } from '../../store/port';
import { hexId } from '../../sync/connect-sessions';
import {
  enqueue,
  FOLLOWUP_PRIORITY,
  followScan,
  followUpDaysOf,
  inputHashOf,
  lastSentHashOf,
  priorityOf,
  queueSummary,
} from './jobs';
import './ai-writes';

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
      // Only a landed `ready` row skips the thread: `queueSummary` decides the rest — a `pending` row whose
      // job died re-queues it, and `failed`/`stale` rows get another run.
      const fresh = q.get(
        'SELECT 1 AS one FROM summaries WHERE thread_id = ? AND input_hash = ? AND state = ?',
        t.id,
        hash,
        'ready',
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

/**
 * The settings-change catch-up: `Setup/end` backfills once and the store's ingest hook queues on new mail, but
 * neither sees mail that already exists when AI is switched on later — a Summaries provider picked, `ai.background`
 * enabled, or an account's `ai_allowed` flipped. Re-runs the same bounded scan; a failure is logged, never thrown
 * into a settings commit.
 */
export function catchUpSummaries(services: EngineServices): void {
  try {
    backfillSummaries(services);
  } catch (error) {
    try {
      services.log.event('ai.backfill_failed', {
        code: error instanceof StoreError ? error.code : 'ai.backfill',
      });
    } catch {
      // A logless host keeps the queue honest anyway — the catch-up must never throw into a commit's caller.
    }
  }
}

/** Queue a `summary` job per eligible thread; idempotent — the singleton key makes a re-run a no-op. */
export function backfillSummaries(services: EngineServices): number {
  let queued = 0;
  for (const c of candidates(services)) {
    queueSummary(services, c.accountId, c.remoteId);
    queued++;
  }
  sweepFollowups(services);
  return queued;
}

const DAY_MS = 86_400_000;
/** A sweep queues at most this many follow-up jobs per pass; the rest wait for the next fire. */
const FOLLOW_SWEEP_LIMIT = 50;

/**
 * The Follow up half of the queue (ARCH 8.1): every thread sitting in Home's Follow up lane on an AI-allowed
 * account gets a `followup` job under its current last-sent hash, at the flat follow-up priority. A new reply
 * or a new sent message changes the hash, so the next pass queues fresh work while the old suggestion expires
 * on read — no cleanup. Spam/Trash threads and kept-out accounts never appear in `followScan`. Runs on every
 * `jobs` fire: the singleton key makes repeats no-ops, so the pass costs one bounded scan when nothing moved.
 */
export function sweepFollowups(services: EngineServices): number {
  const now = services.clock.now();
  const cutoff = now - services.store.read(q => followUpDaysOf(q)) * DAY_MS;
  let queued = 0;
  for (const c of services.store.read(q => followScan(q, cutoff, FOLLOW_SWEEP_LIMIT))) {
    const sent = services.store.read(q => lastSentHashOf(q, c.id));
    if (!sent) continue;
    const key = `followup:${c.account_id}:${c.remote_id}:${sent.hash}`;
    const have = services.store.read(q => q.get('SELECT 1 AS one FROM jobs WHERE key = ?', key));
    if (have) continue;
    enqueue(services, `ai-follow-${c.id}-${sent.hash}-${hexId(services.randomBytes, 'q')}`, {
      kind: 'followup',
      key,
      priority: FOLLOWUP_PRIORITY,
      nextAt: now,
      payload: {
        threadId: `${c.account_id}:${c.remote_id}`,
        accountId: c.account_id,
        remoteThreadId: c.remote_id,
        inputHash: sent.hash,
      },
    });
    queued++;
  }
  return queued;
}
