import type { AccountStatus, Frame, HostEvent, Submission } from '@aplos/contract';

/**
 * The knobs of the test-only `Fixture/control` channel (plan 10 section 4.1, plan 30 section 8.1 item 1). It is a call on
 * the same session as every other method, so it works over any transport the fixture is served on, and it is absent
 * from the registry, the generated allowlists and OpenAPI: a real engine answers it with `unsupported`.
 */

/**
 * Where a command's frames land relative to its reply: `receiptFirst` (reply, then frames a task later), `frameFirst`
 * (frames, then the reply a task later) or `together` (both in the same task). `delayMs` puts that gap on the engine
 * clock instead, e.g. a receipt and then the window frame 500 ms later.
 */
export interface Ordering { mode: 'receiptFirst' | 'frameFirst' | 'together'; delayMs?: number }

export type SetupState = 'connecting' | 'finding' | 'reading' | 'sorting' | 'ready' | 'paused' | 'failed' | 'notConnected';
type At = 'dbEpoch' | 'seq';
type FrameWithoutAt = Frame extends infer F ? F extends unknown ? Omit<F, At> : never : never;

export type ControlArgs =
  /** Force an account status (ARCH 6.4), with its copy key and, for Google, the weekly `reconnectBy`. */
  | { knob: 'setAccountStatus'; accountId: string; status: AccountStatus; reasonCode?: string; reconnectBy?: number }
  /** A governor pause, e.g. a rate limit: `paused (until, reason)` for `forMs` on the engine clock, then `ok` again. */
  | { knob: 'pauseAccount'; accountId: string; forMs: number; class?: string; reason?: string; reasonCode?: string }
  /**
   * Fail the next write (a command with an `opId`). `reject` fails the call itself; `afterReceipt` (default) returns the
   * receipt, then after `afterMs` reports an `operation` frame with `failed` and puts the rows back (DESIGN 5 rule 11).
   */
  | { knob: 'failNextWrite'; mode?: 'reject' | 'afterReceipt'; type?: string; message?: string; reasonCode?: string; afterMs?: number }
  /** Put a submission in any state of the send machine (ARCH 7.1), with the problem the UI shows. */
  | { knob: 'setSubmissionState'; submissionId: string; state: Submission['state']; problem?: { reasonCode: string; message?: string; until?: number } }
  /** How the next send attempt ends. */
  | { knob: 'nextSendOutcome'; outcome: 'sent' | 'uncertain' | 'failed' }
  /** Move first-sync progress on: `steps` ticks (default 1), or straight `to` a state. Every account when `accountId` is absent. */
  | { knob: 'advanceSetup'; accountId?: string; steps?: number; to?: SetupState; reasonCode?: string }
  /** Set the clock (`APLOS_NOW`); due timers fire on the way. Also sends the `clock` host event. */
  | { knob: 'setClock'; now: number }
  | { knob: 'advanceClock'; ms: number }
  | { knob: 'setOrdering'; ordering: Ordering }
  /** Push frames exactly as given (stamped with the current `{dbEpoch, seq}`), to replay any ordering by hand. */
  | { knob: 'replay'; frames: FrameWithoutAt[] }
  /** Void every window: `dbEpoch` and `restore` also start a new epoch. */
  | { knob: 'reset'; reason: 'dbEpoch' | 'cannotCalculateChanges' | 'restore' | 'restart' }
  /** Raise the change-log floor to now, so any older state gets `cannotCalculateChanges`. */
  | { knob: 'compactLog' }
  | { knob: 'park'; reasonCode: string; message: string; canRetry?: boolean }
  | { knob: 'unpark' }
  | { knob: 'hostEvent'; event: HostEvent }
  /** Another window or device changed a draft (`Draft/changed`); `conflict` when the open copy must choose. */
  | { knob: 'draftChanged'; draftId: string; conflict: boolean }
  /** New mail arrives in an account's Inbox (a new thread, or a reply when `threadId` is given). */
  | { knob: 'deliverMail'; accountId: string; threadId?: string; fromName: string; from: string; subject: string; body: string; lane?: 'do' | 'update' | 'low' }
  /** A background re-rank (AI or heuristic, never `user`), the case `holdIds` exists for. */
  | { knob: 'rerank'; threadId: string; lane?: 'do' | 'update' | 'low'; importance?: 'important' | 'normal' }
  /** Today's background AI use; at or above the cap pauses background AI until local midnight. */
  | { knob: 'setUsage'; backgroundTokens: number }
  /** The clock, epoch, seq and log floor, for a test's own bookkeeping. */
  | { knob: 'snapshot' };

export type Knob = ControlArgs['knob'];
export type KnobArgs<K extends Knob> = Omit<Extract<ControlArgs, { knob: K }>, 'knob'>;
export interface Snapshot { now: number; dbEpoch: string; seq: number; floor: number; windows: number }
export type KnobResult<K extends Knob> = K extends 'snapshot' ? Snapshot : K extends 'advanceClock' | 'setClock' ? { now: number }
  : K extends 'deliverMail' ? { threadId: string; messageId: string } : { ok: true };

/** The method name of the control channel. Not in the registry, the allowlists or OpenAPI. */
export const controlMethod = 'Fixture/control';
