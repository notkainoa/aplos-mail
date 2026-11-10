import type { CommitExtension, CommitExtensionTx } from '../store/port';
import { ContractError } from '@aplos/contract/contract-error';
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
  state: 'ready' | 'stale' | 'failed';
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
      // A fresh retry budget: manual retry, a forced refresh, or a paused `running` row the gate released.
      return ok(
        tx,
        tx.run(
          "UPDATE jobs SET state = 'queued', attempts = 0, next_at = ? WHERE id = ? AND state IN ('queued','running','failed','dead','done')",
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

function summary(write: SummaryWrite, tx: CommitExtensionTx): void {
  const rowId = tx.threadRowId(write.accountId, write.remoteThreadId);
  if (rowId === undefined) bad();
  if (
    typeof write.inputHash !== 'string' ||
    !write.inputHash ||
    typeof write.model !== 'string' ||
    !write.model ||
    typeof write.text !== 'string' ||
    (write.state !== 'ready' && write.state !== 'stale' && write.state !== 'failed')
  )
    bad();
  tx.run(
    'INSERT OR REPLACE INTO summaries(thread_id, input_hash, model, text, action, state, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)',
    rowId!,
    write.inputHash,
    write.model.slice(0, 200),
    write.text,
    write.action ?? null,
    write.state,
    tx.now(),
  );
  tx.touchThread(write.accountId, write.remoteThreadId);
}

function planParams(write: PlanWrite, tx: CommitExtensionTx): number {
  const threadId =
    typeof write.accountId === 'string' && typeof write.remoteThreadId === 'string'
      ? tx.threadRowId(write.accountId, write.remoteThreadId)
      : undefined;
  if (threadId === undefined || typeof write.title !== 'string' || !write.title) bad();
  const timed = write.startUtc !== undefined && write.endUtc !== undefined;
  const dated = write.startDate !== undefined && write.endDate !== undefined;
  if (timed === dated) bad();
  return threadId!;
}

function planPut(write: PlanWrite, tx: CommitExtensionTx): void {
  const threadId = planParams(write, tx);
  const r = tx.run(
    `INSERT INTO plans(account_id, thread_id, input_hash, message_remote_id, from_name, quote, title,
       start_utc, start_date, end_utc, end_date, all_day, time_zone, location, state, model, created_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
    write.accountId!,
    threadId!,
    (write.inputHash ?? '').slice(0, 100),
    write.messageRemoteId?.slice(0, 300) ?? null,
    write.fromName?.slice(0, 200) ?? null,
    write.quote?.slice(0, 1_000) ?? null,
    write.title!.slice(0, 1_000),
    write.startUtc ?? null,
    write.startDate ?? null,
    write.endUtc ?? null,
    write.endDate ?? null,
    write.allDay ? 1 : 0,
    write.timeZone?.slice(0, 60) ?? null,
    write.location?.slice(0, 2_000) ?? null,
    write.model?.slice(0, 200) ?? null,
    tx.now(),
  );
  if (r.changes) tx.mark('Plan', `${write.accountId}:plan-${r.lastInsertRowid}`, 'u');
}

function planClaim(write: PlanWrite, tx: CommitExtensionTx): void {
  if (!Number.isInteger(write.id) || typeof write.accountId !== 'string' || !write.opId) bad();
  const r = tx.run(
    `UPDATE plans SET state = 'confirming', op_id = ?, rev = rev + 1
     WHERE id = ? AND account_id = ? AND state = 'open'`,
    write.opId!,
    write.id!,
    write.accountId!,
  );
  if (!r.changes)
    throw new ContractError({
      type: 'conflict',
      message: 'This plan was already confirmed or dismissed.',
    });
}

/** `release`: a failed confirm hands the plan back to `open` — only the opId that claimed it may. */
function planRelease(write: PlanWrite, tx: CommitExtensionTx): void {
  if (!Number.isInteger(write.id) || typeof write.accountId !== 'string' || !write.opId) bad();
  const r = tx.run(
    `UPDATE plans SET state = 'open', op_id = NULL, rev = rev + 1
     WHERE id = ? AND account_id = ? AND state = 'confirming' AND op_id = ?`,
    write.id!,
    write.accountId!,
    write.opId!,
  );
  if (r.changes) tx.mark('Plan', `${write.accountId}:plan-${write.id}`, 'u');
}

function planSettle(write: PlanWrite, tx: CommitExtensionTx): void {
  if (!Number.isInteger(write.id) || typeof write.accountId !== 'string') bad();
  if (write.state !== 'confirmed' && write.state !== 'dismissed') bad();
  const accountId = write.accountId;
  if (write.state === 'confirmed' && !write.eventId) bad();
  const row = tx.get<{ account_id: string }>(
    'SELECT account_id FROM plans WHERE id = ?',
    write.id!,
  );
  const r = tx.run(
    `UPDATE plans SET state = ?, event_id = COALESCE(?, event_id), rev = rev + 1
     WHERE id = ? AND account_id = ? AND state = ?`,
    write.state!,
    write.eventId ?? null,
    write.id!,
    accountId!,
    write.state === 'confirmed' ? 'confirming' : 'open',
  );
  if (r.changes && row) tx.mark('Plan', `${row.account_id}:plan-${write.id}`, 'u');
}

function plan(write: PlanWrite, tx: CommitExtensionTx): void {
  if (write.action === 'put') planPut(write, tx);
  else if (write.action === 'claim') planClaim(write, tx);
  else if (write.action === 'release') planRelease(write, tx);
  else if (write.action === 'settle') planSettle(write, tx);
  else bad();
}

function aiUsage(write: AiUsageWrite, tx: CommitExtensionTx): void {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(write.day) ||
    !write.provider ||
    !write.model ||
    (write.lane !== 'interactive' && write.lane !== 'background')
  )
    bad();
  const n = (v: number | undefined) =>
    v === undefined || (Number.isFinite(v) && v >= 0) ? Math.floor(v ?? 0) : bad();
  tx.run(
    'INSERT INTO ai_usage(day, provider, model, lane, requests, tokens_in, tokens_out) VALUES(?, ?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(day, provider, model, lane) DO UPDATE SET requests = requests + excluded.requests, ' +
      'tokens_in = tokens_in + excluded.tokens_in, tokens_out = tokens_out + excluded.tokens_out',
    write.day,
    write.provider.slice(0, 60),
    write.model.slice(0, 200),
    write.lane,
    n(write.requests ?? 1),
    n(write.tokensIn),
    n(write.tokensOut),
  );
}

function conversation(write: ConversationWrite, tx: CommitExtensionTx): void {
  if (typeof write.id !== 'string' || !write.id || write.id.length > 200) bad();
  if (write.remove) {
    if (
      tx.run('DELETE FROM conversations WHERE id = ? OR id GLOB ?', write.id, `${write.id}:*`)
        .changes
    )
      tx.mark('Conversation', write.id, 'd');
    return;
  }
  if (typeof write.data !== 'string' || write.data.length > 200_000) bad();
  const pos =
    write.pos ??
    tx.get<{ p: number | null }>(
      'SELECT MAX(pos)+1 p FROM conversations WHERE id GLOB ?',
      `${write.id}:*`,
    )?.p ??
    0;
  tx.run(
    'INSERT OR REPLACE INTO conversations(id, pos, data) VALUES(?, ?, ?)',
    `${write.id}:${pos}`,
    pos,
    write.data!,
  );
  tx.mark('Conversation', write.id, 'u');
}

function apply(write: { kind: string }, tx: CommitExtensionTx): void {
  switch (write.kind) {
    case 'job':
      return job(write as JobWrite, tx);
    case 'summary':
      return summary(write as SummaryWrite, tx);
    case 'aiUsage':
      return aiUsage(write as AiUsageWrite, tx);
    case 'plan':
      return plan(write as PlanWrite, tx);
    case 'conversation':
      return conversation(write as ConversationWrite, tx);
  }
}

export const aiWritesExtension: CommitExtension = {
  lane: 'eng-ai',
  kinds: ['job', 'summary', 'aiUsage', 'conversation', 'plan'],
  changeTypes: ['AiJob', 'Conversation', 'Plan'],
  apply,
};
