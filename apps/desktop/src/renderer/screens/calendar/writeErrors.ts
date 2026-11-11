/**
 * What a refused calendar write means for the owner, in one table (DESIGN 7.15, 10; the providers'
 * 2026-11-10 write shapes). `runWrite` maps the rejection's `body.reasonCode` through `writeFailureOf`:
 * the sentence, whether Retry may run (never for a race, a lost answer or a refusal that cannot change),
 * and any follow-up — re-open the editor on the newer copy (`calendar.conflict`) or on the saved draft
 * (`calendar.holdPending` and the times refusals), close the detail (`calendar.eventGone`), or offer
 * Sign in again (a dead grant). A failed hold's Retry is `Operation/retry` on the same op id
 * (`calendar.late`), never the write again.
 *
 * Copy rules: plain words, no exclamation marks, say what is safe and what to do; `uncertain` never
 * offers Retry (the answer was lost — a blind second write could duplicate the change).
 */
import type { ErrorBody } from '../../data';
import { toErrorBody } from '../../data/client';
import { EDITING_COPY } from './accountCalendarState';

/** The refusal's `ErrorBody`: a `ContractError`'s `.body`, an `OperationFailedError`'s `.error`, else a plain failure. */
export function bodyOf(error: unknown): ErrorBody {
  const carried = (error as { error?: unknown } | null)?.error;
  if (
    typeof carried === 'object' &&
    carried !== null &&
    typeof (carried as ErrorBody).type === 'string' &&
    typeof (carried as ErrorBody).message === 'string'
  )
    return carried as ErrorBody;
  return toErrorBody(error);
}

/** What the failure surface does next. */
export interface WriteFailure {
  /** The sentence shown. */
  readonly message: string;
  /**
   * 'none' = no Retry action; 'now' = Retry runs the write again at once; 'delayed' = Retry waits
   * `retryAfterMs`; 'operation' = Retry is `Operation/retry` on the same op id (a failed hold), never
   * the write again. After a receipt every retryable kind goes through `Operation/retry` — re-issuing
   * the write beside an engine-held operation could send it twice.
   */
  readonly retry: 'none' | 'now' | 'delayed' | 'operation';
  /** Honour the body's `retryAfterMs` when set (only meaningful with 'delayed'). */
  readonly retryAfterMs?: number;
  /** `calendar.conflict`: the newer copy is already in the store — re-open the editor on it (editor saves only). */
  readonly reopenEditor?: boolean;
  /** `calendar.eventGone`: the event left the calendar — close its detail. */
  readonly closeDetail?: boolean;
  /** `permission.calendarWrite`: the grant lacks the write scope — the notice offers Enable editing. */
  readonly enableEditing?: boolean;
  /**
   * `event.allDayMismatch` / `event.timesRequired`: the editor's own times failed — an editor save
   * re-opens on the saved draft (typed work kept), never the store's older copy.
   */
  readonly keepDraft?: boolean;
  /** `needsReauth` / `auth.expired`: the grant is dead — the notice offers Sign in again. Never retried. */
  readonly reconnect?: boolean;
}

/** The plain sentences, keyed by `body.reasonCode` (a `validation` failure names its field's code the same way). */
const WRITE_FAILURE_COPY: Readonly<Record<string, WriteFailure>> = {
  'calendar.conflict': {
    message: "This event changed somewhere else. Your changes weren't saved.",
    retry: 'none',
    reopenEditor: true,
  },
  'calendar.uncertain': {
    message: "We couldn't confirm that went through. Check your calendar before trying again.",
    retry: 'none',
  },
  'calendar.eventGone': {
    message: 'That event is no longer on your calendar.',
    retry: 'none',
    closeDetail: true,
  },
  'calendar.forbidden': {
    message: 'Only the organizer can change this event.',
    retry: 'none',
  },
  'calendar.rejected': {
    message: "Google Calendar didn't accept that change.",
    retry: 'none',
  },
  // A hold that missed its window never reached Google: `Operation/retry` sends that same hold now —
  // re-issuing the write beside it would be a second change.
  'calendar.late': {
    message: "That change wasn't sent in time. Check the event, then send it again.",
    retry: 'operation',
  },
  // A second change to an event whose earlier change is still waiting to be sent: never retried (the
  // queue clears itself); an editor save keeps the typed draft, like the times refusals.
  'calendar.holdPending': {
    message: "Your earlier change to this event hasn't been sent yet. Wait a moment, or undo it.",
    retry: 'none',
    keepDraft: true,
  },
  // Only a stale screen reaches this: the UI hides edit actions on a read-only calendar already.
  'calendar.readOnly': {
    message: "This calendar doesn't accept changes.",
    retry: 'none',
  },
  // A create's op id met an event that was deleted since: the same press must not quietly bring it back.
  'calendar.opReused': {
    message: 'That event was deleted. Create it again as a new event.',
    retry: 'none',
  },
  // A series time change in a zone other than the series' own (or one Aplos cannot name): it cannot be
  // re-timed here — Google Calendar can move the series, one occurrence can move alone.
  'calendar.floatingSeries': {
    message:
      'This repeating event runs in another time zone. Change it in Google Calendar, or edit one occurrence.',
    retry: 'none',
  },
  // "This and following" is never offered; only a stale surface reaches this.
  'event.followingUnsupported': {
    message:
      "Changing this and all following events isn't available. Change this event, or every event.",
    retry: 'none',
  },
  'event.allDayMismatch': {
    message: "Those times didn't fit the event. Check the start and end, then try again.",
    retry: 'none',
    keepDraft: true,
  },
  'event.timesRequired': {
    message: "Those times didn't fit the event. Check the start and end, then try again.",
    retry: 'none',
    keepDraft: true,
  },
  'event.notAGuest': {
    message: "You aren't on this event's guest list, so you can't reply.",
    retry: 'none',
  },
  // Item 3 makes this unreachable; kept as a plain sentence in case an engine still sends it.
  'event.timeZoneRequired': {
    message: 'That event needs a time zone.',
    retry: 'none',
  },
};

/**
 * The failure for a refused write: `error` is whatever the port rejected with (`OperationFailedError`
 * from the data layer's commands, or a `ContractError`), `fallback` the effect's own generic sentence
 * ("Couldn't move Q4 review."). Codes the table does not know keep the fallback and today's Retry.
 */
export function writeFailureOf(
  error: unknown,
  fallback: string,
  blindRetryUnsafe = false,
): WriteFailure {
  const body = bodyOf(error);
  if (body.reasonCode === 'permission.calendarWrite')
    return { message: EDITING_COPY.notice, retry: 'none', enableEditing: true };
  // A dead grant signs in again before anything writes — never retried, however it arrives.
  if (body.type === 'needsReauth' || body.reasonCode === 'auth.expired')
    return {
      message: 'Sign in to Google again to change events.',
      retry: 'none',
      reconnect: true,
    };
  // The engine's writes land with #394; until then a write answers `notImplemented` and no retry can help.
  if (body.type === 'notImplemented')
    return { message: "Editing isn't available yet. Nothing was changed.", retry: 'none' };
  if (body.reasonCode === 'calendar.unavailable')
    return {
      message: "Couldn't reach Google Calendar. Nothing changed.",
      retry: body.retryAfterMs === undefined ? 'now' : 'delayed',
      ...(body.retryAfterMs !== undefined ? { retryAfterMs: body.retryAfterMs } : {}),
    };
  const known = body.reasonCode ? WRITE_FAILURE_COPY[body.reasonCode] : undefined;
  if (known) return { ...known };
  // A create or a reply asked again blind could duplicate the event or re-notify guests: an
  // unknown code gets no Retry, just the honest check-your-calendar line (review7 7).
  if (blindRetryUnsafe)
    return { message: `${fallback} Check your calendar before trying again.`, retry: 'none' };
  return { message: fallback, retry: 'now' };
}
