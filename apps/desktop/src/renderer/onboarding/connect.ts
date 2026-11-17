/**
 * The Accounts step's connect flow (DESIGN 7.11 step 2; Appendix C F9, F12). Round 1 connects Google only.
 *
 * Three layers:
 * - `reduceAccounts` is the pure state machine: choose → (discover) → typed → waiting → connected, with the failed,
 *   unsupported and cancelled branches. It returns effects (discover, connect, cancel) as data.
 * - The F9 rule lives here: a connect answer moves the Accounts step only when it settles the flow the step is
 *   visibly waiting on. Any other answer (after Cancel, after Esc, after the owner moved on, after the window closed)
 *   changes nothing on screen; the account list updates in place from `useAccounts`, and the flow records it.
 * - `useConnectFrames` and `ConnectPorts` are the thin wrapper over `renderer/data`.
 */
import { useEffect, useRef } from 'react';
import { api, useFrames } from '../data';
import type { ConnectFrame, Input, Output } from '../data';
import type { FocusTarget } from './flow';
import { reasonOf } from './reason';

/** The Accounts step's states (onboarding-accounts.html: choose, typed, waiting, connected; plus failed). */
export type AccountsMode = 'choose' | 'discovering' | 'typed' | 'waiting' | 'failed' | 'connected';

/** A plain sentence under the address field in the choose state. */
export type ChooseNotice =
  /** Not a full address yet. */
  | 'invalid'
  /** Another provider: round 1 supports Google only. */
  | 'unsupported'
  /** Discovery itself failed; Google is still offered below. */
  | 'unchecked';

export interface AccountsState {
  readonly mode: AccountsMode;
  /** The address field's text. */
  readonly address: string;
  readonly notice: ChooseNotice | null;
  /** Discovery request counter; an answer for an older request is ignored. */
  readonly discoverSeq: number;
  /** Connect request counter; an id for an abandoned request is cancelled when it arrives. */
  readonly attempt: number;
  /** The connect the step is waiting on; null until `Account/connect` answers. */
  readonly connectId: string | null;
  /** The address passed as `login_hint`, kept for Try again. */
  readonly loginHint: string | null;
  /** Why the last connect failed (a reason code for `copy.ts`). */
  readonly failure: string | null;
  /**
   * Settled frames that arrived while the step waited for `Account/connect` to return its id. A fast failure can beat
   * the id; without this the step would wait on a flow that already ended.
   */
  readonly early: readonly SettledFrame[];
}

/** A settled `connect` frame kept until its flow's id is known. */
export interface SettledFrame {
  readonly connectId: string;
  readonly state: string;
  readonly reasonCode?: string;
}

export type AccountsEvent =
  /** The Accounts step came on screen. */
  | { readonly type: 'enter'; readonly hasAccounts: boolean }
  /** The address field changed. */
  | { readonly type: 'edit'; readonly address: string }
  /** Return in the address field. */
  | { readonly type: 'submit' }
  /** `Account/discover` answered (`provider`) or failed (`error`). */
  | { readonly type: 'discovered'; readonly seq: number; readonly provider: string | 'error' }
  /** "Continue with Google", the Google row, or Try again. */
  | { readonly type: 'connect'; readonly loginHint?: string }
  /** `Account/connect` answered with its id. */
  | { readonly type: 'started'; readonly attempt: number; readonly connectId: string }
  /** `Account/connect` itself was refused. */
  | { readonly type: 'startFailed'; readonly attempt: number; readonly reasonCode?: string }
  /** A `connect` frame (mode 'new'), for this flow or any earlier one. */
  | {
      readonly type: 'frame';
      readonly connectId: string;
      readonly state: string;
      readonly reasonCode?: string;
    }
  /** Cancel (or Esc) while waiting for the browser. */
  | { readonly type: 'cancel' }
  /** "Add another account". */
  | { readonly type: 'addAnother' }
  /** "Use a different address": back to an empty field. */
  | { readonly type: 'clear' };

export type AccountsEffect =
  | { readonly type: 'discover'; readonly address: string; readonly seq: number }
  | { readonly type: 'connect'; readonly attempt: number; readonly loginHint?: string }
  | { readonly type: 'cancelConnect'; readonly connectId: string };

export interface AccountsResult {
  readonly state: AccountsState;
  readonly effects: readonly AccountsEffect[];
}

export function initialAccounts(hasAccounts = false): AccountsState {
  return {
    mode: hasAccounts ? 'connected' : 'choose',
    address: '',
    notice: null,
    discoverSeq: 0,
    attempt: 0,
    connectId: null,
    loginHint: null,
    failure: null,
    early: [],
  };
}

/** A full address: something, @, a domain with a dot. The engine validates again. */
export function looksLikeAddress(text: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text.trim());
}

const keep = (state: AccountsState): AccountsResult => ({ state, effects: [] });

/** Back to the empty choose state; the counters stay so late answers stay recognisably late. */
function cleared(state: AccountsState): AccountsState {
  return {
    ...state,
    mode: 'choose',
    address: '',
    notice: null,
    connectId: null,
    loginHint: null,
    failure: null,
    early: [],
  };
}

export function reduceAccounts(state: AccountsState, event: AccountsEvent): AccountsResult {
  switch (event.type) {
    case 'enter':
      // Coming back to the step never resumes a stale wait: the wait was cancelled when the owner left.
      return keep({ ...cleared(state), mode: event.hasAccounts ? 'connected' : 'choose' });

    case 'edit': {
      if (state.mode === 'waiting') return keep(state);
      // Editing the address drops any answer about the old one.
      const mode = state.mode === 'connected' ? 'connected' : 'choose';
      return keep({ ...state, mode, address: event.address, notice: null, failure: null });
    }

    case 'submit': {
      if (state.mode === 'waiting' || state.mode === 'discovering') return keep(state);
      const address = state.address.trim();
      if (!address) return keep(state);
      if (!looksLikeAddress(address)) return keep({ ...state, mode: 'choose', notice: 'invalid' });
      const seq = state.discoverSeq + 1;
      return {
        state: { ...state, mode: 'discovering', notice: null, failure: null, discoverSeq: seq },
        effects: [{ type: 'discover', address, seq }],
      };
    }

    case 'discovered': {
      if (state.mode !== 'discovering' || event.seq !== state.discoverSeq) return keep(state);
      if (event.provider === 'google') return keep({ ...state, mode: 'typed', notice: null });
      return keep({
        ...state,
        mode: 'choose',
        notice: event.provider === 'error' ? 'unchecked' : 'unsupported',
      });
    }

    case 'connect': {
      if (state.mode === 'waiting') return keep(state);
      const attempt = state.attempt + 1;
      const loginHint = event.loginHint?.trim() || null;
      return {
        state: {
          ...state,
          mode: 'waiting',
          attempt,
          connectId: null,
          loginHint,
          notice: null,
          failure: null,
        },
        effects: [{ type: 'connect', attempt, ...(loginHint ? { loginHint } : {}) }],
      };
    }

    case 'started': {
      // The owner cancelled (or left) before the id arrived: cancel that flow now, change nothing on screen.
      if (state.mode !== 'waiting' || event.attempt !== state.attempt || state.connectId) {
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
      return settled ? reduceAccounts(waiting, { type: 'frame', ...settled }) : keep(waiting);
    }

    case 'startFailed': {
      if (state.mode !== 'waiting' || event.attempt !== state.attempt) return keep(state);
      return keep({ ...state, mode: 'failed', connectId: null, failure: event.reasonCode ?? null });
    }

    case 'frame': {
      // A settled answer that beats `Account/connect`'s id is kept until the id arrives.
      if (state.mode === 'waiting' && state.connectId === null && frameOutcome(event.state)) {
        const { type: _type, ...frame } = event;
        return keep({ ...state, early: [...state.early, frame].slice(-8) });
      }
      // F9: only the flow the step is visibly waiting on may move it.
      if (isLateFrame(state, event.connectId)) return keep(state);
      switch (event.state) {
        case 'connected':
          return keep({ ...cleared(state), mode: 'connected' });
        case 'failed':
          return keep({
            ...state,
            mode: 'failed',
            connectId: null,
            failure: event.reasonCode ?? null,
          });
        case 'cancelled':
          return keep(cleared(state));
        default:
          return keep(state);
      }
    }

    case 'cancel': {
      if (state.mode !== 'waiting') return keep(state);
      return {
        state: cleared(state),
        effects: state.connectId ? [{ type: 'cancelConnect', connectId: state.connectId }] : [],
      };
    }

    case 'addAnother':
    case 'clear':
      return state.mode === 'waiting' ? keep(state) : keep(cleared(state));
  }
}

/** F9: a frame is late unless the step is waiting on exactly that connect. */
export function isLateFrame(state: AccountsState, connectId: string): boolean {
  return state.mode !== 'waiting' || state.connectId === null || state.connectId !== connectId;
}

/**
 * Esc inside the Accounts step, before the window goes back a step: waiting cancels; a typed, failed or unsupported
 * address clears back to the field; an empty field goes to the list when accounts exist. `handled: false` means the
 * window should go back a step.
 */
export function accountsEsc(
  state: AccountsState,
  hasAccounts: boolean,
): AccountsResult & { handled: boolean } {
  if (state.mode === 'waiting')
    return { ...reduceAccounts(state, { type: 'cancel' }), handled: true };
  const dirty =
    state.mode === 'typed' ||
    state.mode === 'failed' ||
    state.mode === 'discovering' ||
    state.notice !== null ||
    state.address !== '';
  if (state.mode !== 'connected' && dirty)
    return { state: cleared(state), effects: [], handled: true };
  if (state.mode === 'choose' && hasAccounts) {
    return { state: { ...cleared(state), mode: 'connected' }, effects: [], handled: true };
  }
  return { state, effects: [], handled: false };
}

/** The mode the step draws: the list only when there is something in it. */
export function shownMode(state: AccountsState, accountCount: number): AccountsMode {
  return state.mode === 'connected' && accountCount === 0 ? 'choose' : state.mode;
}

/** Fixed labels of the Accounts step's actions (the focus targets name them). */
export const ACCOUNTS_LABELS = {
  continueWithGoogle: 'Continue with Google',
  differentAddress: 'Use a different address',
  cancel: 'Cancel',
  tryAgain: 'Try again',
  continue: 'Continue',
  addAnother: 'Add account',
} as const;

/** DOM id of the address field. */
export const ADDRESS_FIELD_ID = 'onb-address';

/** Where focus goes in each state (F12): the field to type in, or the next primary control. */
export function accountsFocus(mode: AccountsMode): FocusTarget {
  switch (mode) {
    case 'choose':
    case 'discovering':
      return { kind: 'field', id: ADDRESS_FIELD_ID };
    case 'typed':
      return { kind: 'button', label: ACCOUNTS_LABELS.continueWithGoogle };
    case 'waiting':
      return { kind: 'button', label: ACCOUNTS_LABELS.cancel };
    case 'failed':
      return { kind: 'button', label: ACCOUNTS_LABELS.tryAgain };
    case 'connected':
      return { kind: 'button', label: ACCOUNTS_LABELS.continue };
  }
}

/** What Return does when focus is not on a control: the state's main action, or nothing. */
export type AccountsMain = 'discover' | 'connect' | 'retry' | 'continue' | null;

export function accountsMain(mode: AccountsMode): AccountsMain {
  switch (mode) {
    case 'choose':
      return 'discover';
    case 'typed':
      return 'connect';
    case 'failed':
      return 'retry';
    case 'connected':
      return 'continue';
    default:
      return null;
  }
}

/** Reads a `connect` frame into the events both reducers take. */
export function frameEvent(
  frame: Pick<ConnectFrame, 'connectId' | 'state' | 'reasonCode'>,
): AccountsEvent {
  return {
    type: 'frame',
    connectId: frame.connectId,
    state: frame.state,
    ...(frame.reasonCode ? { reasonCode: frame.reasonCode } : {}),
  };
}

/** The settled outcome of a frame, or null while it is still waiting. */
export function frameOutcome(state: string): 'connected' | 'failed' | 'cancelled' | null {
  return state === 'connected' || state === 'failed' || state === 'cancelled' ? state : null;
}

/** The calls the connect flow makes. Defaults come from `renderer/data`; the preview and tests pass their own. */
export interface ConnectPorts {
  discover(input: Input<'Account/discover'>): Promise<Output<'Account/discover'>>;
  connect(input: Input<'Account/connect'>): Promise<Output<'Account/connect'>>;
  cancelConnect(input: Input<'Account/cancelConnect'>): Promise<Output<'Account/cancelConnect'>>;
}

export const defaultConnectPorts: ConnectPorts = {
  discover: async input => api.account.discover(input),
  connect: async input => api.account.connect(input),
  cancelConnect: async input => api.account.cancelConnect(input),
};

/**
 * Runs the Accounts effects against the ports and feeds the answers back. A discovery that fails falls back to
 * offering Google (`unchecked`), so the step never waits on it.
 */
export async function runAccountsEffect(
  effect: AccountsEffect,
  ports: ConnectPorts,
  dispatch: (event: AccountsEvent) => void,
  setupId: string | undefined,
): Promise<void> {
  switch (effect.type) {
    case 'discover':
      try {
        const out = await ports.discover({ address: effect.address });
        dispatch({ type: 'discovered', seq: effect.seq, provider: out.provider });
      } catch {
        dispatch({ type: 'discovered', seq: effect.seq, provider: 'error' });
      }
      return;
    case 'connect':
      try {
        const out = await ports.connect({
          provider: 'google',
          ...(effect.loginHint ? { loginHint: effect.loginHint } : {}),
          ...(setupId ? { setupId } : {}),
        });
        dispatch({ type: 'started', attempt: effect.attempt, connectId: out.connectId });
      } catch (error) {
        dispatch({ type: 'startFailed', attempt: effect.attempt, reasonCode: reasonOf(error) });
      }
      return;
    case 'cancelConnect':
      try {
        await ports.cancelConnect({ connectId: effect.connectId });
      } catch {
        // Cancel is idempotent and the late answer is ignored anyway (F9); nothing to show.
      }
      return;
  }
}

/**
 * Every `connect` frame of new-account flows, delivered once each, in order. It listens to all `mode: 'new'` frames
 * rather than one `connectId`, so an answer for a flow the owner already left (cancelled, Esc, moved on) still
 * reaches the reducers, which record the account and never navigate (F9).
 */
export function useConnectFrames(onFrame: (frame: ConnectFrame) => void): void {
  const { frames } = useFrames('connect', { mode: 'new' });
  const seen = useRef(new Set<string>());
  const handler = useRef(onFrame);
  handler.current = onFrame;
  useEffect(() => {
    for (const frame of frames) {
      const key = `${frame.connectId}:${frame.state}:${frame.seq}`;
      if (seen.current.has(key)) continue;
      seen.current.add(key);
      handler.current(frame);
    }
  }, [frames]);
}
