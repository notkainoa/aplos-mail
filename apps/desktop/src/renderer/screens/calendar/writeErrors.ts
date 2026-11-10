/**
 * What a refused calendar write means for the owner, in one table (DESIGN 7.15, 10; the providers'
 * 2026-11-10 write shapes). `runWrite` maps the rejection's `body.reasonCode` through `writeFailureOf`:
 * the sentence, whether Retry may run (never for a race, a lost answer or a refusal that cannot change),
 * and any follow-up — re-open the editor on the newer copy (`calendar.conflict`) or close the detail
 * (`calendar.eventGone`).
 *
 * Copy rules: plain words, no exclamation marks, say what is safe and what to do; `uncertain` never
 * offers Retry (the answer was lost — a blind second write could duplicate the change).
 */
import type { ErrorBody } from '../../data';
import { toErrorBody } from '../../data/client';

/** The refusal's `ErrorBody`: a `ContractError`'s `.body`, an `OperationFailedError`'s `.error`, else a plain failure. */
function bodyOf(error: unknown): ErrorBody {
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
  /** 'none' = no Retry action; 'now' = Retry runs the write again at once; 'delayed' = Retry waits `retryAfterMs`. */
  readonly retry: 'none' | 'now' | 'delayed';
  /** Honour the body's `retryAfterMs` when set (only meaningful with 'delayed'). */
  readonly retryAfterMs?: number;
  /** `calendar.conflict`: the newer copy is already in the store — re-open the editor on it (editor saves only). */
  readonly reopenEditor?: boolean;
  /** `calendar.eventGone`: the event left the calendar — close its detail. */
  readonly closeDetail?: boolean;
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
 */
export function writeFailureOf(error: unknown, fallback: string): WriteFailure {
  const body = bodyOf(error);
  if (body.reasonCode === 'calendar.unavailable')
    return {
      message: "Couldn't reach Google Calendar. Nothing changed.",
      retry: body.retryAfterMs === undefined ? 'now' : 'delayed',
      ...(body.retryAfterMs !== undefined ? { retryAfterMs: body.retryAfterMs } : {}),
    };
  const known = body.reasonCode ? WRITE_FAILURE_COPY[body.reasonCode] : undefined;
  if (known) return { ...known, retry: 'none' };
  return { message: fallback, retry: 'now' };
}
