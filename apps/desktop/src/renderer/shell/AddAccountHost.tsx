/**
 * The inline Add account host (DESIGN 7.1, 7.11 step 2; plan 30 4.5): a Dialog over the mail window that connects one
 * more Google account without opening the setup window. It runs the onboarding lane's Accounts connect flow
 * (`onboarding/connect.ts`) on the data layer's ports and draws it in the Dialog's own frame, because
 * `onboarding/steps/AccountsStep` draws the setup window's frame (the strip, the dashes, "Setup continues in the
 * background"). The rules (Esc, Return, the toast, ending a wait) live in `add-account-controller.ts`; this file
 * subscribes to it and draws.
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
  ADDRESS_FIELD_ID,
  useConnectFrames,
  type AccountsMode,
  type ChooseNotice,
  type ConnectPorts,
} from '../onboarding/connect';
import { connectSentence } from '../onboarding/copy';
import { noticeSentence } from '../onboarding/steps/Accounts';
import { dataConnectPorts } from '../onboardingPorts';
import { Button } from '../ui/buttons-keys';
import { TextField } from '../ui/controls';
import { ChoiceRow } from '../ui/onboarding';
import { ProgressSegments } from '../ui/status';
import { Dialog, Text } from '../ui/surfaces';
import { FOCUS_IDS, addAccountFocusId, createAddAccountController } from './add-account-controller';
import { closeSheet, pushToast, useRegisterCommands } from './index';

const TITLE = 'Add an account';
const LEDE =
  'Type your address and Aplos finds the right sign-in. Aplos reads your mail on this Mac.';
const WAITING = 'Waiting for Google in your browser…';

/**
 * The field, and under it the one line that belongs to it (a refusal, or why the address was not used). The line is
 * the field's `error`: a polite status, linked to the field with `aria-describedby` and `aria-invalid`.
 */
function AddressBlock(props: {
  readonly address: string;
  readonly problem?: string;
  readonly keycap: boolean;
  readonly onEdit: (address: string) => void;
  readonly onSubmit: () => void;
}) {
  return (
    <TextField
      id={ADDRESS_FIELD_ID}
      value={props.address}
      onChange={props.onEdit}
      onSubmit={props.onSubmit}
      label="Email address"
      placeholder="name@example.com"
      type="email"
      size="lg"
      icon="mail"
      {...(props.keycap ? { trailingKeys: 'Return' as const } : {})}
      {...(props.problem ? { error: props.problem } : {})}
    />
  );
}

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
  const { mode } = props;
  if (mode === 'waiting') {
    return (
      <div className="aplos-add-account__block">
        <p className="aplos-add-account__wait" role="status">
          {WAITING}
        </p>
        <ProgressSegments variant="waiting" label="Waiting for sign-in" />
      </div>
    );
  }
  const field = { address: props.address, onEdit: props.onEdit, onSubmit: props.onSubmit };
  if (mode === 'typed') {
    return (
      <div className="aplos-add-account__block">
        <AddressBlock {...field} keycap={false} />
        <ChoiceRow
          id="add-account-found-google"
          role="static"
          label="Google"
          icon="mail"
          detail="You sign in on Google's own page in your browser. Aplos never sees your password."
          status={{ text: 'Found', tone: 'ok' }}
        />
      </div>
    );
  }
  if (mode === 'failed') {
    const problem = connectSentence(props.failure ?? undefined, {
      address: props.address || undefined,
    });
    return (
      <div className="aplos-add-account__block">
        <AddressBlock {...field} keycap={false} problem={problem} />
      </div>
    );
  }
  return (
    <div className="aplos-add-account__block">
      <AddressBlock
        {...field}
        keycap
        {...(props.notice ? { problem: noticeSentence(props.notice) } : {})}
      />
      <Text variant="label">Or choose a provider</Text>
      <ChoiceRow
        id="add-account-google"
        role="link"
        label="Google"
        icon="mail"
        onPress={props.onChooseGoogle}
      />
    </div>
  );
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
