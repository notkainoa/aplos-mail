/** Locked events, RSVP wording and undo modes. */
import type { Calendar, EpochMs, Event, Receipt } from '../../../data';
import type { CalendarEventData, RsvpAnswer } from '../../../ui/props';
import { isOrganizer, organizerFirstName } from './entries';

/**
 * Why an event cannot be changed here, in DESIGN 10's voice; the engine's `lockedReason` wins when given. RSVP follows
 * the engine's `can.rsvp`, not the calendar's `readOnly` (an invite on a read-only calendar may still be answered on
 * Google), so when a reply is still possible the sentence says so rather than imply nothing can be done (review1 2).
 */
export function lockedMessage(e: Event, calendar: Calendar | undefined): string {
  if (e.lockedReason?.trim()) return e.lockedReason.trim();
  const canReply = e.can.rsvp && !isOrganizer(e);
  if (calendar?.readOnly)
    return canReply
      ? `${calendar.name} is read-only. You can still reply.`
      : `${calendar.name} is read-only, so its events can't be changed here.`;
  const organizer = organizerFirstName(e);
  if (!isOrganizer(e)) {
    const only = organizer
      ? `Only ${organizer} can change this event.`
      : 'Only the organizer can change this event.';
    return canReply ? `${only} You can still reply.` : only;
  }
  return "This event can't be changed here.";
}

/** The answers' contract values (`Event/rsvp.response`). */
export const RESPONSE: Readonly<Record<RsvpAnswer, 'accepted' | 'tentative' | 'declined'>> = {
  yes: 'accepted',
  maybe: 'tentative',
  no: 'declined',
};

const ANSWER_WORD: Readonly<Record<RsvpAnswer, string>> = { yes: 'Yes', maybe: 'Maybe', no: 'No' };

/** The RSVP block while it shows: it starts with nothing chosen (DESIGN 7.8). */
export interface RsvpState {
  readonly eventId: string;
  readonly answer: RsvpAnswer | null;
  /** Opened by "Change your reply" on an answered invite. */
  readonly changing: boolean;
}

/** "Send reply" is enabled only once an answer is chosen, and when changing, a different one. */
export function canSendReply(
  rsvp: RsvpState | null,
  entry: CalendarEventData | undefined,
): boolean {
  if (!rsvp || rsvp.answer === null || !entry) return false;
  return !rsvp.changing || rsvp.answer !== (entry.myReply ?? null);
}

/** The toast while the answer is held and undoable, then once it has gone: "Replying Yes to Priya", "Replied Yes to Priya". */
export function rsvpMessage(
  answer: RsvpAnswer,
  organizer: string | undefined,
  phase: 'held' | 'sent',
): string {
  const verb = phase === 'held' ? 'Replying' : 'Replied';
  return organizer
    ? `${verb} ${ANSWER_WORD[answer]} to ${organizer}`
    : `${verb} ${ANSWER_WORD[answer]}`;
}

/** What Z does to a write: cancel it while it is held (`undoUntil`), else send its inverse, else nothing. */
export function undoMode(
  receipt: Pick<Receipt, 'undoUntil' | 'undoable'>,
  now: EpochMs,
): 'cancel' | 'inverse' | 'none' {
  if (receipt.undoUntil !== undefined && now < receipt.undoUntil) return 'cancel';
  return receipt.undoable === false ? 'none' : 'inverse';
}

/** A held write reads as pending until `undoUntil`; nothing has reached Google before it. */
export function holdPhase(receipt: Pick<Receipt, 'undoUntil'>, now: EpochMs): 'held' | 'sent' {
  return receipt.undoUntil !== undefined && now < receipt.undoUntil ? 'held' : 'sent';
}
