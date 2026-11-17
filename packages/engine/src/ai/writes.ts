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
  /** `defer` bulk form: scope the moved rows to these job kinds (one feature's pause); absent = whole queue. */
  kinds?: readonly string[];
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
  /** The ingest hook's body; `aiIngest` runs it inside `SAVEPOINT ai_i`. Absent until `ai/impl` first loads. */
  ingest: (batch: IngestBatch, tx: CommitExtensionTx) => void;
}
let impls: AiWriteImpls | undefined;
export const registerAiWrites = (i: AiWriteImpls): void => {
  impls = i;
};
const aiWrite = (kind: keyof AiWriteImpls, write: never, tx: CommitExtensionTx): void =>
  (impls ?? bad())[kind](write, tx);

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
      "INSERT OR IGNORE INTO jobs(kind, key, priority, payload, state, next_at) VALUES(?, ?, ?, ?, 'queued', ?)",
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
      // The pause: every due row moves so `next()` sleeps until the horizon — whole-queue, or one feature's
      // kinds — marked so a later `wake` pulls back only rows the pause deferred — provider backoffs keep
      // their schedule.
      if (!Number.isFinite(write.at)) bad();
      return ok(
        tx,
        tx.run(
          `UPDATE jobs SET next_at = ?, last_error = 'ai.paused' WHERE state IN ('queued','failed') AND next_at <= ?${write.kinds?.length ? ` AND kind IN(${write.kinds.map(() => '?').join()})` : ''}`,
          write.nextAt!,
          write.at!,
          ...(write.kinds ?? []),
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
  if (
    write.action === 'wake' ||
    write.action === 'reset' ||
    (write.action === 'defer' && write.id === undefined)
  )
    return jobMove(write, 0, '*', tx);
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
 * priority and the real `summary` job are all decided by the `jobs` runner's lazy pass (`ai/impl/jobs.ts`). The
 * hook's body lives with the other impl writes (`ai/impl/ai-writes`) for the core budget; the `AiJob` mark wakes
 * the `jobs` deadline once the commit lands.
 */
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
      writes: [
        {
          kind: 'job',
          action: 'enqueue',
          job: { kind: 'wake', key: 'ai:backfill', priority: 5, payload: '{}', nextAt: at },
        },
      ],
    });
  } catch {
    /* no eng-ai lane on this store: no jobs table use means nothing to catch up */
  }
};

export const BACKFILL_WAKE_SQL = `INSERT OR IGNORE INTO jobs(kind,key,priority,payload,state,next_at) VALUES('wake','ai:backfill',9,'{}','queued',?)`;

function aiIngest(batch: IngestBatch, tx: CommitExtensionTx): void {
  // A slip inside this hook must cost only the sentinel writes, never the caller's mail: the savepoint scopes
  // the rollback, and the bounded `ai:backfill` sentinel still asks the runner for a catch-up over whatever
  // this batch missed (the runner logs a catch-up failure under `ai.backfill_failed`). The hook's body —
  // per-thread sentinels for live mail, the same catch-up arm for bulk pages — is `ai/impl/ai-writes#ingest`
  // (the core budget's seam, like the impl write kinds). A commit before `ai/impl` first loads still arms the
  // catch-up here so the mail is found once the runner is up.
  try {
    tx.run('SAVEPOINT ai_i');
    if (impls) impls.ingest(batch, tx);
    else if (batch.messages.some(m => m.added) && tx.run(BACKFILL_WAKE_SQL, tx.now()).changes)
      tx.mark('AiJob', 'ingest', 'u');
    tx.run('RELEASE ai_i');
  } catch (err) {
    try {
      tx.run('ROLLBACK TO SAVEPOINT ai_i');
      tx.run('RELEASE ai_i');
    } catch {
      // SQLite already rolled the whole transaction back itself (disk full, an I/O error, a trigger's
      // RAISE(ROLLBACK)): there is no savepoint to return to, and every write from here on would commit
      // outside any transaction — change rows and a `commits` row for mail that no longer exists. The
      // original error is what the caller must see; the commit fails and rolls back cleanly.
      throw err;
    }
    try {
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
