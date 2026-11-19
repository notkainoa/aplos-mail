import type {
  AccountStatus,
  Citation,
  ErrorBody,
  Event,
  Frame,
  HostEvent,
  Proposal,
  Submission,
} from '@aplos/contract';

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
export interface Ordering {
  mode: 'receiptFirst' | 'frameFirst' | 'together';
  delayMs?: number;
}

/** How a connect, reconnect or permission flow ends: `failed` with `auth.wrongAccount`, `auth.denied`, `auth.timeout`... */
export interface ConnectOutcome {
  outcome: 'connected' | 'failed' | 'cancelled';
  reasonCode?: string;
}

/** What the next `Ask/run` streams and stores instead of its canned answer (FR-17). */
export interface AskScript {
  /** Answer paragraphs, without `[n]` markers, and where each one's chips sit. */
  blocks?: { text: string; cites?: { at: number; n: number }[] }[];
  citations?: Citation[];
  /** E.g. an `addEvent` with guests, for the Ask card and `Ask/decide`'s `send` rule. */
  proposals?: Proposal[];
  /** Fail mid-run: after the search step starts, or after the first paragraph streams. */
  failAt?: 'step' | 'text';
  problem?: { reasonCode: string; message?: string };
}

/** How the next `Search/remote` ends: these thread ids join matching search windows, or the run fails (FR-17). */
export interface SearchScript {
  ids?: string[];
  /** `paused` (with `resumeAt`) or `unavailable`: the run reports it and the session's search windows stop with it. */
  error?: ErrorBody;
}

export type SetupState =
  'connecting' | 'finding' | 'reading' | 'sorting' | 'ready' | 'paused' | 'failed' | 'notConnected';
type At = 'dbEpoch' | 'seq';
type FrameWithoutAt = Frame extends infer F ? (F extends unknown ? Omit<F, At> : never) : never;

export type ControlArgs =
  /** Force an account status (ARCH 6.4), with its copy key and, for Google, the weekly `reconnectBy`. */
  | {
      knob: 'setAccountStatus';
      accountId: string;
      status: AccountStatus;
      reasonCode?: string;
      reconnectBy?: number;
    }
  /** A governor pause, e.g. a rate limit: `paused (until, reason)` for `forMs` on the engine clock, then `ok` again. */
  | {
      knob: 'pauseAccount';
      accountId: string;
      forMs: number;
      class?: string;
      reason?: string;
      reasonCode?: string;
    }
  /**
   * Fail the next write (a command with an `opId`). `reject` fails the call itself; `afterReceipt` (default) returns the
   * receipt, then after `afterMs` reports an `operation` frame with `failed` and puts the rows back (DESIGN 5 rule 11).
   */
  | {
      knob: 'failNextWrite';
      mode?: 'reject' | 'afterReceipt';
      type?: string;
      message?: string;
      reasonCode?: string;
      afterMs?: number;
    }
  /** Put a submission in any state of the send machine (ARCH 7.1), with the problem the UI shows. */
  | {
      knob: 'setSubmissionState';
      submissionId: string;
      state: Submission['state'];
      problem?: { reasonCode: string; message?: string; until?: number };
    }
  /**
   * How a connect flow ends (FR-17): with `connectId`, end that live flow after `delayMs` (default now); without it, the
   * next flow ends this way after `delayMs` (default 800). Covers the reconnect sheet's wrong account, denied, timed out.
   */
  | ({ knob: 'resolveConnect'; connectId?: string; delayMs?: number } & ConnectOutcome)
  /** Script the next `Ask/run`: its answer, citations and proposals, or a failure mid-stream (FR-17). */
  | ({ knob: 'askScript' } & AskScript)
  /** The next call of an AI feature fails with this copy key (Ask fails mid-stream; the others reject the call). */
  | {
      knob: 'failNextAi';
      feature: 'ask' | 'summaries' | 'drafts' | 'plans' | 'voice';
      reasonCode: string;
      message?: string;
    }
  /** Script the next `Search/remote`: results that join the search window, or `paused` / `unavailable`. */
  | ({ knob: 'searchRemote' } & SearchScript)
  /** What the next `Ai/transcribe` hears. */
  | { knob: 'transcribeResult'; text: string }
  /** An event changed at the provider (another device, the organizer): the row moves as a sync would move it. */
  | {
      knob: 'calendarChange';
      eventId: string;
      patch: Partial<Omit<Event, 'id' | 'rev' | 'accountId'>>;
      /** Gone at the provider instead. */
      removed?: boolean;
    }
  /** How the next send attempt ends. */
  | { knob: 'nextSendOutcome'; outcome: 'sent' | 'uncertain' | 'failed' }
  /** Move first-sync progress on: `steps` ticks (default 1), or straight `to` a state. Every account when `accountId` is absent. */
  | {
      knob: 'advanceSetup';
      accountId?: string;
      steps?: number;
      to?: SetupState;
      reasonCode?: string;
    }
  /** Set the clock (`APLOS_NOW`); due timers fire on the way. Also sends the `clock` host event. */
  | { knob: 'setClock'; now: number }
  | { knob: 'advanceClock'; ms: number }
  /** The Mac sleeps for `ms`: no timer fires on the way, then due timers fire late at wake (a send-later that falls due). */
  | { knob: 'sleep'; ms: number }
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
  | {
      knob: 'deliverMail';
      accountId: string;
      threadId?: string;
      fromName: string;
      from: string;
      subject: string;
      body: string;
      lane?: 'do' | 'update' | 'low';
    }
  /** A background re-rank (AI or heuristic, never `user`), the case `holdIds` exists for. */
  | {
      knob: 'rerank';
      threadId: string;
      lane?: 'do' | 'update' | 'low';
      importance?: 'important' | 'normal';
    }
  /** Today's background AI use; at or above the cap pauses background AI until local midnight. */
  | { knob: 'setUsage'; backgroundTokens: number }
  /** The clock, epoch, seq and log floor, for a test's own bookkeeping. */
  | { knob: 'snapshot' };

export type Knob = ControlArgs['knob'];
export type KnobArgs<K extends Knob> = Omit<Extract<ControlArgs, { knob: K }>, 'knob'>;
export interface Snapshot {
  now: number;
  dbEpoch: string;
  seq: number;
  floor: number;
  windows: number;
}
export type KnobResult<K extends Knob> = K extends 'snapshot'
  ? Snapshot
  : K extends 'advanceClock' | 'setClock' | 'sleep'
    ? { now: number }
    : K extends 'deliverMail'
      ? { threadId: string; messageId: string }
      : { ok: true };

/** The method name of the control channel. Not in the registry, the allowlists or OpenAPI. */
export const controlMethod = 'Fixture/control';
