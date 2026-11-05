/**
 * Step 2, Accounts (DESIGN 7.11 step 2; onboarding-accounts.html choose, typed, waiting, connected; Appendix C F9,
 * F12). Round 1 offers Google only: the Microsoft, iCloud and IMAP rows of the mockup return in round 2.
 *
 * Presentational: the window root owns the state (`connect.ts`) because a connect can answer after the owner left
 * this step, and that answer must still reach the window without navigating (F9).
 */
import type { AccountsMode, ChooseNotice } from '../connect';
import { ACCOUNTS_LABELS, ADDRESS_FIELD_ID } from '../connect';
import { connectSentence } from '../copy';
import { backFooter, type StepChrome, type WindowNotice } from '../flow';
import { WindowNoticeLine } from '../WindowNotice';
import { ChoiceRow, OnboardingStep } from '../../ui/onboarding';
import { TextField } from '../../ui/controls';
import { Text } from '../../ui/surfaces';
import { ProgressSegments } from '../../ui/status';
import { ErrorLine } from '../../ui/list';
import type { StepButton, TagColor } from '../../ui/props';

/** One connected account as the list shows it. */
export interface AccountRowData {
  readonly id: string;
  readonly address: string;
  /** Demo accounts read "Demo mail" instead of "Google". */
  readonly demo: boolean;
  /** The account's colour, shown only with two or more accounts (DESIGN decision 16). */
  readonly color?: TagColor;
}

/**
 * The connect flow's content with no frame around it, so a host that draws its own frame — the shell's
 * Add account `Dialog` (`shell/AddAccountHost.tsx`) can show the same body the Accounts step does without
 * `OnboardingStep`'s title, lede, actions row, footer and step dashes. (The dialog still draws its own copy of
 * this body today; adopting `AccountsBody` there is the shell's follow-up.)
 *
 * The host owns the state (`reduceAccounts` in `../connect.ts`) and provides: the connected `accounts`, the
 * connect state (`mode`, `address`, `notice`, `failure`), the field callbacks `onEdit`/`onSubmit` and the
 * provider row's `onChooseGoogle`. A state's action buttons (Continue with Google, Try again, Cancel,
 * "Use a different address") belong to the host's own frame — `OnboardingStep`'s `actions` in the step, the
 * dialog's footer in the dialog — and focus stays with the host too: the body autofocuses nothing.
 */
export interface AccountsBodyProps {
  /** The state to draw (`shownMode`). */
  readonly mode: AccountsMode;
  /** The address field's text. */
  readonly address: string;
  /** The choose state's notice for an address Aplos can't use yet. */
  readonly notice: ChooseNotice | null;
  /** The failed connect's reason code. */
  readonly failure: string | null;
  /** The connected accounts the connected state lists. */
  readonly accounts: readonly AccountRowData[];
  /** The address field's text changed. */
  readonly onEdit: (address: string) => void;
  /** Return in the address field: discover the provider. */
  readonly onSubmit: () => void;
  /** The Google row: sign in without an address. */
  readonly onChooseGoogle: () => void;
  /** A window-level failure line (a failed demo load or handoff) drawn under the body; hosts without one omit it. */
  readonly windowNotice?: WindowNotice;
}

export interface AccountsStepProps extends Omit<AccountsBodyProps, 'windowNotice'> {
  readonly chrome: StepChrome;
  /** "Continue with Google" or Try again, with the typed address as `login_hint`. */
  readonly onConnect: () => void;
  readonly onCancel: () => void;
  /** "Use a different address". */
  readonly onClear: () => void;
  readonly onContinue: () => void;
  readonly onAddAnother: () => void;
}

const TITLE = 'Add your mail';
const LEDE =
  'Type your address and Aplos finds the right sign-in. Aplos reads your mail on this Mac.';

/** The sentence under the field for each notice; round 1 supports Google only. */
export function noticeSentence(notice: ChooseNotice): string {
  switch (notice) {
    case 'invalid':
      return 'Type the whole address, like name@example.com.';
    case 'unsupported':
      return 'Aplos works with Google accounts in this version. Choose Google below to sign in.';
    case 'unchecked':
      return "Aplos couldn't check that address. Choose Google below to sign in.";
  }
}

const filled = (label: string, onSelect: () => void): StepButton => ({
  label,
  emphasis: 'filled',
  keys: 'Return',
  keyHint: 'always',
  onSelect,
});

function AddressField(
  props: Pick<AccountsStepProps, 'address' | 'onEdit' | 'onSubmit'> & {
    keycap: boolean;
    notice?: string;
    /** A failed connect's sentence: the error icon in `--stamp-ink`, the words in ink (DESIGN 7.15). */
    failure?: string;
  },
) {
  return (
    <div className="onb-field-block">
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

function GoogleChoice({ onChooseGoogle }: Pick<AccountsStepProps, 'onChooseGoogle'>) {
  return (
    <div className="onb-group">
      <Text variant="label">Or choose a provider</Text>
      <div className="onb-rows">
        <ChoiceRow
          id="onb-provider-google"
          role="link"
          label="Google"
          icon="mail"
          onPress={onChooseGoogle}
        />
      </div>
    </div>
  );
}

/** Every state's content, with no frame: what `AccountsStep` puts inside `OnboardingStep` (the props tell why). */
export function AccountsBody(props: AccountsBodyProps) {
  // A failed demo load or handoff, in every state of the step.
  const windowNotice = <WindowNoticeLine notice={props.windowNotice} />;

  if (props.mode === 'waiting') {
    return (
      <>
        <div className="onb-wide">
          <ProgressSegments variant="waiting" label="Waiting for sign-in" />
        </div>
        {windowNotice}
      </>
    );
  }

  if (props.mode === 'connected') {
    const several = props.accounts.length > 1;
    return (
      <>
        <div className="onb-rows" role="group" aria-label="Connected accounts">
          {props.accounts.map(account => (
            <ChoiceRow
              key={account.id}
              id={`onb-account-${account.id}`}
              role="static"
              label={account.address}
              detail={account.demo ? 'Demo mail' : 'Google'}
              status={{ text: 'Connected', tone: 'ok' }}
              {...(several && account.color ? { mark: account.color } : {})}
            />
          ))}
        </div>
        {windowNotice}
      </>
    );
  }

  if (props.mode === 'typed') {
    return (
      <>
        <AddressField
          address={props.address}
          onEdit={props.onEdit}
          onSubmit={props.onSubmit}
          keycap={false}
        />
        <div className="onb-rows">
          <ChoiceRow
            id="onb-found-google"
            role="static"
            label="Google"
            icon="mail"
            detail="You sign in on Google's own page in your browser. Aplos never sees your password."
            status={{ text: 'Found', tone: 'ok' }}
          />
        </div>
        {windowNotice}
      </>
    );
  }

  if (props.mode === 'failed') {
    const sentence = connectSentence(props.failure ?? undefined, {
      address: props.address || undefined,
    });
    return (
      <>
        <AddressField
          address={props.address}
          onEdit={props.onEdit}
          onSubmit={props.onSubmit}
          keycap={false}
          failure={sentence}
        />
        {windowNotice}
      </>
    );
  }

  // choose and discovering share the field; a notice explains an address Aplos can't use yet.
  const notice = props.notice ? noticeSentence(props.notice) : undefined;
  return (
    <>
      <AddressField
        address={props.address}
        onEdit={props.onEdit}
        onSubmit={props.onSubmit}
        keycap
        {...(notice ? { notice } : {})}
      />
      <GoogleChoice onChooseGoogle={props.onChooseGoogle} />
      {windowNotice}
    </>
  );
}

export function AccountsStep(props: AccountsStepProps) {
  const { chrome, mode } = props;
  const common = {
    titleId: 'onb-title',
    footer: backFooter(chrome),
    ...(chrome.onTryDemo ? { onTryDemo: chrome.onTryDemo } : {}),
  };
  const body = <AccountsBody {...props} windowNotice={chrome.notice} />;

  if (mode === 'waiting') {
    return (
      <OnboardingStep
        {...common}
        layout="step"
        title="Waiting for Google in your browser…"
        lede="Finish signing in there, then come back. Aplos only asks to read and send your mail and calendar, and you can revoke that any time."
        actions={[
          {
            label: ACCOUNTS_LABELS.cancel,
            emphasis: 'text',
            keys: 'Esc',
            keyHint: 'always',
            onSelect: props.onCancel,
          },
        ]}
        phaseStatus={chrome.status ?? 'Waiting for Google in your browser.'}
      >
        {body}
      </OnboardingStep>
    );
  }

  if (mode === 'connected') {
    return (
      <OnboardingStep
        {...common}
        layout="step"
        title="Your accounts"
        lede="Mail from every account lands together. Add another one now or later in Settings."
        actions={[
          filled(ACCOUNTS_LABELS.continue, props.onContinue),
          {
            label: ACCOUNTS_LABELS.addAnother,
            emphasis: 'text',
            icon: 'plus',
            onSelect: props.onAddAnother,
          },
        ]}
        {...(chrome.status ? { phaseStatus: chrome.status } : {})}
      >
        {body}
      </OnboardingStep>
    );
  }

  if (mode === 'typed') {
    return (
      <OnboardingStep
        {...common}
        layout="step"
        title={TITLE}
        lede={LEDE}
        actions={[
          filled(ACCOUNTS_LABELS.continueWithGoogle, props.onConnect),
          { label: ACCOUNTS_LABELS.differentAddress, emphasis: 'text', onSelect: props.onClear },
        ]}
        phaseStatus={chrome.status ?? 'Found Google.'}
      >
        {body}
      </OnboardingStep>
    );
  }

  if (mode === 'failed') {
    const sentence = connectSentence(props.failure ?? undefined, {
      address: props.address || undefined,
    });
    return (
      <OnboardingStep
        {...common}
        layout="step"
        title={TITLE}
        lede={LEDE}
        actions={[
          filled(ACCOUNTS_LABELS.tryAgain, props.onConnect),
          { label: ACCOUNTS_LABELS.differentAddress, emphasis: 'text', onSelect: props.onClear },
        ]}
        phaseStatus={chrome.status ?? sentence}
      >
        {body}
      </OnboardingStep>
    );
  }

  const notice = props.notice ? noticeSentence(props.notice) : undefined;
  return (
    <OnboardingStep
      {...common}
      layout="step"
      title={TITLE}
      lede={LEDE}
      {...(chrome.status || notice ? { phaseStatus: chrome.status ?? notice } : {})}
    >
      {body}
    </OnboardingStep>
  );
}
