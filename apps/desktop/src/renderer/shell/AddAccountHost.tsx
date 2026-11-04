/**
 * The inline Add account host (DESIGN 7.1, 7.11 step 2; plan 30 4.5): a Dialog over the mail window that connects one
 * more Google account without opening the setup window. It runs the onboarding lane's Accounts connect flow
 * (`onboarding/connect.ts`: `reduceAccounts`, `runAccountsEffect`, `useConnectFrames`) on the data layer's ports and
 * draws it in the Dialog's own frame, because `onboarding/steps/AccountsStep` draws the setup window's frame (the
 * strip, the dashes, "Setup continues in the background").
 *
 * Opened by `openAddAccount()` (the account switcher's "Add an account", the empty state's button); it is the shell's
 * `addAccount` sheet, so one sheet shows at a time, the modal `sheet` key context is on, and focus returns to the
 * opener. Esc steps back like the onboarding step does (cancel the wait, clear the field), then closes. A connect that
 * lands closes the dialog with an "Account added" toast; an answer that settles a flow the owner already left is
 * recorded by the data layer and never moves this dialog (F9).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  useConnectFrames,
  type AccountsEvent,
  type AccountsMode,
  type AccountsResult,
  type AccountsState,
  type ChooseNotice,
  type ConnectPorts,
} from '../onboarding/connect';
import { connectSentence } from '../onboarding/copy';
import { noticeSentence } from '../onboarding/steps/Accounts';
import { dataConnectPorts } from '../onboardingPorts';
import { Button } from '../ui/buttons-keys';
import { TextField } from '../ui/controls';
import { ErrorLine } from '../ui/list';
import { ChoiceRow } from '../ui/onboarding';
import { ProgressSegments } from '../ui/status';
import { Dialog, Text } from '../ui/surfaces';
import { closeSheet, pushToast, useRegisterCommands } from './index';

const TITLE = 'Add an account';
const LEDE =
  'Type your address and Aplos finds the right sign-in. Aplos reads your mail on this Mac.';
const PRIMARY_ID = 'add-account-primary';
const WAITING = 'Waiting for Google in your browser…';

/** The field (and, after an address was typed, the provider it found) for the states that show one. */
function AddressBlock(props: {
  readonly address: string;
  readonly notice?: string;
  readonly failure?: string;
  readonly keycap: boolean;
  readonly onEdit: (address: string) => void;
  readonly onSubmit: () => void;
}) {
  return (
    <div className="aplos-add-account__block">
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
      />
      {props.notice ? (
        <Text variant="small" tone="ink-2">
          {props.notice}
        </Text>
      ) : null}
      {props.failure ? (
        <ErrorLine
          kind="reason"
          text={props.failure}
          retryable={false}
          placement="checklist"
          onAction={() => {}}
        />
      ) : null}
    </div>
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
  /** Return in the field: find the provider. */
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
    const sentence = connectSentence(props.failure ?? undefined, {
      address: props.address || undefined,
    });
    return <AddressBlock {...field} keycap={false} failure={sentence} />;
  }
  return (
    <div className="aplos-add-account__block">
      <AddressBlock
        {...field}
        keycap
        {...(props.notice ? { notice: noticeSentence(props.notice) } : {})}
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
          id={PRIMARY_ID}
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

/** The dialog for one state of the flow. Presentational; `AddAccountHost` owns the state. */
export function AddAccountView(props: AddAccountViewProps) {
  const target = accountsFocus(props.mode);
  return (
    <Dialog
      open
      title={TITLE}
      description={LEDE}
      size="md"
      footer={footerOf(props)}
      initialFocusId={target.kind === 'field' ? target.id : PRIMARY_ID}
      onClose={props.onClose}
    >
      {bodyOf(props)}
    </Dialog>
  );
}

/** The flow's state and its events: effects run on `ports`, and a connect frame for the flow settles it. */
function useAddAccountFlow(ports: ConnectPorts) {
  const [state, setState] = useState<AccountsState>(() => initialAccounts(false));
  const ref = useRef(state);
  const answer = useRef<(event: AccountsEvent) => void>(() => {});
  const apply = useCallback(
    (out: AccountsResult) => {
      ref.current = out.state;
      setState(out.state);
      for (const effect of out.effects) {
        void runAccountsEffect(effect, ports, event => answer.current(event), undefined);
      }
    },
    [ports],
  );
  const dispatch = useCallback(
    (event: AccountsEvent) => apply(reduceAccounts(ref.current, event)),
    [apply],
  );
  answer.current = dispatch;
  useConnectFrames(frame => dispatch(frameEvent(frame)));
  useEffect(
    () => () => {
      // The sheet went away (replaced, or the engine left) while the browser is open: end that flow.
      const { mode, connectId } = ref.current;
      if (mode === 'waiting' && connectId) void ports.cancelConnect({ connectId }).catch(() => {});
    },
    [ports],
  );
  return { state, ref, apply, dispatch };
}

/** Props for `AddAccountHost`. */
export interface AddAccountHostProps {
  /** The calls the flow makes; the data layer's by default. */
  readonly ports?: ConnectPorts;
}

/** The open Add account sheet. */
export function AddAccountHost({ ports = dataConnectPorts }: AddAccountHostProps) {
  const { state, ref, apply, dispatch } = useAddAccountFlow(ports);
  const connect = useCallback(
    (loginHint?: string) => dispatch({ type: 'connect', ...(loginHint ? { loginHint } : {}) }),
    [dispatch],
  );
  const retry = () => connect(ref.current.loginHint ?? ref.current.address);
  const connectTyped = () => connect(ref.current.address);
  const onEsc = () => {
    const out = accountsEsc(ref.current, false);
    if (out.handled) apply(out);
    else closeSheet();
  };
  const mode = state.mode;
  useEffect(() => {
    if (mode !== 'connected') return;
    pushToast({ id: 'account-added', kind: 'info', message: 'Account added', undoable: false });
    closeSheet();
  }, [mode]);
  // Return when focus is not on a control: the state's main action (a focused control answers Return itself).
  const main = accountsMain(mode);
  const handlers = useMemo(
    () => ({
      'sheet.default': {
        run: () => {
          if (main === 'discover') dispatch({ type: 'submit' });
          else if (main === 'connect') connect(ref.current.address);
          else if (main === 'retry') connect(ref.current.loginHint ?? ref.current.address);
        },
      },
    }),
    [main, dispatch, connect, ref],
  );
  useRegisterCommands(handlers);
  return (
    <AddAccountView
      mode={mode}
      address={state.address}
      notice={state.notice}
      failure={state.failure}
      onEdit={address => dispatch({ type: 'edit', address })}
      onSubmit={() => dispatch({ type: 'submit' })}
      onConnect={mode === 'failed' ? retry : connectTyped}
      onChooseGoogle={() => connect()}
      onCancel={() => dispatch({ type: 'cancel' })}
      onClear={() => dispatch({ type: 'clear' })}
      onClose={onEsc}
    />
  );
}
