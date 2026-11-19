/**
 * The inline Add account host (DESIGN 7.1, 7.11 step 2; plan 30 4.5): a Dialog over the mail window that connects one
 * more Google account without opening the setup window. It runs the onboarding lane's Accounts connect flow
 * (`onboarding/connect.ts`) on the data layer's ports and draws the lane's `AccountsBody`
 * (`onboarding/steps/Accounts`) inside the Dialog's own frame — the step wraps the same body in `OnboardingStep`'s
 * strip, dashes, title and "Setup continues in the background" note, which the dialog does not have. The rules
 * (Esc, Return, the toast, ending a wait) live in `add-account-controller.ts`; this file subscribes to it and draws.
 *
 * Opened by `openAddAccount()` (the account switcher's "Add an account", the empty state's button); it is the shell's
 * `addAccount` sheet, so one sheet shows at a time, the modal `sheet` key context is on, and focus returns to the
 * opener. Each state names its own primary control (`addAccountFocusId`), so focus follows the state and is never
 * lost when a button goes away. A connect that lands closes the dialog with an "Account added" toast; an answer that
 * settles a flow the owner already left is recorded by the data layer and never moves this dialog (F9).
 */
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import {
  ACCOUNTS_LABELS,
  useConnectFrames,
  type AccountsMode,
  type ChooseNotice,
  type ConnectPorts,
} from '../onboarding/connect';
import { AccountsBody } from '../onboarding/steps/Accounts';
import { dataConnectPorts } from '../onboardingPorts';
import { Button } from '../ui/buttons-keys';
import { Dialog } from '../ui/surfaces';
import { FOCUS_IDS, addAccountFocusId, createAddAccountController } from './add-account-controller';
import { closeSheet, pushToast, useRegisterCommands } from './index';

const TITLE = 'Add account';
const LEDE =
  'Type your address and Aplos finds the right sign-in. Aplos reads your mail on this Mac.';
const WAITING = 'Waiting for Google in your browser…';

/**
 * The id of the body's one live region (the notice or failed-connect line). The step's `phaseStatus` announces for
 * the step; the dialog has no status line of its own, so the body's line is the status — `liveLineId` also makes a
 * refused address the field's own error and points the field at the line.
 */
const LINE_ID = 'add-account-line';

/** Props for `AddAccountView`. */
export interface AddAccountViewProps {
  readonly mode: AccountsMode;
  readonly address: string;
  readonly notice: ChooseNotice | null;
  /** The failed connect's reason code. */
  readonly failure: string | null;
  readonly onEdit: (address: string) => void;
  /** Return in the field, or the primary button: the state's main action. */
  readonly onSubmit: () => void;
  /** "Continue with Google" or Try again. */
  readonly onConnect: () => void;
  /** The Google row: sign in without an address. */
  readonly onChooseGoogle: () => void;
  readonly onCancel: () => void;
  /** "Use a different address". */
  readonly onClear: () => void;
  /** Esc, the scrim, Cancel in the field states. */
  readonly onClose: () => void;
}

function bodyOf(props: AddAccountViewProps) {
  const body = (
    <AccountsBody
      mode={props.mode}
      address={props.address}
      notice={props.notice}
      failure={props.failure}
      accounts={[]}
      onEdit={props.onEdit}
      onSubmit={props.onSubmit}
      onChooseGoogle={props.onChooseGoogle}
      liveLineId={LINE_ID}
    />
  );
  // The step titles its wait ("Waiting for Google in your browser…"); the dialog's title stays "Add an account",
  // so the line belongs to this frame — the one live region over the body's segments.
  if (props.mode === 'waiting') {
    return (
      <div className="aplos-add-account__block">
        <p className="aplos-add-account__wait" role="status">
          {WAITING}
        </p>
        {body}
      </div>
    );
  }
  return <div className="aplos-add-account__block">{body}</div>;
}

function footerOf({ mode, onCancel, onClear, onClose, onConnect }: AddAccountViewProps) {
  const cancel = (onPress: () => void) => (
    <Button
      id={FOCUS_IDS.cancel}
      variant="text"
      label={ACCOUNTS_LABELS.cancel}
      keys="Esc"
      keyHint="always"
      onPress={onPress}
    />
  );
  if (mode === 'waiting') return cancel(onCancel);
  if (mode === 'typed' || mode === 'failed') {
    return (
      <>
        <Button variant="text" label={ACCOUNTS_LABELS.differentAddress} onPress={onClear} />
        <Button
          id={mode === 'failed' ? FOCUS_IDS.retry : FOCUS_IDS.continue}
          variant="filled"
          label={mode === 'failed' ? ACCOUNTS_LABELS.tryAgain : ACCOUNTS_LABELS.continueWithGoogle}
          keys="Return"
          keyHint="always"
          onPress={onConnect}
        />
      </>
    );
  }
  return cancel(onClose);
}

/**
 * The dialog for one state of the flow. Presentational; `AddAccountHost` owns the state. Focus follows the state: the
 * mode's primary control has its own id, so the dialog refocuses on every transition. A connected flow draws nothing
 * (the host closes the sheet in the same commit).
 */
export function AddAccountView(props: AddAccountViewProps) {
  if (props.mode === 'connected') return null;
  return (
    <Dialog
      open
      title={TITLE}
      description={LEDE}
      size="md"
      footer={footerOf(props)}
      initialFocusId={addAccountFocusId(props.mode)}
      onClose={props.onClose}
    >
      {bodyOf(props)}
    </Dialog>
  );
}

/** Props for `AddAccountHost`. */
export interface AddAccountHostProps {
  /** The calls the flow makes; the data layer's by default. */
  readonly ports?: ConnectPorts;
}

/** The open Add account sheet. */
export function AddAccountHost({ ports = dataConnectPorts }: AddAccountHostProps) {
  const controller = useMemo(
    () => createAddAccountController(ports, { closeSheet, pushToast }),
    [ports],
  );
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  useConnectFrames(controller.frame);
  // The sheet went away (replaced, or the engine left) while the browser is open: end that flow.
  useEffect(() => controller.dispose, [controller]);
  // Return when focus is not on a control: the state's main action (a focused control answers Return itself).
  const handlers = useMemo(() => ({ 'sheet.default': { run: controller.enter } }), [controller]);
  useRegisterCommands(handlers);
  return (
    <AddAccountView
      mode={state.mode}
      address={state.address}
      notice={state.notice}
      failure={state.failure}
      onEdit={address => controller.dispatch({ type: 'edit', address })}
      onSubmit={controller.enter}
      onConnect={controller.enter}
      onChooseGoogle={controller.chooseGoogle}
      onCancel={() => controller.dispatch({ type: 'cancel' })}
      onClear={() => controller.dispatch({ type: 'clear' })}
      onClose={controller.esc}
    />
  );
}
