import type { ErrorBody } from '@aplos/contract';
import { ContractError } from '@aplos/contract/contract-error';
import type { Logger } from '../diag/log';
import type { DraftSyncPort, SendPort } from '../ports/engine';
import type { Clock, DeadlineRegistry } from '../ports/time';
import type { EngineFrame } from '../runtime/frames';
import type { CommitOrigin, CommitResult, StorePort } from '../store';
import type { SubmissionState, SubmissionWrite } from './store';

/**
 * Attachment bytes by blob id (the runtime's blob store, which reads host files); resolves `undefined` when the blob is
 * gone and rejects when it could not be read. Read through `loadBlobs` (blob-read.ts).
 */
export interface BlobSource {
  get(blobId: string): Promise<Uint8Array | undefined>;
}

export interface OutboxDeps {
  store: StorePort;
  send: SendPort;
  clock: Clock;
  deadlines: DeadlineRegistry;
  log: Logger;
  blobs?: BlobSource;
  /** The owner's mail settings; without it `undoSendSeconds` is 10 (the running engine passes the stored one, default 8). */
  settings?: () => { undoSendSeconds?: number };
  /** Randomness for ids, Message-IDs and boundaries; Web Crypto by default. */
  randomBytes?: (n: number) => Uint8Array;
  /** Remote draft copies. Without it the module has no local drafts (the send machine alone). */
  drafts?: DraftSyncPort;
  /** Where `Draft/changed` goes. */
  frames?: { emit(frame: EngineFrame): void };
}

/** What this outbox instance holds in memory; everything else is in the store. */
export interface OutboxCtx extends OutboxDeps {
  random: (n: number) => Uint8Array;
  /** Accounts with a send or a `findSent` running here: one at a time per account. */
  busy: Map<string, Promise<void>>;
  /** Submissions whose `send` this instance is awaiting: the only `sending` rows the start rule leaves alone. */
  inflight: Set<string>;
  /** Accounts whose send budget is closed, until when (undefined: until admission says otherwise). */
  paused: Map<string, number | undefined>;
}

export const DEFAULT_UNDO_SEND_SECONDS = 10;
/** `findSent` runs at once, then once more after this, then the owner is asked (ARCH 7.1). */
export const RECHECK_MS = 60_000;
export const MAX_CHECKS = 2;
/**
 * `findSent` looks from this long before the attempt, not from the attempt itself: the provider stamps a message with
 * its own clock, which can run behind ours, and a search that starts too late never finds what left.
 */
export const CLOCK_SKEW_MARGIN_MS = 5 * 60_000;
/** How often a send held by a budget closed with no end time asks for admission again. */
export const PAUSE_POLL_MS = 30_000;

export const UNCERTAIN_COPY = 'We could not confirm this was sent. Check Sent, or Send anyway.';
/** A failed row with no kept bytes: only Cancel clears it (Retry would fail again), then the draft can be sent. */
export const NO_BYTES_COPY =
  'This message could not be prepared. Cancel it, then open the draft and send it again.';
/** Not sent because the account must sign in again: retryable once it has (the reason code stays `auth.expired`). */
export const AUTH_COPY =
  'Aplos needs you to sign in to this account again. Reconnect it in Settings.';
export const OFFLINE_COPY = 'Your message was not sent. Check your connection, then try again.';
export const OVERDUE_COPY =
  'This was due while your Mac was off. Send it now, or choose a new time.';

/**
 * Not-sent classes that fail the same way every time, with their own reason code and the sentence that tells the owner
 * what to do. A `Retry` of one is refused (`NO_RETRY_COPY`); only Cancel, then a fixed draft or account, helps.
 */
export const UNRETRYABLE: Readonly<Record<string, { reasonCode: string; message: string }>> = {
  permanent: {
    reasonCode: 'send.permanent',
    message: 'The provider refused this message. Check the address and the content.',
  },
  permission: {
    reasonCode: 'send.permission',
    message: 'Aplos is not allowed to send from this account. Reconnect it in Settings.',
  },
  anti_abuse: {
    reasonCode: 'send.anti_abuse',
    message:
      'The provider paused sending because it looked unusual. Wait a while, then cancel this message and send it again.',
  },
  config: {
    reasonCode: 'send.config',
    message: 'Sending is not set up correctly for this account.',
  },
};
export const UNRETRYABLE_CODES: ReadonlySet<string> = new Set(
  Object.values(UNRETRYABLE).map(p => p.reasonCode),
);
export const NO_RETRY_COPY =
  'Sending again would fail the same way. Cancel this message, fix the cause, then send the draft again.';

export function hex(bytes: Uint8Array) {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

export function fail(
  type: ErrorBody['type'],
  message: string,
  extra: Partial<ErrorBody> = {},
): never {
  throw new ContractError({ ...extra, type, message });
}

/** The log catalog's `submissionStates` has no `scheduled` yet: a send-later row logs as `queued`. */
function logged(state: SubmissionState) {
  return state === 'scheduled' ? 'queued' : state;
}

export type MoveWrite = Omit<Extract<SubmissionWrite, { op: 'move' }>, 'kind' | 'op'>;

/**
 * Commits one compare-and-set transition and logs it. Throws `SubmissionConflict` when the row moved on first.
 * `opId` is the caller's (a `Submission/set`) or a fresh one for the timer's own transitions.
 */
export function transition(
  ctx: OutboxCtx,
  move: MoveWrite,
  how: { was: SubmissionState; why: string; origin?: CommitOrigin; opId?: string },
): CommitResult {
  const result = ctx.store.commit({
    opId: how.opId ?? `outbox:${move.id}:${move.to}:${hex(ctx.random(8))}`,
    origin: how.origin ?? 'system',
    writes: [{ kind: 'submission', op: 'move', ...move, why: how.why }],
  });
  if (how.was !== move.to)
    ctx.log.event('submission.state', {
      submission: move.id,
      from: logged(how.was),
      to: logged(move.to),
      why: how.why,
    });
  return result;
}
