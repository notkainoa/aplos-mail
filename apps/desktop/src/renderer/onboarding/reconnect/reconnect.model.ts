/**
 * The weekly reconnect (DESIGN 7.1 "The reconnect sheet", 7.10 Accounts, 7.15; plan 30 U8 "Weekly reconnect" and
 * acceptance 3 and 9; roadmap N3). Pure: no React, no hooks, no engine.
 *
 * Two parts:
 * - `reconnectOffer` decides whether an account offers Reconnect and which call fixes it: `Account/reconnect` (the
 *   sign-in expired, or `reconnectBy` is within a day) or `Account/grantPermissions` (a scope is missing).
 * - `reduceReconnect` is the sheet's state machine: idle → waiting → failed (with a plain sentence) or closed. It
 *   returns effects as data (`start`, `cancelConnect`, `close`). There is no effect that syncs: a reconnect keeps the
 *   queued local changes and never resyncs (N3), and `runReconnectEffect`'s ports have no sync method, so a
 *   `Sync/request` cannot be issued from here.
 *
 * The rules it keeps, the same ones the Accounts step keeps for a new account (F9):
 * - A `connect` frame settles the sheet only when it is the flow the sheet is waiting on (same `connectId`, the
 *   sheet's own `mode`). After Cancel, after the sheet closed, or for an older attempt, a late frame changes nothing.
 * - A settled frame that beats `Account/reconnect`'s own answer is kept until the id arrives.
 * - An id that arrives after Cancel is cancelled at once, and nothing on screen changes.
 * - A failure is a sentence from `copy.ts`; the wrong Google account names the address to choose.
 */
import { isAdminBlock, reasonSentence } from '../copy';
import { reasonOf } from '../reason';

/** Google asks again after seven days; the offer starts a day before (DESIGN 7.1 table). */
export const DAY_MS = 86_400_000;

/** Which engine call the sheet makes. */
export type ReconnectCall = 'reconnect' | 'grantPermissions';

/** `ReconnectSheet`'s `mode` prop: the weekly copy, the missing-permission copy or the editing ask. */
export type SheetMode = 'reconnect' | 'grant' | 'enableEditing';

/** The `connect` frame's `mode` each call reports under. */
export const FRAME_MODE: Readonly<Record<ReconnectCall, 'reconnect' | 'grantPermissions'>> = {
  reconnect: 'reconnect',
  grantPermissions: 'grantPermissions',
};

export const sheetMode = (call: ReconnectCall): SheetMode =>
  call === 'grantPermissions' ? 'grant' : 'reconnect';

/** The engine call behind a `SheetMode`: 'grant' and 'enableEditing' are both `Account/grantPermissions`;
 * anything else — an absent or unknown mode, which `openSheet`'s unchecked args can carry — is the
 * narrower `Account/reconnect`. */
export function callForSheetMode(mode: SheetMode): ReconnectCall {
  return mode === 'grant' || mode === 'enableEditing' ? 'grantPermissions' : 'reconnect';
}

/** The extra the call carries for a `SheetMode`: only 'enableEditing' widens the re-consent to the events scope (`Account/grantPermissions {enable: 'calendarWrite'}`, #393); a plain 'grant' asks read scopes only. */
export function enableForSheetMode(mode: SheetMode): 'calendarWrite' | undefined {
  return mode === 'enableEditing' ? 'calendarWrite' : undefined;
}

/** The account facts the decision reads; the contract's `Account` is assignable to it. */
export interface ReconnectAccount {
  readonly demo?: boolean;
  readonly health: {
    readonly status: { readonly state: string };
    readonly reasonCode?: string;
    /** Epoch ms: the grant time plus seven days. */
    readonly reconnectBy?: number;
  };
  /** Features that lack a permission while mail still works. */
  readonly missingPermissions?: readonly { readonly capability?: string }[];
}

/** Why Reconnect is offered. */
export type ReconnectReason = 'needsReauth' | 'needsPermission' | 'missingPermission' | 'dueSoon';

export interface ReconnectOffer {
  /** `Account/reconnect` or `Account/grantPermissions`. */
  readonly call: ReconnectCall;
  readonly mode: SheetMode;
  readonly reason: ReconnectReason;
  /** True only for `dueSoon`: the status slot says "Reconnect now"; every other entry says "Reconnect". */
  readonly due: boolean;
  /** The verb for the entry point: "Reconnect now" for `dueSoon`, else "Reconnect". */
  readonly label: 'Reconnect' | 'Reconnect now';
}

function offer(call: ReconnectCall, reason: ReconnectReason): ReconnectOffer {
  const due = reason === 'dueSoon';
  return { call, mode: sheetMode(call), reason, due, label: due ? 'Reconnect now' : 'Reconnect' };
}

/** `reconnectBy` is within the next 24 hours (or already past). */
export function reconnectIsDue(reconnectBy: number | undefined, now: number): boolean {
  return reconnectBy !== undefined && reconnectBy - now <= DAY_MS;
}

/**
 * Whether an account offers Reconnect, and which call it makes (DESIGN 7.10: "Reconnect appears on the row for
 * `needsReauth`, `needsPermission` and when `reconnectBy` is within 24 hours"; 7.1 status table).
 *
 * Order: a signed-out grant reconnects first; a missing scope grants; then a missing feature permission (mail still
 * works) grants; then a grant that expires within a day reconnects. Nothing is offered for demo mail, an
 * administrator's block or a build without Google set up (nobody can fix those with a click), or while offline.
 */
export function reconnectOffer(account: ReconnectAccount, now: number): ReconnectOffer | null {
  if (account.demo) return null;
  const { status, reasonCode, reconnectBy } = account.health;
  const state = status.state;
  if (state === 'needsAdmin' || state === 'misconfigured' || isAdminBlock(reasonCode)) return null;
  if (state === 'needsReauth') return offer('reconnect', 'needsReauth');
  if (state === 'needsPermission') return offer('grantPermissions', 'needsPermission');
  if (state === 'offline') return null;
  // A refused calendar write's 'calendarWrite' row is not a reconnect offer: it has its own entry
  // point (Settings → Calendar's "Enable editing", sheet mode 'enableEditing') and never nags here.
  if (account.missingPermissions?.some(m => m.capability !== 'calendarWrite'))
    return offer('grantPermissions', 'missingPermission');
  if (reconnectIsDue(reconnectBy, now)) return offer('reconnect', 'dueSoon');
  return null;
}

/** The call a click makes when the owner asks for a reconnect explicitly: the offer's, else the weekly reconnect. */
export function callFor(account: ReconnectAccount, now: number): ReconnectCall {
  return reconnectOffer(account, now)?.call ?? 'reconnect';
}

/**
 * Which account's sheet is open after a Reconnect press: the one already open stays (one sheet at a time, so a second
 * press never starts another browser flow); otherwise the pressed account's.
 */
export function openReconnect(current: string | null, accountId: string): string {
  return current ?? accountId;
}

/**
 * How long the flow waits for an account it can't find before it closes with `failed`. Only a list that has
 * answered counts: while `Account/get` is still out an empty list is "not arrived yet", never "gone". A list that
 * arrived without the account closes at once, and an answered empty one never leaves a sheet waiting.
 */
export const MISSING_ACCOUNT_WAIT_MS = 3_000;

/** When a flow whose account isn't in the list closes: never while the list hasn't answered ('wait'), at once once it has ('now' with accounts in it), or after the wait when the answered list is empty. */
export function missingAccountClose(
  loaded: boolean,
  accountCount: number,
): 'wait' | 'now' | 'afterWait' {
  if (!loaded) return 'wait';
  return accountCount > 0 ? 'now' : 'afterWait';
}

/* ---------- The sheet's state machine ---------- */

export type SheetPhase = 'idle' | 'waiting' | 'failed' | 'closed';

/** What `onClose` reports. */
export type ReconnectOutcome = 'reconnected' | 'cancelled' | 'failed';

/**
 * The toast a 'reconnected' close raises (DESIGN 7.13): "Reconnected" after a real reconnect or a
 * permission grant, none after the editing ask — its account row flipping to "Editing on" is the
 * confirmation there, and a consent that left the events scope unticked must not announce a reconnect
 * that never happened.
 */
export function reconnectedToast(state: Pick<ReconnectState, 'enable'>): 'Reconnected' | null {
  return state.enable === 'calendarWrite' ? null : 'Reconnected';
}

/** A settled `connect` frame kept until its flow's id is known. */
export interface SettledFrame {
  readonly connectId: string;
  readonly state: string;
  readonly reasonCode?: string;
}

export interface ReconnectState {
  readonly phase: SheetPhase;
  readonly call: ReconnectCall;
  readonly accountId: string;
  /** The address being reconnected: the sheet's title and `login_hint`. */
  readonly address: string;
  /** The 'enableEditing' sheet's extra: `Account/grantPermissions` asks for the events scope too. */
  readonly enable?: 'calendarWrite';
  /** Request counter; an answer for an older request is cancelled when it arrives. */
  readonly attempt: number;
  /** The flow the sheet is waiting on; null until the call answers. */
  readonly connectId: string | null;
  /** The plain sentence when failed; undefined lets the sheet use its own default. */
  readonly reason?: string;
  /** Set once closed. */
  readonly outcome: ReconnectOutcome | null;
  readonly early: readonly SettledFrame[];
}

export type ReconnectEvent =
  /** The sheet opened: one click starts the flow. */
  | { readonly type: 'open' }
  /** `Account/reconnect` (or `grantPermissions`) answered with its `connectId`. */
  | { readonly type: 'started'; readonly attempt: number; readonly connectId: string }
  /** The call itself was refused. */
  | { readonly type: 'startFailed'; readonly attempt: number; readonly reasonCode?: string }
  /** A `connect` frame for this account, for this flow or any earlier one. */
  | {
      readonly type: 'frame';
      readonly connectId: string;
      readonly mode: string;
      readonly state: string;
      readonly accountId?: string;
      readonly reasonCode?: string;
    }
  /** Cancel, Esc, or a press on the scrim. */
  | { readonly type: 'cancel' }
  /** Try again after a failure. */
  | { readonly type: 'retry' };

export type ReconnectEffect =
  | {
      readonly type: 'start';
      readonly call: ReconnectCall;
      readonly accountId: string;
      readonly attempt: number;
      readonly enable?: 'calendarWrite';
    }
  | { readonly type: 'cancelConnect'; readonly connectId: string }
  /** Tell the parent the sheet is gone. "Reconnected" also raises the toast. */
  | { readonly type: 'close'; readonly outcome: ReconnectOutcome };

export interface ReconnectResult {
  readonly state: ReconnectState;
  readonly effects: readonly ReconnectEffect[];
}

export function initialReconnect(input: {
  accountId: string;
  address: string;
  call?: ReconnectCall;
  enable?: 'calendarWrite';
}): ReconnectState {
  return {
    phase: 'idle',
    call: input.call ?? 'reconnect',
    accountId: input.accountId,
    address: input.address,
    ...(input.enable ? { enable: input.enable } : {}),
    attempt: 0,
    connectId: null,
    outcome: null,
    early: [],
  };
}

const keep = (state: ReconnectState): ReconnectResult => ({ state, effects: [] });

/** The settled answers a `connect` frame can carry. */
export function settledState(state: string): 'connected' | 'failed' | 'cancelled' | null {
  return state === 'connected' || state === 'failed' || state === 'cancelled' ? state : null;
}

/**
 * The sentence for a failure, or undefined for a code Aplos has no sentence for (the sheet then says its own
 * "Google didn't finish the sign-in. Your mail is safe on this Mac.").
 */
export function failureSentence(code: string | undefined, address: string): string | undefined {
  if (!code) return undefined;
  const sentence = reasonSentence(code, { address });
  return sentence === reasonSentence(undefined) ? undefined : sentence;
}

function closed(
  state: ReconnectState,
  outcome: ReconnectOutcome,
  effects: ReconnectEffect[] = [],
): ReconnectResult {
  return {
    state: { ...state, phase: 'closed', outcome, connectId: null, early: [] },
    effects: [...effects, { type: 'close', outcome }],
  };
}

function failed(state: ReconnectState, code: string | undefined): ReconnectResult {
  const reason = failureSentence(code, state.address);
  const { reason: _old, ...rest } = state;
  return keep({
    ...rest,
    phase: 'failed',
    connectId: null,
    early: [],
    ...(reason ? { reason } : {}),
  });
}

export function reduceReconnect(state: ReconnectState, event: ReconnectEvent): ReconnectResult {
  switch (event.type) {
    case 'open': {
      if (state.phase !== 'idle') return keep(state);
      const attempt = state.attempt + 1;
      return {
        state: { ...state, phase: 'waiting', attempt, connectId: null, early: [] },
        effects: [
          {
            type: 'start',
            call: state.call,
            accountId: state.accountId,
            attempt,
            ...(state.enable ? { enable: state.enable } : {}),
          },
        ],
      };
    }

    case 'started': {
      const current = state.phase === 'waiting' && event.attempt === state.attempt;
      if (!current || state.connectId !== null) {
        // Cancelled, failed or superseded before the id arrived: cancel that flow, change nothing on screen.
        return {
          state,
          effects:
            event.connectId === state.connectId
              ? []
              : [{ type: 'cancelConnect', connectId: event.connectId }],
        };
      }
      const settled = state.early.find(f => f.connectId === event.connectId);
      const waiting = { ...state, connectId: event.connectId, early: [] };
      return settled
        ? reduceReconnect(waiting, {
            type: 'frame',
            connectId: settled.connectId,
            mode: FRAME_MODE[state.call],
            state: settled.state,
            ...(settled.reasonCode ? { reasonCode: settled.reasonCode } : {}),
          })
        : keep(waiting);
    }

    case 'startFailed':
      if (state.phase !== 'waiting' || event.attempt !== state.attempt) return keep(state);
      return failed(state, event.reasonCode);

    case 'frame': {
      // After Cancel or close, and for another flow's mode or another account, a frame changes nothing.
      if (state.phase !== 'waiting') return keep(state);
      if (event.mode !== FRAME_MODE[state.call]) return keep(state);
      if (event.accountId && event.accountId !== state.accountId) return keep(state);
      const outcome = settledState(event.state);
      if (!outcome) return keep(state);
      if (state.connectId === null) {
        const frame: SettledFrame = {
          connectId: event.connectId,
          state: event.state,
          ...(event.reasonCode ? { reasonCode: event.reasonCode } : {}),
        };
        return keep({ ...state, early: [...state.early, frame].slice(-8) });
      }
      if (event.connectId !== state.connectId) return keep(state);
      if (outcome === 'connected') return closed(state, 'reconnected');
      if (outcome === 'cancelled') return closed(state, 'cancelled');
      return failed(state, event.reasonCode);
    }

    case 'cancel': {
      if (state.phase === 'closed') return keep(state);
      if (state.phase === 'failed') return closed(state, 'failed');
      const cancel: ReconnectEffect[] = state.connectId
        ? [{ type: 'cancelConnect', connectId: state.connectId }]
        : [];
      return closed(state, 'cancelled', cancel);
    }

    case 'retry': {
      if (state.phase !== 'failed') return keep(state);
      const attempt = state.attempt + 1;
      const { reason: _old, ...rest } = state;
      return {
        state: { ...rest, phase: 'waiting', attempt, connectId: null, early: [] },
        effects: [
          {
            type: 'start',
            call: state.call,
            accountId: state.accountId,
            attempt,
            ...(state.enable ? { enable: state.enable } : {}),
          },
        ],
      };
    }
  }
}

/** What `ReconnectSheet` is given for a state: open until closed — idle draws as waiting, so the sheet never flashes shut before the open effect lands (or in a render with no effects at all). */
export function sheetView(state: ReconnectState): {
  open: boolean;
  state: 'waiting' | 'failed';
  mode: SheetMode;
  address: string;
  reason?: string;
} {
  return {
    open: state.phase !== 'closed',
    state: state.phase === 'failed' ? 'failed' : 'waiting',
    mode:
      state.call === 'grantPermissions' && state.enable === 'calendarWrite'
        ? 'enableEditing'
        : sheetMode(state.call),
    address: state.address,
    ...(state.phase === 'failed' && state.reason ? { reason: state.reason } : {}),
  };
}

/** The three calls the sheet's effects need, and nothing else: there is no sync among them (N3). */
export interface ReconnectPorts {
  /** `Account/reconnect {accountId}`: the engine passes the stored address as `login_hint`. */
  reconnect(input: { accountId: string }): Promise<{ connectId: string }>;
  /** `Account/grantPermissions {accountId, enable?}`: full re-consent for the missing scopes; `enable: 'calendarWrite'` asks for the events scope on top. */
  grantPermissions(input: {
    accountId: string;
    enable?: 'calendarWrite';
  }): Promise<{ connectId: string }>;
  /** `Account/cancelConnect {connectId}`: idempotent. */
  cancelConnect(input: { connectId: string }): Promise<unknown>;
}

/** Runs a `start` or `cancelConnect` effect against the ports and feeds the answer back. `close` is the caller's. */
export async function runReconnectEffect(
  effect: ReconnectEffect,
  ports: ReconnectPorts,
  dispatch: (event: ReconnectEvent) => void,
): Promise<void> {
  switch (effect.type) {
    case 'start':
      try {
        const input = {
          accountId: effect.accountId,
          ...(effect.enable ? { enable: effect.enable } : {}),
        };
        const out =
          effect.call === 'grantPermissions'
            ? await ports.grantPermissions(input)
            : await ports.reconnect(input);
        dispatch({ type: 'started', attempt: effect.attempt, connectId: out.connectId });
      } catch (error) {
        const code = reasonOf(error);
        dispatch({
          type: 'startFailed',
          attempt: effect.attempt,
          ...(code ? { reasonCode: code } : {}),
        });
      }
      return;
    case 'cancelConnect':
      try {
        await ports.cancelConnect({ connectId: effect.connectId });
      } catch {
        // Cancel is idempotent and a late answer is ignored anyway; nothing to show.
      }
      return;
    case 'close':
      return;
  }
}
