import type { NotificationItem } from '@aplos/contract';
import type { FrameBus } from '../../runtime/frames';
import { dueText } from '../zone';

/** A deadline that fires this much after its time (or later) is "late": the Mac slept or the app was closed. */
export const LATE_AFTER_MS = 120_000;
/**
 * The deadline sources re-read their table at least this often. `Thread/act` and `Operation/undo` tell the loop
 * (`deadlines.changed`) after they move `reminder_at` or `later_until`, so this is the fallback only: a write that
 * bypasses the views lane (a sync of another device's workflow log, a host's direct commit) is found within a minute.
 */
export const RECHECK_MS = 60_000;

/** A thread whose deadline came due, as the sources read it. */
export interface DueThread {
  accountId: string;
  remoteId: string;
  subject: string | null;
  /** The deadline: `reminder_at` or `later_until`. */
  at: number;
}

/** A contract thread id: `accountId:remoteId` (ARCH 3.1). Built here, never parsed. */
export const threadIdOf = (row: Pick<DueThread, 'accountId' | 'remoteId'>) =>
  `${row.accountId}:${row.remoteId}`;

/** A thread subject as shown in a notice or `Reminder/list`: one line, at most 500 characters (the contract allows 2,000). */
export const clampTitle = (subject: string | null) =>
  (subject || '(no subject)').replace(/\s+/g, ' ').slice(0, 500);

/**
 * The host event's item. `wasDueAt` and "Was due 9:00 AM" appear only for a late fire (Decision 3), in the owner's zone.
 */
export function noticeFor(
  kind: 'reminder' | 'later',
  row: DueThread,
  firedAt: number,
  zone: string,
): NotificationItem {
  const late = firedAt - row.at >= LATE_AFTER_MS;
  return {
    id: `${kind}:${threadIdOf(row)}:${row.at}`,
    kind,
    accountId: row.accountId,
    threadId: threadIdOf(row),
    title: clampTitle(row.subject),
    at: firedAt,
    ...(late ? { wasDueAt: row.at, body: `Was due ${dueText(row.at, firedAt, zone)}` } : {}),
  };
}

/** Sends the `reminder` host event. One failing listener never stops the rest, so a throw is swallowed. */
export function announce(frames: Pick<FrameBus, 'emit'>, item: NotificationItem): void {
  try {
    frames.emit({ frame: 'host', event: { type: 'reminder', item } });
  } catch {
    // The fired reminder stays in `Reminder/list` until acked, which is the recovery path.
  }
}
