/**
 * The Add account dialog's logic without React: the onboarding Accounts reducer run on the data layer's ports, plus
 * the dialog's own rules (Esc steps back then closes, Return is the state's one main action, a landed connect toasts
 * once and closes, leaving the dialog ends a wait). `AddAccountHost` only subscribes and draws; every rule here is
 * unit-tested with a fake `ports` and fake sheet and toast calls.
 */
import {
  ACCOUNTS_LABELS,
  ADDRESS_FIELD_ID,
  accountsEsc,
  accountsFocus,
  accountsMain,
  frameEvent,
  initialAccounts,
  reduceAccounts,
  runAccountsEffect,
  type AccountsEvent,
  type AccountsMode,
  type AccountsResult,
  type AccountsState,
  type ConnectPorts,
} from '../onboarding/connect';
import type { ConnectFrame } from '../data';

/** DOM ids of each mode's primary control; the dialog moves focus to it when the mode changes. */
export const FOCUS_IDS = {
  field: ADDRESS_FIELD_ID,
  continue: 'add-account-continue',
  cancel: 'add-account-cancel',
  retry: 'add-account-retry',
} as const;

/** The id of the control that holds focus in a mode (`accountsFocus` decides which); none once connected. */
export function addAccountFocusId(mode: AccountsMode): string | undefined {
  const target = accountsFocus(mode);
  if (target.kind === 'field') return target.id;
  switch (target.label) {
    case ACCOUNTS_LABELS.continueWithGoogle:
      return FOCUS_IDS.continue;
    case ACCOUNTS_LABELS.cancel:
      return FOCUS_IDS.cancel;
    case ACCOUNTS_LABELS.tryAgain:
      return FOCUS_IDS.retry;
    default:
      return undefined;
  }
}

/** The shell calls the dialog makes. */
export interface AddAccountShell {
  closeSheet(): void;
  pushToast(toast: { id: string; kind: 'info'; message: string; undoable: false }): unknown;
}

export interface AddAccountController {
  getState(): AccountsState;
  subscribe(listener: () => void): () => void;
  dispatch(event: AccountsEvent): void;
  /** A `connect` frame from the data layer. */
  frame(frame: Pick<ConnectFrame, 'connectId' | 'state' | 'reasonCode'>): void;
  /** Return or the primary button: the state's main action, once. */
  enter(): void;
  /** Start the flow with no address (the Google row). */
  chooseGoogle(): void;
  /** Esc and the scrim: cancel the wait, then clear the field, then close. */
  esc(): void;
  /** The dialog went away: end a wait, and cancel a connect id that arrives late. */
  dispose(): void;
}

export function createAddAccountController(
  ports: ConnectPorts,
  shell: AddAccountShell,
): AddAccountController {
  let state = initialAccounts(false);
  let landed = false;
  const listeners = new Set<() => void>();

  const land = () => {
    if (landed || state.mode !== 'connected') return;
    landed = true;
    shell.pushToast({
      id: 'account-added',
      kind: 'info',
      message: 'Account added',
      undoable: false,
    });
    shell.closeSheet();
  };

  const apply = (out: AccountsResult) => {
    const changed = out.state !== state;
    state = out.state;
    if (changed) for (const listener of [...listeners]) listener();
    for (const effect of out.effects) {
      void runAccountsEffect(effect, ports, dispatch, undefined);
    }
    land();
  };

  function dispatch(event: AccountsEvent) {
    apply(reduceAccounts(state, event));
  }

  const connect = (loginHint?: string) =>
    dispatch({ type: 'connect', ...(loginHint ? { loginHint } : {}) });

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    dispatch,
    frame: frame => dispatch(frameEvent(frame)),
    enter() {
      const main = accountsMain(state.mode);
      if (main === 'discover') dispatch({ type: 'submit' });
      else if (main === 'connect') connect(state.address);
      else if (main === 'retry') connect(state.loginHint ?? state.address);
    },
    chooseGoogle: () => connect(),
    esc() {
      const out = accountsEsc(state, false);
      if (out.handled) apply(out);
      else shell.closeSheet();
    },
    dispose() {
      // A cancel with no id yet ends nothing; the id that arrives later is cancelled by the reducer (`started`).
      if (state.mode === 'waiting') dispatch({ type: 'cancel' });
    },
  };
}
