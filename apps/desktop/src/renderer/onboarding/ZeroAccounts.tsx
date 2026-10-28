/**
 * The mail window's empty state with no accounts (DESIGN 7.14 "No accounts"; plan 30 §4.5 row 8; empty.html
 * no-accounts): "Add an account to bring in your mail." with the filled "Add an account" and the text "Try demo mail".
 * Nothing else: no icon in a circle, no illustration.
 *
 * "Add an account" opens the onboarding window (`Window/openOnboarding`). "Try demo mail" calls `Demo/load` once, in
 * place, and says so in a toast; nothing loads until it is clicked. While a first sync runs this is never shown: the
 * pane says "Your first mail is on its way." instead (§4.5 rows 8 and 10), so a mailbox that is still arriving never
 * reads as an empty install.
 *
 * `ZeroAccountsView` draws and `ZeroAccounts` is the container that reads `renderer/data`.
 */
import { useRef, useState } from 'react';
import { useSession, useSetupStatus } from '../data';
import { pushToast } from '../shell';
import { EmptyLine } from '../ui/list';
import { DEMO_NOTICE, ZERO_ACCOUNTS, defaultDemoPorts, loadDemo, zeroAccountsMode, type DemoPorts } from './demo';
import { defaultWelcomePorts, openOnboardingWindow, welcomeFailureLine, type WelcomePorts } from './showWelcome';

export interface ZeroAccountsViewProps {
  /** A first sync is running: show its line instead. */
  readonly firstSyncRunning?: boolean;
  /** The status reason under the first-sync line (the status slot's words), if any. */
  readonly detail?: string;
  /** "Add an account" couldn't open the setup window: the line under the sentence says so. */
  readonly notice?: string;
  readonly onAddAccount: () => void;
  readonly onTryDemo: () => void;
}

export function ZeroAccountsView({
  firstSyncRunning = false,
  detail,
  notice,
  onAddAccount,
  onTryDemo,
}: ZeroAccountsViewProps) {
  if (zeroAccountsMode({ accountCount: 0, firstSyncRunning }) === 'firstSync') {
    return <EmptyLine text={ZERO_ACCOUNTS.firstSync} {...(detail ? { detail } : {})} />;
  }
  return (
    <EmptyLine
      text={ZERO_ACCOUNTS.text}
      {...(notice ? { detail: notice } : {})}
      action={{ label: ZERO_ACCOUNTS.add, icon: 'plus', emphasis: 'filled', onSelect: onAddAccount }}
      secondaryAction={{ label: ZERO_ACCOUNTS.tryDemo, onSelect: onTryDemo }}
    />
  );
}

export interface ZeroAccountsProps {
  /** Overrides the check of `useSetupStatus` (a first sync is running while `!done`). */
  readonly firstSyncRunning?: boolean;
  readonly detail?: string;
  readonly ports?: Partial<WelcomePorts & DemoPorts>;
}

/** Draws nothing when accounts exist (the pane has mail, or demo mail, to show). */
export function ZeroAccounts({ firstSyncRunning, detail, ports: given }: ZeroAccountsProps) {
  const session = useSession();
  const setup = useSetupStatus();
  const ports = useRef({ ...defaultWelcomePorts, ...defaultDemoPorts, ...given }).current;
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<string | undefined>(undefined);

  const running = firstSyncRunning ?? (setup !== undefined && setup.accounts.length > 0 && !setup.done);
  const mode = zeroAccountsMode({ accountCount: session?.hasAccounts === false ? 0 : 1, firstSyncRunning: running });
  if (mode === 'none') return null;

  const tryDemo = () => {
    if (loading) return;
    setLoading(true);
    void loadDemo(ports).then(result => {
      setLoading(false);
      const message = result === 'loaded' ? DEMO_NOTICE.loaded : DEMO_NOTICE.failed;
      try {
        pushToast({ id: 'demo-load', kind: 'info', message, undoable: false });
      } catch {
        // The shell's toast stack may not be there yet.
      }
    });
  };

  return (
    <ZeroAccountsView
      firstSyncRunning={mode === 'firstSync'}
      {...(detail ? { detail } : {})}
      {...(notice ? { notice } : {})}
      onAddAccount={() => {
        setNotice(undefined);
        void openOnboardingWindow('first', ports).then(result => setNotice(welcomeFailureLine(result)));
      }}
      onTryDemo={tryDemo}
    />
  );
}
