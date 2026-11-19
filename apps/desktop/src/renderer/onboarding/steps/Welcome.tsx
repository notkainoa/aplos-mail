/**
 * Step 1, Welcome (DESIGN 7.11; onboarding-welcome.html): one `display` line, one sentence and one filled "Add an
 * account" (Return). No icon, no picture. Centred with `safe center`, the only step that is. Esc is "Skip setup".
 */
import type { StepChrome } from '../flow';
import { MAIN_LABEL } from '../flow';
import { OnboardingStep } from '../../ui/onboarding';
import { WindowNoticeLine } from '../WindowNotice';

export const WELCOME_TITLE = 'Mail and calendar, one letter at a time.';
export const WELCOME_LEDE =
  'Aplos puts the email that needs you on top, sums each one up in a line, and keeps every action on a key.';

export interface WelcomeProps {
  readonly chrome: StepChrome;
  /** "Add an account" (Return). */
  readonly onAddAccount: () => void;
  /** "Skip setup" (Esc), or "Close" when accounts exist and the window was only reopened to look. */
  readonly onSkip: () => void;
  readonly hasAccounts?: boolean;
}

export function Welcome({ chrome, onAddAccount, onSkip, hasAccounts = false }: WelcomeProps) {
  return (
    <OnboardingStep
      layout="welcome"
      title={WELCOME_TITLE}
      titleId="onb-title"
      lede={WELCOME_LEDE}
      actions={[
        {
          label: MAIN_LABEL.welcome,
          emphasis: 'filled',
          keys: 'Return',
          keyHint: 'always',
          onSelect: onAddAccount,
        },
      ]}
      footer={{
        ...(chrome.dashes ? { dashes: chrome.dashes } : {}),
        note: 'none',
        buttons: [
          {
            label: hasAccounts ? 'Close' : 'Skip setup',
            emphasis: 'text',
            keys: 'Esc',
            keyHint: 'hint',
            onSelect: onSkip,
          },
        ],
      }}
      {...(chrome.onTryDemo ? { onTryDemo: chrome.onTryDemo } : {})}
      {...(chrome.status ? { phaseStatus: chrome.status } : {})}
    >
      <WindowNoticeLine notice={chrome.notice} />
    </OnboardingStep>
  );
}
