/**
 * The app shell (DESIGN 7.1): the gray window, the sidebar on it and one white pane. The pane's content is the screen
 * slot; `renderScreen` supplies a screen's content and any screen it declines gets a plain placeholder line. The shell
 * also mounts the singletons: the one ToastStack, the sheet host, the key-hint providers and, when the engine cannot be
 * reached, the FatalScreen in place of everything.
 */
import { useEffect, useState, type ReactNode } from 'react';
import {
  api,
  useAccounts,
  useAccountsLoaded,
  useConnection,
  useCounts,
  useSettings,
} from '../data';
import { FatalScreen } from '../ui/status';
import { Pane } from '../ui/surfaces';
import type { PaneHeaderProps } from '../ui/props';
import { AccountMenu } from './AccountMenu';
import { KeysProviders } from './KeysProviders';
import { MinimisedNav } from './MinimisedNav';
import { SheetHost } from './SheetHost';
import { Sidebar } from './Sidebar';
import { StatusHost } from './StatusHost';
import { ToastHost } from './ToastHost';
import { placeCounts, screenLabel, type PlaceId } from './nav';
import { DIAGNOSTICS_FAILED_COPY, RESTART_FAILED_COPY } from './failure-copy';
import { PlaceholderScreen } from './states';
import { accountReconnectMode } from './status-map';
import {
  closeSheet,
  navigate,
  openSheet,
  pushToast,
  setAccountScope,
  useAccountScope,
  useAppRoute,
  useSheetContextActive,
  type Screen,
} from './index';

/** Props for `Shell`. */
export interface ShellProps {
  /** A screen's content, or undefined for the placeholder line. */
  readonly renderScreen?: (screen: Screen) => ReactNode | undefined;
}

/** Which dock tab the pane header's Ask and Today buttons show as pressed. No dock is mounted yet; ui-ask owns it. */
type DockTab = 'closed' | 'ask' | 'today';

function paneHeader(dock: DockTab, setDock: (tab: DockTab) => void): PaneHeaderProps {
  return {
    ask: {
      pressed: dock === 'ask',
      scope: 'mail',
      onPress: () => setDock(dock === 'ask' ? 'closed' : 'ask'),
    },
    today: {
      pressed: dock === 'today',
      onPress: () => setDock(dock === 'today' ? 'closed' : 'today'),
    },
  };
}

function notify(id: string, message: string): void {
  pushToast({ id, kind: 'info', message, undoable: false });
}

/** The fatal screen in place of everything (DESIGN 7.15), with Restart and Copy diagnostics wired to the engine. A failure of either says so in a toast: the screen has no slot for it. */
export function FatalHost({ kind }: { readonly kind: 'unreachable' | 'parked' }) {
  const [restarting, setRestarting] = useState(false);
  const restart = () => {
    setRestarting(true);
    Promise.resolve()
      .then(() => api.engine.restart())
      .catch(() => notify('fatal-restart-failed', RESTART_FAILED_COPY))
      .finally(() => setRestarting(false));
  };
  const diagnostics = () => {
    const done = kind === 'parked' ? 'Diagnostics exported' : 'Diagnostics copied';
    Promise.resolve()
      .then(() => api.diagnostics.copy())
      .then(() => notify('fatal-diagnostics', done))
      .catch(() => notify('fatal-diagnostics', DIAGNOSTICS_FAILED_COPY));
  };
  return (
    <div className="aplos-shell">
      <Pane kind="main" label="Aplos">
        <FatalScreen
          kind={kind}
          restarting={restarting}
          onRestart={restart}
          onDiagnostics={diagnostics}
        />
        <ToastHost />
      </Pane>
    </div>
  );
}

/** Props for `ShellLayout`. */
export interface ShellLayoutProps {
  readonly screen: Screen;
  readonly counts: Readonly<Partial<Record<PlaceId, number>>>;
  readonly minimised: boolean;
  readonly onNavigate: (screen: Screen) => void;
  readonly onCompose: () => void;
  readonly accountSwitcher: ReactNode;
  readonly status: ReactNode;
  readonly header: PaneHeaderProps;
  /** The toast stack, mounted inside the pane. */
  readonly toasts: ReactNode;
  /** Singletons beside the pane: the sheet host. */
  readonly overlay?: ReactNode;
  /** The screen slot's content. */
  readonly children: ReactNode;
}

/** The shell's frame drawn from plain props: kept apart from the data hooks so the harness can draw any state. */
export function ShellLayout(props: ShellLayoutProps) {
  const { screen, counts, minimised, onNavigate, children } = props;
  return (
    <div className="aplos-shell" data-minimised={minimised ? 'true' : undefined}>
      {minimised ? (
        <MinimisedNav screen={screen} counts={counts} onNavigate={onNavigate} />
      ) : (
        <Sidebar
          screen={screen}
          counts={counts}
          onNavigate={onNavigate}
          onCompose={props.onCompose}
          accountSwitcher={props.accountSwitcher}
          status={props.status}
        />
      )}
      <Pane kind="main" label={screenLabel(screen)} header={props.header}>
        <div className="aplos-screen">{children}</div>
        {props.toasts}
      </Pane>
      {props.overlay}
    </div>
  );
}

/** True once accounts have loaded and the scoped account is not among them (an empty list included). */
export function scopeIsStale(
  scope: string | null,
  accounts: readonly { readonly id: string }[],
  loaded: boolean,
): boolean {
  return loaded && scope !== null && !accounts.some(a => a.id === scope);
}

function ShellFrame({ renderScreen }: ShellProps) {
  const screen = useAppRoute();
  const accounts = useAccounts();
  const accountsLoaded = useAccountsLoaded();
  const scope = useAccountScope();
  useEffect(() => {
    // A removed account cannot stay the scope: fall back to All accounts (also when none are left).
    if (scopeIsStale(scope, accounts, accountsLoaded)) setAccountScope(null);
  }, [scope, accounts, accountsLoaded]);
  const counts = useCounts(scope ?? undefined);
  const minimised = useSettings()?.ui.sidebarMinimised === true;
  const [dock, setDock] = useState<DockTab>('closed');
  const sheetOpen = useSheetContextActive();
  const account = (
    <AccountMenu
      accounts={accounts}
      scope={scope ?? undefined}
      onScope={id => setAccountScope(id ?? null)}
      onReconnect={a => openSheet('reconnect', { accountId: a.id, mode: accountReconnectMode(a) })}
      onAddAccount={() => navigate('settings')}
    />
  );
  return (
    <KeysProviders screen={screen} sheetOpen={sheetOpen}>
      <ShellLayout
        screen={screen}
        counts={placeCounts(counts.counts, counts.hidden)}
        minimised={minimised}
        onNavigate={navigate}
        onCompose={() => navigate({ label: 'New message' })}
        accountSwitcher={account}
        status={<StatusHost />}
        header={paneHeader(dock, setDock)}
        toasts={<ToastHost />}
        overlay={<SheetHost />}
      >
        {renderScreen?.(screen) ?? <PlaceholderScreen screen={screen} />}
      </ShellLayout>
    </KeysProviders>
  );
}

/** The shell: fatal when the engine is gone or parked, otherwise the sidebar, the pane and the singletons. */
export function Shell(props: ShellProps) {
  const connection = useConnection();
  const fatal = connection.state === 'unreachable' || connection.state === 'parked';
  // A sheet left open behind the fatal screen would restart its sign-in flow, unasked, when the engine returns.
  useEffect(() => {
    if (fatal) closeSheet();
  }, [fatal]);
  if (connection.state === 'unreachable' || connection.state === 'parked')
    return <FatalHost kind={connection.state} />;
  return <ShellFrame {...props} />;
}
