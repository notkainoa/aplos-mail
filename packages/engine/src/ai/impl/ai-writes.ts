/** The write kinds only `ai/impl` commits — lazy here for the core budget; `registerAiWrites` in
 * `ai/writes.ts` binds them at module load, so `laneExtensions` stays sync. */
import { ContractError } from '@aplos/contract/contract-error';
import { StoreError } from '../../store/port';
import { BACKFILL_WAKE_SQL, registerAiWrites } from '../writes';
import type { CommitExtensionTx, IngestBatch } from '../../store/port';
import type { AiUsageWrite, ConversationWrite, JobWrite, PlanWrite, SummaryWrite } from '../writes';

const bad = (): never => {
  throw new StoreError('invalid', 'ai write');
};

/** Mark an `AiJob` change when the update landed. */
const ok = (tx: CommitExtensionTx, r: { changes: number }, label: string) => {
  if (r.changes) tx.mark('AiJob', label, 'u');
};

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

/** Every `job` action but `enqueue` (that one stays in `ai/writes.ts` for the ingest/catch-up callers). */
function jobWrite(write: JobWrite, tx: CommitExtensionTx): void {
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
    `UPDATE plans SET state = 'confirming', op_id = ?, calendar_id = ?, rev = rev + 1
     WHERE id = ? AND account_id = ? AND state = 'open'`,
    write.opId!,
    write.calendarId ?? null,
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
  const dismissed = write.state === 'dismissed' ? 1 : 0;
  const r = tx.run(
    `UPDATE plans SET state = ?, event_id = COALESCE(?, event_id), op_id = COALESCE(?, op_id),
       rev = rev + 1
     WHERE id = ? AND account_id = ?
       AND ((state = 'confirming' AND ? = 0) OR (state IN ('open','confirming') AND ? = 1))`,
    write.state!,
    write.eventId ?? null,
    write.opId ?? null,
    write.id!,
    accountId!,
    dismissed,
    dismissed,
  );
  if (r.changes && row) tx.mark('Plan', `${row.account_id}:plan-${write.id}`, 'u');
}

export function planWrite(write: PlanWrite, tx: CommitExtensionTx): void {
  if (write.action === 'put') planPut(write, tx);
  else if (write.action === 'claim') planClaim(write, tx);
  else if (write.action === 'release') planRelease(write, tx);
  else if (write.action === 'settle') planSettle(write, tx);
  else bad();
}

function summary(write: SummaryWrite, tx: CommitExtensionTx): void {
  const rowId = tx.threadRowId(write.accountId, write.remoteThreadId);
  if (rowId === undefined) bad();
  if (
    typeof write.inputHash !== 'string' ||
    !write.inputHash ||
    typeof write.model !== 'string' ||
    typeof write.text !== 'string' ||
    (write.state !== 'ready' &&
      write.state !== 'stale' &&
      write.state !== 'failed' &&
      write.state !== 'pending') ||
    (write.state === 'ready' && !write.model)
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

/** A live-mail sentinel: the EXISTS joins the account row so an AI-kept-out account arms nothing. */
const THREAD_WAKE_SQL = `INSERT INTO jobs(kind,key,priority,payload,state,next_at) SELECT 'wake',?,5,'{}','queued',? WHERE EXISTS(SELECT 1 FROM accounts WHERE id=? AND ai_allowed=1) ON CONFLICT(key) DO UPDATE SET state='queued',attempts=0,next_at=?`;

/**
 * The ingest hook's body — `ai/writes.ts#aiIngest` runs it inside `SAVEPOINT ai_i`, so a slip here rolls back
 * only these writes. Only mail a live-delivery step first stores arms a per-thread sentinel (baseline, backfill
 * and resync pages and imports arm one bounded `ai:backfill` sentinel instead — a first sync must not write a
 * row per stored thread), and only where it can lead: not a stored search hit, not a draft, not Spam/Trash mail.
 */
function ingest(batch: IngestBatch, tx: CommitExtensionTx): void {
  const incremental =
    (batch.step === undefined || batch.step === 'incremental') && batch.origin !== 'import';
  let armed = false;
  if (!incremental) {
    if (batch.messages.some(m => m.added)) armed = tx.run(BACKFILL_WAKE_SQL, tx.now()).changes > 0;
  } else
    for (const m of batch.messages) {
      if (
        !m.added ||
        m.origin === 'search' ||
        m.flags.draft ||
        m.roles.includes('spam') ||
        m.roles.includes('trash')
      )
        continue;
      const r = tx.run(
        THREAD_WAKE_SQL,
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
}

registerAiWrites({ job: jobWrite, plan: planWrite, summary, aiUsage, conversation, ingest });
