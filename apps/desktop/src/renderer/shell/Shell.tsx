/**
 * The app shell (DESIGN 7.1): the gray window, the sidebar on it and one white pane. The pane's content is the screen
 * slot; `renderScreen` supplies a screen's content and any screen it declines gets a plain placeholder line. The shell
 * also mounts the singletons: the one ToastStack, the sheet host, the key-hint providers and, when the engine cannot be
 * reached, the FatalScreen in place of everything.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import {
  api,
  useAccounts,
  useAccountsLoaded,
  useConnection,
  useCounts,
  useSettings,
} from '../data';
// ui-ask's index also pulls the hosts' stylesheets, which node's test runner cannot load; the store module is
// css-free and is the same object the index re-exports.
import { askStore } from '../screens/ask/askStore';
import { onPaletteOpenRequest, PaletteHost } from '../screens/palette';
import { FatalScreen } from '../ui/status';
import { Pane } from '../ui/surfaces';
import type { CommandId } from '../commands';
import type { PaneHeaderProps } from '../ui/props';
import { AccountMenu } from './AccountMenu';
import { KeysProviders, useRunCommand } from './KeysProviders';
import { MinimisedNav } from './MinimisedNav';
import { SheetHost } from './SheetHost';
import { Sidebar } from './Sidebar';
import { StatusHost } from './StatusHost';
import { ToastHost } from './ToastHost';
import { mergePaneHeaderPart } from './store-pane';
import { placeCounts, screenLabel, type PlaceId } from './nav';
import { DIAGNOSTICS_FAILED_COPY, RESTART_FAILED_COPY } from './failure-copy';
import { PlaceholderScreen } from './states';
import { accountReconnectMode } from './status-map';
import {
  closeSheet,
  navigate,
  openCompose,
  openAddAccount,
  openSheet,
  pushToast,
  setAccountScope,
  useAccountScope,
  useAppRoute,
  usePaneHeaderParts,
  useRegisterCommands,
  useSheetContextActive,
  type CommandHandlerTable,
  type PaneHeaderPart,
  type Screen,
} from './index';

/** Props for `Shell`. */
export interface ShellProps {
  /** A screen's content, or undefined for the placeholder line. */
  readonly renderScreen?: (screen: Screen) => ReactNode | undefined;
  /** The dock's content for the open tab (ui-ask's `AskDockHost`; DESIGN 7.7); the shell wraps it in the second pane. */
  readonly renderDock?: (
    tab: 'ask' | 'today',
    onTab: (tab: 'ask' | 'today') => void,
    close: () => void,
  ) => ReactNode;
}

/** Which dock tab the pane header's Ask and Today buttons show as pressed; `closed` mounts no dock pane. */
export type DockTab = 'closed' | 'ask' | 'today';

/** The commands the shell answers itself: the dock and palette toggles. A mounted host's own registration shadows these. */
export function shellCommands(actions: {
  readonly openTab: (tab: 'ask' | 'today') => void;
  readonly toggleDock: () => void;
  readonly togglePalette: () => void;
}): CommandHandlerTable {
  return {
    'app.palette': { run: () => actions.togglePalette() },
    'ask.open': { run: () => actions.openTab('ask') },
    'nav.today': { run: () => actions.openTab('today') },
    'ask.toggleDock': { run: () => actions.toggleDock() },
  };
}

/** Attaches the shell's own command table; sits inside KeysProviders so the shared registry exists. */
function ShellCommands(props: Parameters<typeof shellCommands>[0]) {
  const { openTab, toggleDock, togglePalette } = props;
  const handlers = useMemo(
    () => shellCommands({ openTab, toggleDock, togglePalette }),
    [openTab, toggleDock, togglePalette],
  );
  useRegisterCommands(handlers);
  return null;
}

/** Focus the pane header's Ask or Today button after the dock they owned closes; a no-op where there is no DOM. */
export function focusDockButton(tab: 'ask' | 'today'): void {
  if (typeof document === 'undefined') return;
  const label = tab === 'ask' ? 'Ask' : 'Today';
  const tools = document.querySelectorAll<HTMLElement>(
    '.ui-pane[data-kind="main"] .ui-pane__tools button',
  );
  for (const button of tools) {
    if ((button.getAttribute('aria-label') ?? button.textContent)?.trim() === label) {
      button.focus();
      return;
    }
  }
}

/** How often a command asked for the dock (the palette's Ask row, `askStore.open`); 0 at start-up. */
const dockOpenTick = () => askStore.get().openTick;

export function paneHeader(
  dock: DockTab,
  setDock: (tab: DockTab) => void,
  part: PaneHeaderPart,
  run: (commandId: CommandId) => void,
): PaneHeaderProps {
  return mergePaneHeaderPart(
    {
      ask: {
        pressed: dock === 'ask',
        scope: 'mail',
        onPress: () => setDock(dock === 'ask' ? 'closed' : 'ask'),
      },
      today: {
        pressed: dock === 'today',
        onPress: () => setDock(dock === 'today' ? 'closed' : 'today'),
      },
    },
    part,
    run,
  );
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
  /** The dock's content (DESIGN 7.7); mounted as the second pane beside the main one. */
  readonly dock?: ReactNode;
  /** Singletons beside the pane: the sheet and palette hosts. */
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
      {props.dock ? (
        <Pane kind="dock" label="Ask">
          {props.dock}
        </Pane>
      ) : null}
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

type FramedProps = Omit<ShellLayoutProps, 'header' | 'dock'> & {
  readonly dock: DockTab;
  readonly setDock: (tab: DockTab) => void;
  /** The dock pane's content for the open tab. */
  readonly dockPane?: ReactNode;
};

/** The layout with the pane header the mounted screen's part asks for (`usePaneHeaderPart`) plus Ask and Today; sits inside the key providers so a tool press can run a command. */
function FramedLayout({ dock, setDock, dockPane, ...layout }: FramedProps) {
  const part = usePaneHeaderParts();
  const run = useRunCommand();
  const header = useMemo(() => paneHeader(dock, setDock, part, run), [dock, setDock, part, run]);
  return <ShellLayout {...layout} header={header} dock={dockPane} />;
}

function ShellFrame({ renderScreen, renderDock }: ShellProps) {
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
  const [paletteOpen, setPaletteOpen] = useState(false);
  const sheetOpen = useSheetContextActive();
  // The dock also opens on request (the palette's Ask row): `openTick` bumps once per ask (REQUESTS.md).
  const dockTick = useSyncExternalStore(askStore.subscribe, dockOpenTick, dockOpenTick);
  useEffect(() => {
    if (dockTick > 0) setDock(askStore.get().tab);
  }, [dockTick]);
  // Search's `>` asks for the palette with a seeded query (screens/palette REQUESTS.md).
  useEffect(() => onPaletteOpenRequest(() => setPaletteOpen(true)), []);
  // Closing the dock returns focus to the header button of the tab it showed.
  const lastDock = useRef(dock);
  useEffect(() => {
    const was = lastDock.current;
    lastDock.current = dock;
    if (was !== 'closed' && dock === 'closed') focusDockButton(was);
  }, [dock]);
  const openTab = useCallback((tab: 'ask' | 'today') => setDock(tab), []);
  const toggleDock = useCallback(() => setDock(d => (d === 'closed' ? 'ask' : 'closed')), []);
  const closeDock = useCallback(() => setDock('closed'), []);
  const togglePalette = useCallback(() => setPaletteOpen(open => !open), []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);
  const dockPane =
    renderDock && dock !== 'closed' ? renderDock(dock, openTab, closeDock) : undefined;
  const account = (
    <AccountMenu
      accounts={accounts}
      scope={scope ?? undefined}
      onScope={id => setAccountScope(id ?? null)}
      onReconnect={a => openSheet('reconnect', { accountId: a.id, mode: accountReconnectMode(a) })}
      onAddAccount={openAddAccount}
    />
  );
  return (
    <KeysProviders screen={screen} sheetOpen={sheetOpen}>
      <ShellCommands openTab={openTab} toggleDock={toggleDock} togglePalette={togglePalette} />
      <FramedLayout
        dock={dock}
        setDock={setDock}
        dockPane={dockPane}
        screen={screen}
        counts={placeCounts(counts.counts, counts.hidden)}
        minimised={minimised}
        onNavigate={navigate}
        onCompose={() => openCompose({})}
        accountSwitcher={account}
        status={<StatusHost />}
        toasts={<ToastHost />}
        overlay={
          <>
            <SheetHost />
            <PaletteHost open={paletteOpen} onClose={closePalette} />
          </>
        }
      >
        {renderScreen?.(screen) ?? <PlaceholderScreen screen={screen} />}
      </FramedLayout>
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
