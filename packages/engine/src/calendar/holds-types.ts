import type { ErrorBody, Input, Operation, Receipt } from '@aplos/contract';
import type { Caller } from '../methods/types';
import type { AccountId, EditScope, EventChange, EventRef } from '../ports';

/**
 * The call a held calendar write makes when its window ends: the exact `CalendarPort` call, as data, so a hold survives
 * a restart. Only writes that tell guests are held (the contract's `undoUntil`: "calendar writes that email guests").
 */
export type HeldCall =
  | { op: 'put'; account: AccountId; change: EventChange }
  | { op: 'remove'; account: AccountId; ref: EventRef & { scope: EditScope; notify?: boolean } }
  | {
      op: 'rsvp';
      account: AccountId;
      ref: EventRef & { scope: EditScope };
      response: 'accepted' | 'declined' | 'tentative';
      opts: { notify: boolean };
    };

export interface HoldSpec {
  opId: string;
  /** The contract method that made it (`Event/set`, `Event/rsvp`): the scope to undo it is recorded from it. */
  method: 'Event/set' | 'Event/rsvp';
  targets: string[];
  call: HeldCall;
  /** How long it waits; absent = the owner's undo-send window (`mail.undoSendSeconds`). */
  windowMs?: number;
}

/** A hold as stored (`meta` key `calendar.hold.<opId>`). */
export interface HoldRecord {
  opId: string;
  method: HoldSpec['method'];
  /** The strongest scope the call required (always `send`: it can tell guests). `Operation/undo` needs it too (FR-3). */
  scope: 'send';
  targets: string[];
  /** Present until the hold is finished for good (sent or undone): then the guests' addresses are dropped from storage. */
  call?: HeldCall;
  state: 'queued' | 'syncing' | 'synced' | 'failed' | 'cancelled';
  createdAt: number;
  /** When the hold last reached a finished state; sent and undone holds purge `HOLD_KEEP_MS` after it. */
  finishedAt?: number;
  /** While `queued`: when the window ends and the write is sent. */
  undoUntil: number;
  /** Set when the account was not started at that moment: look again not before this (the window's end stays `undoUntil`). */
  notBefore?: number;
  appliedState: { dbEpoch: string; seq: number };
  error?: ErrorBody;
}

/**
 * Held calendar writes (`services.calendarHolds`, optional: absent means every write is sent at once). `Operation/undo`,
 * `Operation/get` and `Operation/retry` ask it first for an op id it holds, then fall back to the mail operations.
 */
export interface CalendarHolds {
  has(opId: string): boolean;
  hold(spec: HoldSpec): Promise<Receipt>;
  get(opIds: readonly string[]): Promise<Operation[]>;
  undo(args: Input<'Operation/undo'>, caller: Caller): Promise<Receipt>;
  retry(args: Input<'Operation/retry'>, caller: Caller): Promise<Receipt>;
}

/**
 * Sent and undone holds stay readable for `Operation/get` this long after `finishedAt`, then are purged. A failed
 * hold is never purged: it keeps its call until the owner retries or dismisses it.
 */
export const HOLD_KEEP_MS = 24 * 60 * 60 * 1000;
/**
 * A hold whose window ended longer ago than this (the app was closed), or whose event has already started, is not sent on
 * its own: guests would get an invitation or a change for something that is over or long past. It waits for an explicit Retry.
 */
export const HOLD_LATE_MS = 15 * 60 * 1000;
