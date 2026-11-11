/** The `plan` write handlers — lazy under `ai/impl` for the core bundle budget; `registerPlanWrites` in
 * `ai/writes.ts` binds them at module load. Everything that commits a plan write is in this folder. */
import { ContractError } from '@aplos/contract/contract-error';
import { StoreError } from '../../store/port';
import { registerPlanWrites } from '../writes';
import type { CommitExtensionTx } from '../../store/port';
import type { PlanWrite } from '../writes';

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
    `UPDATE plans SET state = ?, event_id = COALESCE(?, event_id), rev = rev + 1
     WHERE id = ? AND account_id = ?
       AND ((state = 'confirming' AND ? = 0) OR (state IN ('open','confirming') AND ? = 1))`,
    write.state!,
    write.eventId ?? null,
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

registerPlanWrites(planWrite);
