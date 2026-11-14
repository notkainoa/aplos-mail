import type { CommitExtension, CommitExtensionTx, IngestBatch, StorePort } from '../store/port';
import { StoreError } from '../store/port';

declare module '../store/port' {
  interface ExtensionWrites {
    job: JobWrite;
    summary: SummaryWrite;
    aiUsage: AiUsageWrite;
    conversation: ConversationWrite;
    plan: PlanWrite;
  }
}

/**
 * eng-ai's lane writes (seam 2): `jobs`, `summaries`, `ai_usage` and `conversations` (consent lives in
 * `consent.ts`). A summary touches its Thread change row (`tx.touchThread`) so Home refreshes without a new type;
 * `jobs` lifecycle: `enqueue` inserts under the singleton key (a second enqueue is a no-op), `claim` moves a due
 * row to `running`, `settle` lands the outcome, `requeue` gives a row a fresh 5-attempt budget (manual retry, force
 * refresh, a paused `running` row released by the gate or the daily cap), `defer` pushes due rows out (a gate
 * pause), `wake` pulls them back when the gate opens, `reset` re-queues `running` rows after a crash, `delete`
 * removes a row. A `conversations` row key is `<conversationId>:<pos>` — the PK is `id`, so turns share the
 * prefix and order by `pos`.
 */
export interface JobWrite {
  kind: 'job';
  action: 'enqueue' | 'claim' | 'settle' | 'requeue' | 'defer' | 'wake' | 'reset' | 'delete';
  /** `claim`/`settle`/`requeue`/`delete`; `defer` without it moves every due row. */
  id?: number;
  /** `enqueue`: the row to insert. */
  job?: { kind: string; key: string; priority: number; payload: string; nextAt: number };
  /** `claim`/`defer` (the due bound for the bulk form). */
  at?: number;
  /** `settle`. */
  state?: 'done' | 'failed' | 'dead' | 'skipped';
  /** `settle`: the classified problem, never provider text. */
  lastError?: string | null;
  /** `settle`/`requeue`/`defer`: the next due time. */
  nextAt?: number;
  /** `requeue`: the attempt count to keep — a catch-up re-arm of a `dead` row pays one call, not five. */
  attempts?: number;
}

/** One `summaries` row, keyed by the thread's input hash (a label change must not invalidate it). */
export interface SummaryWrite {
  kind: 'summary';
  accountId: string;
  remoteThreadId: string;
  inputHash: string;
  model: string;
  text: string;
  /** A `SuggestedAction` serialized; `null` clears. */
  action?: string | null;
  /** `pending` is the queued-work placeholder a Home row shows until the job's `ready`/`failed` write lands. */
  state: 'ready' | 'stale' | 'failed' | 'pending';
}

/**
 * One `plans` row (an AI-found date or meeting): `put` inserts a proposal under its input hash and marks the `Plan`
 * change row `<accountId>:plan-<rowid>`; `settle` moves it to `confirmed`/`dismissed` and bumps `rev`.
 */
export interface PlanWrite {
  kind: 'plan';
  action: 'put' | 'claim' | 'release' | 'settle';
  /** `settle`: the numeric row id. */
  id?: number;
  accountId?: string;
  /** `claim`: the resolved calendar (`acct:remote`) pinned for this confirmation. */
  calendarId?: string;
  remoteThreadId?: string;
  inputHash?: string;
  messageRemoteId?: string;
  fromName?: string;
  quote?: string;
  title?: string;
  startUtc?: number;
  startDate?: string;
  endUtc?: number;
  endDate?: string;
  allDay?: boolean;
  timeZone?: string;
  location?: string;
  model?: string;
  state?: 'open' | 'confirmed' | 'dismissed';
  eventId?: string;
  opId?: string;
}

/** Token accounting per day, provider, model and lane (ARCH 8.4); no change row. */
export interface AiUsageWrite {
  kind: 'aiUsage';
  day: string;
  provider: string;
  model: string;
  lane: 'interactive' | 'background';
  requests?: number;
  tokensIn?: number;
  tokensOut?: number;
}

/** One `conversations` row (an Ask turn); `pos` absent appends. `remove` drops the conversation. */
export interface ConversationWrite {
  kind: 'conversation';
  id: string;
  pos?: number;
  data?: string;
  remove?: boolean;
}

/** Write kinds only `ai/impl` commits (plan, summary, aiUsage, conversation) live in `ai/impl/ai-writes`
 * — the core budget's seam. They register at module load; `job` stays here because `Queue/*` methods
 * write it without ai loaded. */
export interface AiWriteImpls {
  plan: (write: PlanWrite, tx: CommitExtensionTx) => void;
  summary: (write: SummaryWrite, tx: CommitExtensionTx) => void;
  aiUsage: (write: AiUsageWrite, tx: CommitExtensionTx) => void;
  conversation: (write: ConversationWrite, tx: CommitExtensionTx) => void;
}
let impls: AiWriteImpls | undefined;
export const registerAiWrites = (i: AiWriteImpls): void => {
  impls = i;
};
const aiWrite = (kind: keyof AiWriteImpls, write: never, tx: CommitExtensionTx): void => {
  const i = impls;
  if (!i) throw new StoreError('invalid', 'ai write');
  i[kind](write, tx);
};

const bad = (): never => {
  throw new StoreError('invalid', 'ai write');
};

/** Mark an `AiJob` change when the update landed. */
const ok = (tx: CommitExtensionTx, r: { changes: number }, label: string) => {
  if (r.changes) tx.mark('AiJob', label, 'u');
};

function jobEnqueue(write: JobWrite, tx: CommitExtensionTx): void {
  const j = write.job;
  if (
    !j ||
    !j.kind ||
    !j.key ||
    j.key.length > 300 ||
    !Number.isInteger(j.priority) ||
    typeof j.payload !== 'string' ||
    j.payload.length > 20_000 ||
    !Number.isFinite(j.nextAt)
  )
    bad();
  ok(
    tx,
    tx.run(
      "INSERT OR IGNORE INTO jobs(kind, key, priority, payload, state, attempts, next_at) VALUES(?, ?, ?, ?, 'queued', 0, ?)",
      j!.kind,
      j!.key,
      j!.priority,
      j!.payload,
      j!.nextAt,
    ),
    j!.key,
  );
}

function jobClaim(write: JobWrite, id: number, sid: string, tx: CommitExtensionTx): void {
  if (!Number.isFinite(write.at)) bad();
  ok(
    tx,
    tx.run(
      "UPDATE jobs SET state = 'running', attempts = attempts + 1 WHERE id = ? AND state IN ('queued','failed') AND next_at <= ?",
      id,
      write.at!,
    ),
    sid,
  );
}

function jobSettle(write: JobWrite, id: number, sid: string, tx: CommitExtensionTx): void {
  if (
    write.state !== 'done' &&
    write.state !== 'failed' &&
    write.state !== 'dead' &&
    write.state !== 'skipped'
  )
    bad();
  ok(
    tx,
    tx.run(
      "UPDATE jobs SET state = ?, last_error = ?, next_at = ? WHERE id = ? AND state = 'running'",
      write.state!,
      write.lastError === undefined ? null : (write.lastError?.slice(0, 1_000) ?? null),
      write.nextAt ?? tx.now(),
      id,
    ),
    sid,
  );
}

function jobMove(write: JobWrite, id: number, sid: string, tx: CommitExtensionTx): void {
  switch (write.action) {
    case 'requeue':
      // A fresh retry budget: manual retry, a forced refresh, a settled row a catch-up re-arms (queueSummary
      // requeues `dead`/`skipped`/`done`), or a paused `running` row the gate released.
      return ok(
        tx,
        tx.run(
          "UPDATE jobs SET state = 'queued', attempts = ?, next_at = ? WHERE id = ? AND state IN ('queued','running','failed','dead','done','skipped')",
          write.attempts ?? 0,
          write.nextAt ?? tx.now(),
          id,
        ),
        sid,
      );
    case 'defer':
      if (!Number.isFinite(write.nextAt)) bad();
      if (Number.isInteger(write.id))
        return ok(
          tx,
          tx.run(
            "UPDATE jobs SET next_at = ? WHERE id = ? AND state IN ('queued','failed')",
            write.nextAt!,
            id,
          ),
          sid,
        );
      // The whole-queue pause: every due row moves so `next()` sleeps until the horizon, marked so a
      // later `wake` pulls back only rows the pause deferred — provider backoffs keep their schedule.
      if (!Number.isFinite(write.at)) bad();
      return ok(
        tx,
        tx.run(
          "UPDATE jobs SET next_at = ?, last_error = 'ai.paused' WHERE state IN ('queued','failed') AND next_at <= ?",
          write.nextAt!,
          write.at!,
        ),
        '*',
      );
    case 'delete':
      if (tx.run('DELETE FROM jobs WHERE id = ?', id).changes) tx.mark('AiJob', sid, 'd');
      return;
    case 'wake': {
      const at = write.at ?? tx.now();
      return ok(
        tx,
        tx.run(
          "UPDATE jobs SET next_at = ? WHERE state IN ('queued','failed') AND next_at > ?",
          at,
          at,
        ),
        '*',
      );
    }
    case 'reset':
      return ok(tx, tx.run("UPDATE jobs SET state = 'queued' WHERE state = 'running'"), '*');
  }
}

function job(write: JobWrite, tx: CommitExtensionTx): void {
  if (write.action === 'enqueue') return jobEnqueue(write, tx);
  if (write.action === 'wake' || write.action === 'reset') return jobMove(write, 0, '*', tx);
  if (write.action === 'defer' && write.id === undefined) return jobMove(write, 0, '*', tx);
  if (!Number.isInteger(write.id)) bad();
  const id = write.id!;
  const sid = String(id);
  if (write.action === 'claim') return jobClaim(write, id, sid, tx);
  if (write.action === 'settle') return jobSettle(write, id, sid, tx);
  return jobMove(write, id, sid, tx);
}

function apply(write: { kind: string }, tx: CommitExtensionTx): void {
  switch (write.kind) {
    case 'job':
      return job(write as JobWrite, tx);
    case 'summary':
      return aiWrite('summary', write as never, tx);
    case 'aiUsage':
      return aiWrite('aiUsage', write as never, tx);
    case 'plan':
      return aiWrite('plan', write as never, tx);
    case 'conversation':
      return aiWrite('conversation', write as never, tx);
  }
}

/**
 * Seam 2 (the missing summary trigger): a commit that stores mail drops one `wake` sentinel per touched thread.
 * The sentinel's key never changes, so `ON CONFLICT` dedupes a live one and re-arms a settled one; eligibility,
 * priority and the real `summary` job are all decided by the `jobs` runner's lazy pass (`ai/impl/jobs.ts`), so
 * this eagerly-loaded hook runs no AI SQL. `ok`'s `AiJob` mark wakes the `jobs` deadline once the commit lands.
 */
/** The `wake` job that makes the runner catch existing mail up after an AI settings or `ai_allowed` change. */
export const aiBackfillWrite = (nextAt: number): JobWrite => ({
  kind: 'job',
  action: 'enqueue',
  job: { kind: 'wake', key: 'ai:backfill', priority: 5, payload: '{}', nextAt },
});

/**
 * Arms the `ai:backfill` sentinel in its own commit. It cannot ride the caller's commit: a store opened without
 * the eng-ai lane has no `job` writer, and the catch-up must never fail the caller. The runner deletes the row
 * when it fires, so the next settings/account/consent change re-arms it.
 */
export const requestAiCatchUp = (store: StorePort, at: number): void => {
  try {
    store.commit({
      // The seq keeps the opId fresh: two changes inside one clock tick must each arm the sentinel.
      opId: `ai-catchup-${at}-${store.seq()}`,
      origin: 'system',
      writes: [aiBackfillWrite(at)],
    });
  } catch {
    /* no eng-ai lane on this store: no jobs table use means nothing to catch up */
  }
};

const BACKFILL_WAKE_SQL = `INSERT OR IGNORE INTO jobs(kind,key,priority,payload,state,next_at) VALUES('wake','ai:backfill',9,'{}','queued',?)`;

function aiIngest(batch: IngestBatch, tx: CommitExtensionTx): void {
  // Only mail a live-delivery step first stores arms a sentinel: baseline, backfill and resync pages (and
  // imports) rely on the bounded `ai:backfill` catch-up instead, and a flag-only update of a known message
  // changes no summary input — otherwise one first sync writes a sentinel per stored row.
  const incremental =
    (batch.step === undefined || batch.step === 'incremental') && batch.origin !== 'import';
  // A slip inside this hook must cost only the sentinel writes, never the caller's mail: the savepoint scopes
  // the rollback, and the bounded `ai:backfill` sentinel still asks the runner for a catch-up over whatever
  // this batch missed (the runner logs a catch-up failure under `ai.backfill_failed`).
  try {
    tx.run('SAVEPOINT ai_i');
    let armed = false;
    if (!incremental) {
      // Bulk mail (baseline/resync/import pages) gets one bounded catch-up sentinel per commit, not a row per
      // thread — the runner's BACKFILL_LIMIT scan covers it, and a newly added account's first sync is how
      // its already-stored mail gets queued at all.
      if (batch.messages.some(m => m.added))
        armed = tx.run(BACKFILL_WAKE_SQL, tx.now()).changes > 0;
    } else
      for (const m of batch.messages) {
        // A sentinel is written only where it can lead: new mail on an AI-allowed account (the EXISTS joins the
        // account row into the insert) — not a stored search hit, not a draft, not mail filed into Spam/Trash.
        if (
          !m.added ||
          m.origin === 'search' ||
          m.flags.draft ||
          m.roles.includes('spam') ||
          m.roles.includes('trash')
        )
          continue;
        const r = tx.run(
          `INSERT INTO jobs(kind,key,priority,payload,state,next_at) SELECT 'wake',?,5,'{}','queued',? WHERE EXISTS(SELECT 1 FROM accounts WHERE id=? AND ai_allowed=1) ON CONFLICT(key) DO UPDATE SET state='queued',attempts=0,next_at=?`,
          `ingest:${m.accountId}:${m.remoteThreadId}`,
          tx.now(),
          m.accountId,
          tx.now(),
        );
        if (r.changes) armed = true;
      }
    // One mark per commit no matter the page size: the `AiJob` change row is what pokes the `jobs` deadline
    // (`observeCommits` in runtime/engine), and a bulk sync must not turn one row per message into a row storm.
    if (armed) tx.mark('AiJob', 'ingest', 'u');
    tx.run('RELEASE ai_i');
  } catch {
    try {
      tx.run('ROLLBACK TO SAVEPOINT ai_i');
      tx.run('RELEASE ai_i');
      // The thread-level detail is gone — arm the bounded catch-up so a retry can still find this mail.
      tx.run(BACKFILL_WAKE_SQL, tx.now());
      tx.mark('AiJob', 'ingest', 'u');
    } catch {
      /* even the fallback slipped — the mail commit still lands */
    }
  }
}

export const aiWritesExtension: CommitExtension = {
  lane: 'eng-ai',
  kinds: ['job', 'summary', 'aiUsage', 'conversation', 'plan'],
  changeTypes: ['AiJob', 'Conversation', 'Plan'],
  apply,
  ingest: aiIngest,
};
