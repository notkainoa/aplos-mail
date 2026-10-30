import type { ErrorBody } from '@aplos/contract';
import { ContractError } from '@aplos/contract/contract-error';
import type { Logger } from '../diag/log';
import type { SendPort } from '../ports/engine';
import type { Clock, DeadlineRegistry } from '../ports/time';
import type { CommitOrigin, CommitResult, StorePort } from '../store';
import type { SubmissionState, SubmissionWrite } from './store';

/** Attachment bytes by blob id (the runtime's blob store); `undefined` when the blob is gone. */
export interface BlobSource {
  get(blobId: string): Uint8Array | undefined;
}

export interface OutboxDeps {
  store: StorePort;
  send: SendPort;
  clock: Clock;
  deadlines: DeadlineRegistry;
  log: Logger;
  blobs?: BlobSource;
  /** The owner's mail settings; `undoSendSeconds` defaults to 10. */
  settings?: () => { undoSendSeconds?: number };
  /** Randomness for ids, Message-IDs and boundaries; Web Crypto by default. */
  randomBytes?: (n: number) => Uint8Array;
}

/** What this outbox instance holds in memory; everything else is in the store. */
export interface OutboxCtx extends OutboxDeps {
  random: (n: number) => Uint8Array;
  /** Accounts with a send or a `findSent` running here: one at a time per account. */
  busy: Map<string, Promise<void>>;
  /** Submissions whose `send` this instance is awaiting: never treated as lost by the start rule. */
  inflight: Set<string>;
  /** Accounts whose send budget is closed, until when (undefined: until admission says otherwise). */
  paused: Map<string, number | undefined>;
  /** True until the start rule ran once (at `start()`, or the first fire). */
  startRulePending: boolean;
}

export const DEFAULT_UNDO_SEND_SECONDS = 10;
/** `findSent` runs at once, then once more after this, then the owner is asked (ARCH 7.1). */
export const RECHECK_MS = 60_000;
export const MAX_CHECKS = 2;
/** How often a send held by a budget closed with no end time asks for admission again. */
export const PAUSE_POLL_MS = 30_000;

export const UNCERTAIN_COPY = 'We could not confirm this was sent. Check Sent, or Send anyway.';
export const OVERDUE_COPY =
  'This was due while your Mac was off. Send it now, or choose a new time.';

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
    writes: [{ kind: 'submission', op: 'move', ...move }],
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
