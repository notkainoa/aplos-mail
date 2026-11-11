/**
 * What a refused calendar write means for the owner, in one table (DESIGN 7.15, 10; the providers'
 * 2026-11-10 write shapes). `runWrite` maps the rejection's `body.reasonCode` through `writeFailureOf`:
 * the sentence, whether Retry may run (never for a race, a lost answer or a refusal that cannot change),
 * and any follow-up — re-open the editor on the newer copy (`calendar.conflict`) or on the saved draft
 * (the times refusals), close the detail (`calendar.eventGone`), or offer Sign in again (a dead grant).
 *
 * Copy rules: plain words, no exclamation marks, say what is safe and what to do; `uncertain` never
 * offers Retry (the answer was lost — a blind second write could duplicate the change).
 */
import type { ErrorBody } from '../../data';
import { toErrorBody } from '../../data/client';
import { EDITING_COPY } from './accountCalendarState';

/** True for a value already shaped like an `ErrorBody` (`type` and `message` strings). */
function isBody(value: unknown): value is ErrorBody {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ErrorBody).type === 'string' &&
    typeof (value as ErrorBody).message === 'string'
  );
}

/**
 * The refusal's `ErrorBody`: an `OperationFailedError`'s `.error`, a `ContractError`'s `.body` (the
 * error itself copies `type`/`message` but keeps `reasonCode` only on `.body`, so it is read first),
 * a bare body like an operation frame's `error`, else a plain failure.
 */
function bodyOf(error: unknown): ErrorBody {
  const carried = (error as { error?: unknown } | null)?.error;
  if (isBody(carried)) return carried;
  const boxed = (error as { body?: unknown } | null)?.body;
  if (isBody(boxed)) return boxed;
  if (isBody(error)) return error;
  return toErrorBody(error);
}

/** What the failure surface does next. */
export interface WriteFailure {
  /** The sentence shown. */
  readonly message: string;
  /** 'none' = no Retry action; 'now' = Retry runs the write again at once; 'delayed' = Retry waits `retryAfterMs`. */
  readonly retry: 'none' | 'now' | 'delayed';
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
  /**
   * `calendar.late`: the failure landed on a held write's operation, after its receipt — the Retry
   * the notice offers is that operation's own (`OperationView.retry`, `Operation/retry`), never a
   * second write. Only meaningful where `retry` is 'none': a submit-time refusal has no operation
   * to retry, so the sentence shows without the action.
   */
  readonly opRetry?: boolean;
}

/** The plain sentences, keyed by `body.reasonCode` (a `validation` failure names its field's code the same way). */
const WRITE_FAILURE_COPY: Readonly<Record<string, Omit<WriteFailure, 'retry'>>> = {
  'calendar.conflict': {
    message: "This event changed somewhere else. Your changes weren't saved.",
    reopenEditor: true,
  },
  'calendar.uncertain': {
    message: "We couldn't confirm that went through. Check your calendar before trying again.",
  },
  'calendar.eventGone': {
    message: 'That event is no longer on your calendar.',
    closeDetail: true,
  },
  'calendar.forbidden': {
    message: 'Only the organizer can change this event.',
  },
  'calendar.rejected': {
    message: "Google Calendar didn't accept that change.",
  },
  // Only a stale screen reaches this: the UI hides edit actions on a read-only calendar already.
  'calendar.readOnly': {
    message: "This calendar doesn't accept changes.",
  },
  // A create's op id met an event that was deleted since: the same press must not quietly bring it back.
  'calendar.opReused': {
    message: 'That event was deleted. Create it again as a new event.',
  },
  // A held write that missed its window (Aplos was closed, or the event had already started): the
  // operation failed — its own Retry sends it at once, a blind second write never runs.
  'calendar.late': {
    message: "This change wasn't sent in time. Check the event, then try again.",
    opRetry: true,
  },
  // A second held change while an earlier one still waits: refused at submit, nothing was accepted,
  // so a plain re-run is safe once the first hold clears — and it is not the stale-copy conflict,
  // so the editor never re-opens for it.
  'calendar.holdPending': {
    message:
      "Your earlier change to this event hasn't been sent yet. Undo it, or try again once it has.",
  },
  // A series time change in a zone other than the series' own (or one Aplos cannot name): it cannot be
  // re-timed here — Google Calendar can move the series, one occurrence can move alone.
  'calendar.floatingSeries': {
    message:
      'This repeating event runs in another time zone. Change it in Google Calendar, or edit one occurrence.',
  },
  // "This and following" is never offered; only a stale surface reaches this.
  'event.followingUnsupported': {
    message:
      "Changing this and all following events isn't available. Change this event, or every event.",
  },
  'event.allDayMismatch': {
    message: "Those times didn't fit the event. Check the start and end, then try again.",
    keepDraft: true,
  },
  'event.timesRequired': {
    message: "Those times didn't fit the event. Check the start and end, then try again.",
    keepDraft: true,
  },
  'event.notAGuest': {
    message: "You aren't on this event's guest list, so you can't reply.",
  },
  // Item 3 makes this unreachable; kept as a plain sentence in case an engine still sends it.
  'event.timeZoneRequired': {
    message: 'That event needs a time zone.',
  },
};

/**
 * The failure for a refused write: `error` is whatever the port rejected with (`OperationFailedError`
 * from the data layer's commands, or a `ContractError`), `fallback` the effect's own generic sentence
 * ("Couldn't move Q4 review."). Codes the table does not know keep the fallback and today's Retry.
 * `atOperation` marks a failure the PROVIDER reported on an already-accepted write: "Nothing
 * changed" copy is false there (the change is real — only its send is owed), and a `retryAfterMs`
 * means "try later", never a timer that re-sends without a click (review15).
 */
export function writeFailureOf(
  error: unknown,
  fallback: string,
  blindRetryUnsafe = false,
  atOperation = false,
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
    return atOperation
      ? {
          // The write was accepted — the provider just could not be reached. Retry is the
          // operation's own `Operation/retry`, manual only (review15).
          message: "Couldn't reach Google Calendar. The change hasn't been sent yet.",
          retry: 'none',
          opRetry: true,
        }
      : {
          message: "Couldn't reach Google Calendar. Nothing changed.",
          retry: body.retryAfterMs === undefined ? 'now' : 'delayed',
          ...(body.retryAfterMs !== undefined ? { retryAfterMs: body.retryAfterMs } : {}),
        };
  const known = body.reasonCode ? WRITE_FAILURE_COPY[body.reasonCode] : undefined;
  // `calendar.holdPending` accepted nothing, so a re-run is safe; the rest keep no Retry.
  if (known)
    return { ...known, retry: body.reasonCode === 'calendar.holdPending' ? 'now' : 'none' };
  // A create or a reply asked again blind could duplicate the event or re-notify guests: an
  // unknown code gets no Retry, just the honest check-your-calendar line (review7 7).
  if (blindRetryUnsafe)
    return { message: `${fallback} Check your calendar before trying again.`, retry: 'none' };
  return { message: fallback, retry: 'now' };
}

/**
 * A refused undo, after the hold: the engine answers `conflict` in two cases — "has been sent"
 * once the window closed, "was already undone" on a second press — so each gets its own sentence
 * rather than the body's own wording. Other bodies show their message.
 */
export function undoFailureMessage(error: unknown): string {
  const body = bodyOf(error);
  if (body.type !== 'conflict') return body.message;
  // `conflict` carries no reasonCode; the engine's two sentences are the only keys it leaves.
  return body.message === 'This change was already undone.'
    ? 'That change was already undone.'
    : 'That change has already been sent.';
}
