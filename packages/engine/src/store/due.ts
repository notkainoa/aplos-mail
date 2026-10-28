import {
  OVERDUE_GRACE_MS,
  WAITING_SUBMISSION_STATES,
  type WaitingSubmissionState,
} from '@aplos/contract/rules';
import type { StoreReader } from './port';

/**
 * The outbox's reads over `sub_due` (FR-2). Every submission that waits on `not_before` is in the index: `queued`
 * (inside the undo window) and `scheduled` (send later), `WAITING_SUBMISSION_STATES`. The overdue rule (ARCH 7.3) covers
 * both, so a send-later message that fell due while the Mac was off is suspended at wake ("Send now or Reschedule"),
 * never sent late. `sending` rows are not waiting: the start rule turns them `uncertain`, never `suspended`. The states
 * and the grace are defined once in `@aplos/contract/rules` (FR-2), never here.
 */
export interface DueSubmission {
  id: string;
  accountId: string;
  state: WaitingSubmissionState;
  notBefore: number;
}

// Spells out the index's own `state IN ('queued', 'scheduled')` term verbatim, so SQLite can use the partial index.
const WAITING = `state IN (${WAITING_SUBMISSION_STATES.map(s => `'${s}'`).join(', ')})`;
const DUE = `SELECT id, account_id AS accountId, state, not_before AS notBefore FROM submissions
  WHERE ${WAITING} AND not_before <= ? ORDER BY not_before, id`;
const NEXT = `SELECT min(not_before) AS at FROM submissions WHERE ${WAITING}`;

/** The earliest `not_before` of any waiting submission: the outbox registers it as its deadline. */
export function nextDueAt(q: StoreReader): number | undefined {
  return q.get<{ at: number | null }>(NEXT)?.at ?? undefined;
}

/**
 * Waiting submissions whose time has come, split by the overdue rule: `due` may go out now, `overdue` (more than
 * `OVERDUE_GRACE_MS` late) must become `suspended` instead. Oldest first.
 */
export function dueSubmissions(
  q: StoreReader,
  now: number,
): { due: DueSubmission[]; overdue: DueSubmission[] } {
  const due: DueSubmission[] = [],
    overdue: DueSubmission[] = [];
  for (const row of q.all<DueSubmission & Record<string, string | number>>(DUE, now))
    (now - row.notBefore > OVERDUE_GRACE_MS ? overdue : due).push({ ...row });
  return { due, overdue };
}

/** For the plan test: the SQL whose query plan must use `sub_due`. */
export const DUE_QUERIES = { due: DUE, next: NEXT } as const;
