/**
 * The send-state machine (DESIGN 7.6 Send, 7.13, 7.15; plan 30 4.5 row 4; ARCH 7.1-7.3). After the first press the
 * engine's `Submission` row is the truth: the composer keeps only its intent (`pending` until `Submission/set` answers,
 * then `tracking` the row by id), and every phase below is a pure function of that intent, the row, the clock and
 * whether the engine is online. So a reload, or a second composer on the same draft, shows the same phase.
 *
 * | Phase       | What it says                                                    | Actions                 |
 * |-------------|-----------------------------------------------------------------|-------------------------|
 * | idle        | (the composer is open)                                          | Send                    |
 * | submitting  | "Sending to Jordan in 8 s" (tray, before the engine answers)    | Undo Z · Send now       |
 * | held        | "Sending to Jordan in 8 s" (tray, the 2 px drain)               | Undo Z · Send now       |
 * | scheduled   | "Scheduled for Tue 9:00 AM" (one notice)                        | Undo                    |
 * | sending     | (nothing: the message arrives in its thread)                    | none                    |
 * | offline     | "Saved here · will sync" (one notice)                           | none                    |
 * | sent        | (nothing: the message is in its thread)                         | none                    |
 * | failed      | "Couldn't send to Jordan. Your draft is saved." (ErrorLine)     | Try again · Edit        |
 * | deferred    | "Couldn't send until 2:14 PM. Your draft is saved." (tray)      | none                    |
 * | uncertain   | "Couldn’t confirm this was sent." (tray)                        | Check Sent · Send anyway|
 * | suspended   | "Missed its time while your Mac was off." (tray)                | Send now · Reschedule   |
 * | cancelled   | (the composer reopens on the draft)                             | Send                    |
 */
import { toIsoDateTime, type Submission } from '../../../data';
import type { UndoTrayState } from '../../../ui/props';
import { recipientPhrase } from './recipients';

/** What the composer remembers about a send; everything else is read from the engine. */
export type SendIntent =
  | { readonly kind: 'none' }
  | {
      /** Pressed; `Submission/set` has not answered yet. */
      readonly kind: 'pending';
      readonly pressedAt: number;
      /** The undo window the tray drains over until the engine's row says otherwise. */
      readonly undoSeconds: number;
      readonly names: readonly string[];
      readonly notBefore?: number;
      readonly alsoDone: boolean;
      /** Undo was pressed before the answer: it is sent the moment the submission id is known. */
      readonly undoAsked: boolean;
      readonly sendNowAsked: boolean;
      /**
       * No answer within `SEND_CONFIRM_MS`: it may or may not have reached the engine. It reads as uncertain ("Couldn’t
       * confirm this was sent." · Check Sent · Send anyway, the same idempotency key), Z is let go, and the page hands it
       * to the toast stack; a late answer is still followed.
       */
      readonly unconfirmed?: boolean;
    }
  | {
      /** The engine took it: follow `Submission` `submissionId`. */
      readonly kind: 'tracking';
      readonly submissionId: string;
      /** The newest row seen (the reply, then frames), so there is never a gap between answer and first frame. */
      readonly row: Submission | null;
    }
  | {
      /** `Submission/set` refused the send (daily limit, provider down); the draft is saved and unlocked. */
      readonly kind: 'refused';
      readonly names: readonly string[];
      readonly reasonCode: string;
      readonly until?: number;
      /** What the refused press asked for, so Try again sends the same thing (a send later stays a send later). */
      readonly notBefore?: number;
      readonly alsoDone?: boolean;
      /** The undo window of the refused press (the account's setting then), so Try again gets an Undo too. */
      readonly undoSeconds?: number;
    };

/** How long a pressed send waits for `Submission/set` before it reads as unconfirmed. */
export const SEND_CONFIRM_MS = 15_000;

export const NO_SEND: SendIntent = { kind: 'none' };

export type SendPhase =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'submitting';
      readonly names: readonly string[];
      readonly secondsLeft: number;
      readonly totalSeconds: number;
    }
  | {
      readonly kind: 'held';
      readonly names: readonly string[];
      readonly secondsLeft: number;
      readonly totalSeconds: number;
    }
  | { readonly kind: 'scheduled'; readonly notBefore: number }
  | { readonly kind: 'sending' }
  | { readonly kind: 'offline' }
  | { readonly kind: 'sent' }
  | { readonly kind: 'failed'; readonly names: readonly string[]; readonly reasonCode: string }
  | { readonly kind: 'deferred'; readonly until: number }
  | { readonly kind: 'uncertain' }
  | { readonly kind: 'suspended' }
  | { readonly kind: 'cancelled' };

export type SendPhaseKind = SendPhase['kind'];

/** Every verb a send phase can offer. The first five are the UndoTray's. */
export type SendAction =
  'undo' | 'sendNow' | 'checkSent' | 'sendAnyway' | 'reschedule' | 'retry' | 'edit';

/** Submission states in which a send still waits for its time (the engine's `WAITING_SUBMISSION_STATES`). */
const WAITING = new Set(['queued', 'scheduled']);
/** Submission states that end a send for good, or hand the draft back (`cancelled`). */
const SETTLED = new Set(['sent', 'cancelled']);

/** True while a submission still holds its draft (the engine's live set). */
export function isLiveSubmission(row: Pick<Submission, 'state'>): boolean {
  return !SETTLED.has(row.state);
}

function pendingPhase(intent: Extract<SendIntent, { kind: 'pending' }>, now: number): SendPhase {
  if (intent.unconfirmed) return { kind: 'uncertain' };
  const later =
    intent.notBefore !== undefined &&
    intent.notBefore > intent.pressedAt + intent.undoSeconds * 1000;
  if (later) return { kind: 'scheduled', notBefore: intent.notBefore! };
  if (intent.undoSeconds <= 0 || intent.sendNowAsked) return { kind: 'sending' };
  const secondsLeft = Math.max(0, intent.undoSeconds - (now - intent.pressedAt) / 1000);
  return { kind: 'submitting', names: intent.names, secondsLeft, totalSeconds: intent.undoSeconds };
}

function waitingPhase(row: Submission, now: number, online: boolean): SendPhase {
  if (now < row.notBefore && row.state === 'scheduled')
    return { kind: 'scheduled', notBefore: row.notBefore };
  if (now < row.notBefore) {
    return {
      kind: 'held',
      names: row.toNames,
      secondsLeft: (row.notBefore - now) / 1000,
      totalSeconds: (row.notBefore - row.queuedAt) / 1000,
    };
  }
  return online ? { kind: 'sending' } : { kind: 'offline' };
}

function failedPhase(row: Submission, now: number): SendPhase {
  const until = row.problem?.until;
  if (until !== undefined && until > now) return { kind: 'deferred', until };
  return {
    kind: 'failed',
    names: row.toNames,
    reasonCode: row.problem?.reasonCode ?? 'send.failed',
  };
}

/** The phase of a submission row at `now`. */
export function rowPhase(row: Submission, now: number, online: boolean): SendPhase {
  if (WAITING.has(row.state)) return waitingPhase(row, now, online);
  switch (row.state) {
    case 'sent':
      return { kind: 'sent' };
    case 'cancelled':
      return { kind: 'cancelled' };
    case 'failed':
      return failedPhase(row, now);
    case 'uncertain':
      return { kind: 'uncertain' };
    case 'suspended':
      return { kind: 'suspended' };
    default:
      return online ? { kind: 'sending' } : { kind: 'offline' };
  }
}

/** The phase of a send from the composer's intent and the engine's row. */
export function phaseOf(intent: SendIntent, now: number, online: boolean): SendPhase {
  switch (intent.kind) {
    case 'none':
      return { kind: 'idle' };
    case 'pending':
      return pendingPhase(intent, now);
    case 'refused':
      return intent.until !== undefined && intent.until > now
        ? { kind: 'deferred', until: intent.until }
        : { kind: 'failed', names: intent.names, reasonCode: intent.reasonCode };
    case 'tracking':
      return intent.row ? rowPhase(intent.row, now, online) : { kind: 'sending' };
  }
}

/** A one-off notice for phases with no tray: the toast's words and its one verb. */
export interface SendNotice {
  readonly kind: 'scheduled' | 'offline';
  readonly message: string;
  readonly actions: readonly SendAction[];
}

/** What a phase shows: at most one of a tray, a send-failed line or a notice, and the verbs it offers. */
export interface SendView {
  readonly tray: UndoTrayState | null;
  readonly failure: { readonly recipient: string } | null;
  readonly notice: SendNotice | null;
  readonly actions: readonly SendAction[];
}

const QUIET: SendView = { tray: null, failure: null, notice: null, actions: [] };

export const SEND_COPY = {
  offline: 'Saved here · will sync',
  scheduled: (when: string) => `Scheduled for ${when}`,
  /** The send-failed line's words (ErrorLine `sendFailed`), for the toast when no thread shows the send. */
  failed: (recipient: string) => `Couldn’t send to ${recipient}. Your draft is saved.`,
  /** An Undo that lost the race with the send. */
  alreadySent: 'Already sent.',
  /** An Undo the engine refused for another reason, when it gave no sentence of its own. */
  undoFailed: 'Couldn’t undo this send.',
  /** A send whose `Submission/set` never answered (the UndoTray's uncertain words). */
  unconfirmed: 'Couldn’t confirm this was sent.',
  /** Another window's send locked the draft: this window's text became a draft of its own and was not sent. */
  sendingElsewhere: 'This draft is being sent from another window.',
} as const;

/** The view of a phase. `formatTime` names a scheduled send's time ("Tue 9:00 AM"). */
export function sendView(phase: SendPhase, formatTime: (ms: number) => string): SendView {
  switch (phase.kind) {
    case 'submitting':
    case 'held':
      return {
        ...QUIET,
        tray: {
          kind: 'sending',
          recipients: recipientPhrase(phase.names),
          secondsLeft: phase.secondsLeft,
          totalSeconds: phase.totalSeconds,
        },
        actions: ['undo', 'sendNow'],
      };
    case 'scheduled':
      return {
        ...QUIET,
        notice: {
          kind: 'scheduled',
          message: SEND_COPY.scheduled(formatTime(phase.notBefore)),
          actions: ['undo'],
        },
        actions: ['undo'],
      };
    case 'offline':
      return { ...QUIET, notice: { kind: 'offline', message: SEND_COPY.offline, actions: [] } };
    case 'failed':
      return {
        ...QUIET,
        failure: { recipient: recipientPhrase(phase.names) },
        actions: ['retry', 'edit'],
      };
    case 'deferred':
      return { ...QUIET, tray: { kind: 'deferred', until: toIsoDateTime(phase.until) } };
    case 'uncertain':
      return { ...QUIET, tray: { kind: 'uncertain' }, actions: ['checkSent', 'sendAnyway'] };
    case 'suspended':
      return { ...QUIET, tray: { kind: 'suspended' }, actions: ['sendNow', 'reschedule'] };
    default:
      return QUIET;
  }
}

/** True while the composer is closed because a send owns the draft (the phases with no composer). */
export function sendOwnsDraft(phase: SendPhase): boolean {
  return phase.kind !== 'idle' && phase.kind !== 'cancelled';
}
