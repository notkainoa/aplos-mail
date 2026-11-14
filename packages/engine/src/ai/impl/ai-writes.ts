/** The write kinds only `ai/impl` commits — lazy here for the core budget; `registerAiWrites` in
 * `ai/writes.ts` binds them at module load, so `laneExtensions` stays sync. */
import { ContractError } from '@aplos/contract/contract-error';
import { StoreError } from '../../store/port';
import { registerAiWrites } from '../writes';
import type { CommitExtensionTx } from '../../store/port';
import type { AiUsageWrite, ConversationWrite, PlanWrite, SummaryWrite } from '../writes';

const bad = (): never => {
  throw new StoreError('invalid', 'ai write');
};

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

registerAiWrites({ plan: planWrite, summary, aiUsage, conversation });
