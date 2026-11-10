/**
 * The Importance menu's rule (owner request 2026-11-10): "Important" and "Low importance" are the two ends of the lane
 * move Home's ⌥↑ and ⌥↓ make. A thread in Do now or Important updates is Important; one in Low importance is Low.
 * Choosing the other end moves the thread there with the same absolute `lane` action Home uses.
 */
import type { Message, ThreadRow } from '../../data';
import { laneOf, type MovableLane } from '../home/homeModel';

/** The menu's two choices. */
export type Importance = 'important' | 'low';

export const IMPORTANCE_LABEL: Readonly<Record<Importance, string>> = {
  important: 'Important',
  low: 'Low importance',
};

/** The words of a lane in the "Moved to …" toast (the words Home's lane toast uses). */
export const LANE_LABEL: Readonly<Record<MovableLane, string>> = {
  do: 'Do now',
  update: 'Important updates',
  low: 'Low importance',
};

/** Which end the thread is at; null for a lane a newer engine added (the menu is then left out). */
export function importanceOf(row: ThreadRow): Importance | null {
  const lane = laneOf(row);
  if (lane === null) return null;
  return lane === 'low' ? 'low' : 'important';
}

/** The lane a choice moves the thread to; null when it is already there. A thread back from Low goes to Important updates. */
export function laneForChoice(row: ThreadRow, choice: Importance): MovableLane | null {
  const at = importanceOf(row);
  if (at === null || at === choice) return null;
  return choice === 'low' ? 'low' : 'update';
}

/** Whether an email triggered a notification: `unknown` when the engine did not say (mail older than its notification log): no bell is drawn. */
export type NotificationState = 'notified' | 'silent' | 'unknown';

/**
 * The bell's state for a message, from the engine's `Message.notification`: `sent` is a notification that posted;
 * `suppressed` (dropped at post time: notifications off, Focus) and `none` (never notified) are both a slashed bell;
 * absent, or a value a newer engine added, is `unknown` and draws no bell.
 */
export function notificationOf(message: Pick<Message, 'notification'>): NotificationState {
  switch (message.notification) {
    case 'sent':
      return 'notified';
    case 'suppressed':
    case 'none':
      return 'silent';
    default:
      return 'unknown';
  }
}
