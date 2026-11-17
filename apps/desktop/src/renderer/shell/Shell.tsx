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
  type SetStateAction,
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
import { Button } from '../ui/buttons-keys';
import { Pane } from '../ui/surfaces';
import type { CommandId } from '../commands';
import type { PaneHeaderProps } from '../ui/props';
import { AccountMenu } from './AccountMenu';
import { listenFullscreen, macChrome, toggleCollapsed, useChrome } from './chrome';
import { focusRegion, type RegionRoot } from './regions';
import { KeysProviders, useRunCommand } from './KeysProviders';
import { MinimisedNav } from './MinimisedNav';
import { SheetHost } from './SheetHost';
import { ShortcutsHost } from './ShortcutsHost';
import { Sidebar } from './Sidebar';
import { StatusHost } from './StatusHost';
import { ToastHost } from './ToastHost';
import { mergePaneHeaderPart } from './store-pane';
import { placeCounts, screenLabel, type PlaceId } from './nav';
import { DIAGNOSTICS_FAILED_COPY, RESTART_FAILED_COPY } from './failure-copy';
import { PlaceholderScreen } from './states';
import { accountReconnectMode } from './status-map';
import { setThemeChoice } from './theme';
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

/** The commands the shell answers itself: the dock, palette and sidebar toggles. A mounted host's own registration shadows these. */
export function shellCommands(actions: {
  readonly openTab: (tab: 'ask' | 'today') => void;
  readonly toggleDock: () => void;
  readonly togglePalette: () => void;
  readonly toggleSidebar: () => void;
}): CommandHandlerTable {
  return {
    'app.palette': { run: () => actions.togglePalette() },
    'app.sidebar': { run: () => actions.toggleSidebar() },
    'ask.open': { run: () => actions.openTab('ask') },
    'nav.today': { run: () => actions.openTab('today') },
    'ask.toggleDock': { run: () => actions.toggleDock() },
    'ask.dictate': {
      // Hold A with the dock closed: open it and leave a pending dictation the host starts on mount
      // (its own `ask.dictate` shadows this once attached).
      run: () => {
        actions.openTab('ask');
        askStore.update(s => ({ ...s, pendingDictation: true }));
      },
      // The hold ended before the host mounted and consumed the flag: nothing may start listening now.
      release: () =>
        askStore.update(s => (s.pendingDictation ? { ...s, pendingDictation: undefined } : s)),
    },
  };
}

/**
 * True when the closing dock may hand focus to its tab's header button: the dock pane held the active element (its
 * unmount leaves body focused) or nothing did. Focus anywhere else — a list row, a field — keeps its place.
 */
export function dockFocusOrphaned(): boolean {
  if (typeof document === 'undefined') return false;
  const active = document.activeElement;
  if (!active || active === document.body) return true;
  return active.closest('.ui-pane[data-kind="dock"]') !== null;
}

/**
 * Focus follow-up for the collapse toggle: collapsing while the sidebar held focus leaves the page
 * shell focused once the aside unmounts, so the strip's toggle takes it; expanding back leaves the
 * page shell focused the same way, and the sidebar's remembered (or roving) row takes it. Focus
 * anywhere else — a list row, a field — keeps its place.
 */
export function sidebarCollapseFocus(collapsed: boolean): void {
  if (typeof document === 'undefined') return;
  const active = document.activeElement as HTMLElement | null;
  if (active && active !== document.body && active !== document.documentElement) return;
  if (collapsed) {
    document
      .querySelector<HTMLElement>('.aplos-shell__strip button')
      ?.focus({ preventScroll: true });
    return;
  }
  focusRegion(document as unknown as RegionRoot, 'sidebar');
}

/** Attaches the shell's own command table; sits inside KeysProviders so the shared registry exists. */
function ShellCommands(props: Parameters<typeof shellCommands>[0]) {
  const { openTab, toggleDock, togglePalette, toggleSidebar } = props;
  const handlers = useMemo(
    () => shellCommands({ openTab, toggleDock, togglePalette, toggleSidebar }),
    [openTab, toggleDock, togglePalette, toggleSidebar],
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
    // The button's whole text picks up an inline keycap or the held-⌘ badge; the label element's is stable.
    const name = (
      button.querySelector('.ui-part-button__label, .ui-button-label')?.textContent ??
      button.getAttribute('aria-label')
    )?.trim();
    if (name === label) {
      button.focus();
      return;
    }
  }
}

/** How often a command asked for the dock (the palette's Ask row, `askStore.open`); 0 at start-up. */
const dockOpenTick = () => askStore.get().openTick;

/** The tab a new open request asks for, or undefined when `tick` is the value the frame mounted with. */
export function dockRequest(mountTick: number, tick: number): 'ask' | 'today' | undefined {
  return tick !== mountTick ? askStore.get().tab : undefined;
}

/** The dock the saved settings reopen to: the remembered tab, or closed on a first run (open false, DESIGN 7.7). */
export function dockSeed(saved: {
  readonly open: boolean;
  readonly tab: 'ask' | 'today';
}): DockTab {
  return saved.open ? saved.tab : 'closed';
}

/** The `settings.ui.dock` {open, tab} a dock state writes back: the open flag and the tab to reopen — the last shown, when closed. */
export function dockPersistPatch(
  dock: DockTab,
  lastTab: 'ask' | 'today',
): { readonly open: boolean; readonly tab: 'ask' | 'today' } {
  return { open: dock !== 'closed', tab: dock === 'closed' ? lastTab : dock };
}

/** The dock pane's landmark name for the tab it shows. */
export function dockLabel(dock: DockTab): string {
  return dock === 'today' ? 'Today' : 'Ask';
}

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
  /** Window chrome: fullscreen collapses the sidebar's top to one row; collapsed removes the sidebar for a top strip. */
  readonly chrome: { readonly fullscreen: boolean; readonly collapsed: boolean };
  /** macOS reserves the traffic-light strip while windowed. */
  readonly mac: boolean;
  readonly onNavigate: (screen: Screen) => void;
  readonly onCompose: () => void;
  /** The sidebar toggle was pressed (`app.sidebar`). */
  readonly onToggleSidebar: () => void;
  readonly accountSwitcher: ReactNode;
  readonly status: ReactNode;
  readonly header: PaneHeaderProps;
  /** The toast stack, mounted inside the pane. */
  readonly toasts: ReactNode;
  /** The dock's content (DESIGN 7.7); mounted as the second pane beside the main one. */
  readonly dock?: ReactNode;
  /** The dock pane's landmark name: the open tab's ('Ask' or 'Today'). */
  readonly dockLabel?: string;
  /** Singletons beside the pane: the sheet and palette hosts. */
  readonly overlay?: ReactNode;
  /** The screen slot's content. */
  readonly children: ReactNode;
}

/**
 * The grey notch the main pane wraps around the macOS window buttons and the toggle when the sidebar is collapsed and
 * the window is not fullscreen (CSS shows it only then). One path in the shell colour over the pane's top-left corner:
 * a concave step on the right, a rounded white corner under it on the left. The numbers are the pane's inset
 * (--shell-pad, 8) and the 44 px notch depth; the white edge gets the pane's hairline.
 */
export function ChromeNotch() {
  return (
    <svg
      className="aplos-shell__notch"
      width={NOTCH_W}
      height={NOTCH_H}
      viewBox={`0 0 ${NOTCH_W} ${NOTCH_H}`}
      aria-hidden="true"
      focusable="false"
    >
      <path className="aplos-shell__notch-fill" d={NOTCH_FILL} />
      <path className="aplos-shell__notch-edge" d={NOTCH_EDGE} />
    </svg>
  );
}

/**
 * The notch's size in px: it spans the lights, the toggle, New message and the corner curves. NOTCH_W matches CSS --notch-w; NOTCH_H is
 * --shell-pad + --pane-head (the notch's bottom meets the header's hairline). The path's 10 and 12 are the step and
 * pane corner radii (12 = --radius-lg).
 */
export const NOTCH_W = 157;
export const NOTCH_H = 56;
const NOTCH_EDGE = 'M157 8A10 10 0 0 0 147 18V32A12 12 0 0 1 135 44H20A12 12 0 0 0 8 56';
const NOTCH_FILL = `M0 0H157V8${NOTCH_EDGE.slice('M157 8'.length)}H0Z`;

/** The shell's frame drawn from plain props: kept apart from the data hooks so the harness can draw any state. */
export function ShellLayout(props: ShellLayoutProps) {
  const { screen, counts, minimised, onNavigate, children, chrome } = props;
  // A collapsed sidebar leaves a thin strip with just the toggle; minimised ignores the flag (its ☰ owns the menu).
  const collapsed = chrome.collapsed && !minimised;
  return (
    <div
      className="aplos-shell"
      data-minimised={minimised ? 'true' : undefined}
      data-collapsed={collapsed ? 'true' : undefined}
      data-fullscreen={chrome.fullscreen ? 'true' : undefined}
      data-mac={props.mac ? 'true' : undefined}
    >
      {collapsed ? (
        <div className="aplos-shell__strip" data-region="sidebar">
          <ChromeNotch />
          <div className="aplos-shell__strip-tools">
            <Button
              variant="icon"
              size="sm"
              icon="sidebar"
              label="Show or hide the sidebar"
              commandId="app.sidebar"
              onPress={props.onToggleSidebar}
            />
            <Button
              variant="icon"
              size="sm"
              icon="compose"
              label="New message"
              commandId="mail.compose"
              onPress={props.onCompose}
            />
          </div>
        </div>
      ) : minimised ? (
        <MinimisedNav screen={screen} counts={counts} onNavigate={onNavigate} />
      ) : (
        <Sidebar
          screen={screen}
          counts={counts}
          onNavigate={onNavigate}
          onCompose={props.onCompose}
          onToggleSidebar={props.onToggleSidebar}
          accountSwitcher={props.accountSwitcher}
          status={props.status}
        />
      )}
      <div className="aplos-shell__row">
        <Pane kind="main" label={screenLabel(screen)} header={props.header}>
          <div className="aplos-screen">{children}</div>
          {props.toasts}
        </Pane>
        {props.dock ? (
          <Pane kind="dock" label={props.dockLabel ?? 'Ask'}>
            {props.dock}
          </Pane>
        ) : null}
      </div>
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
  return <ShellLayout {...layout} header={header} dock={dockPane} dockLabel={dockLabel(dock)} />;
}

function ShellFrame({ renderScreen, renderDock }: ShellProps) {
  const screen = useAppRoute();
  const chrome = useChrome();
  const mac = useMemo(macChrome, []);
  useEffect(() => listenFullscreen(window.aplos), []);
  const accounts = useAccounts();
  const accountsLoaded = useAccountsLoaded();
  const scope = useAccountScope();
  useEffect(() => {
    // A removed account cannot stay the scope: fall back to All accounts (also when none are left).
    if (scopeIsStale(scope, accounts, accountsLoaded)) setAccountScope(null);
  }, [scope, accounts, accountsLoaded]);
  const counts = useCounts(scope ?? undefined);
  const settings = useSettings();
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const minimised = settings?.ui.sidebarMinimised === true;
  const theme = settings?.ui.theme;
  // The saved Theme setting drives `data-theme` (the entry already follows the system until it is known).
  useEffect(() => {
    if (theme) setThemeChoice(theme);
  }, [theme]);
  // The sidebar↔strip swap drops the focused element's home: hand focus to the surviving landmark.
  const sidebarCollapsed = chrome.collapsed && !minimised;
  const lastCollapsed = useRef(sidebarCollapsed);
  useEffect(() => {
    const was = lastCollapsed.current;
    lastCollapsed.current = sidebarCollapsed;
    if (was !== sidebarCollapsed) sidebarCollapseFocus(sidebarCollapsed);
  }, [sidebarCollapsed]);
  const [dock, setDockState] = useState<DockTab>('closed');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const sheetOpen = useSheetContextActive();
  // The dock reopens as it was left (settings.ui.dock, DESIGN 7.7): closed until the saved value lands so a
  // remembered-open dock never flashes, and a dock the owner already moved keeps their choice.
  const dockRestored = useRef(false);
  const dockTouched = useRef(false);
  const lastDockTab = useRef<'ask' | 'today'>('ask');
  const setDock = useCallback((next: SetStateAction<DockTab>) => {
    dockTouched.current = true;
    setDockState(next);
  }, []);
  // {open, tab} are remembered on every change — the host owns width — but never before the saved value seeded,
  // so a first run can't write 'closed' over a remembered 'open'.
  useEffect(() => {
    if (dock !== 'closed') lastDockTab.current = dock;
    const current = settingsRef.current;
    if (!dockRestored.current || !current) return;
    const next = dockPersistPatch(dock, lastDockTab.current);
    if (current.ui.dock.open === next.open && current.ui.dock.tab === next.tab) return;
    void api.settings
      .set({ patch: { ui: { dock: { ...current.ui.dock, ...next } } } })
      .catch(() => undefined);
  }, [dock]);
  useEffect(() => {
    if (dockRestored.current || !settings) return;
    dockRestored.current = true;
    if (dockTouched.current) {
      // The owner acted before settings landed: write their choice back, not the saved value.
      const next = dockPersistPatch(dock, lastDockTab.current);
      if (settings.ui.dock.open !== next.open || settings.ui.dock.tab !== next.tab)
        void api.settings
          .set({ patch: { ui: { dock: { ...settings.ui.dock, ...next } } } })
          .catch(() => undefined);
      return;
    }
    lastDockTab.current = settings.ui.dock.tab;
    const seeded = dockSeed(settings.ui.dock);
    if (seeded !== 'closed') setDockState(seeded);
  }, [settings, dock]);
  // The dock also opens on request (the palette's Ask row): `openTick` bumps once per ask (REQUESTS.md).
  const dockTick = useSyncExternalStore(askStore.subscribe, dockOpenTick, dockOpenTick);
  // Only a request after this mount opens the dock: openTick survives an engine outage in module state, so
  // a remounted frame would otherwise pop the dock open unasked on the store's last tab.
  const mountTick = useRef(dockTick);
  useEffect(() => {
    const tab = dockRequest(mountTick.current, dockTick);
    if (tab) setDock(tab);
  }, [dockTick, setDock]);
  // Search's `>` asks for the palette with a seeded query (screens/palette REQUESTS.md).
  useEffect(() => onPaletteOpenRequest(() => setPaletteOpen(true)), []);
  // Closing the dock returns focus to its tab's header button — only when the dock held it or nothing did.
  const lastDock = useRef(dock);
  useEffect(() => {
    const was = lastDock.current;
    lastDock.current = dock;
    if (was !== 'closed' && dock === 'closed' && dockFocusOrphaned()) focusDockButton(was);
  }, [dock]);
  const openTab = useCallback((tab: 'ask' | 'today') => setDock(tab), [setDock]);
  const toggleDock = useCallback(
    () => setDock(d => (d === 'closed' ? 'ask' : 'closed')),
    [setDock],
  );
  const closeDock = useCallback(() => setDock('closed'), [setDock]);
  const togglePalette = useCallback(() => setPaletteOpen(open => !open), []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);
  // The minimised rail owns the menu: the sidebar toggle is a no-op while the setting is on.
  const toggleSidebar = useCallback(() => {
    if (settingsRef.current?.ui.sidebarMinimised === true) return;
    toggleCollapsed();
  }, []);
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
      <ShellCommands
        openTab={openTab}
        toggleDock={toggleDock}
        togglePalette={togglePalette}
        toggleSidebar={toggleSidebar}
      />
      <FramedLayout
        dock={dock}
        setDock={setDock}
        dockPane={dockPane}
        screen={screen}
        counts={placeCounts(counts.counts, counts.hidden)}
        minimised={minimised}
        chrome={chrome}
        mac={mac}
        onNavigate={navigate}
        onToggleSidebar={toggleSidebar}
        onCompose={() => openCompose({})}
        accountSwitcher={account}
        status={<StatusHost />}
        toasts={<ToastHost />}
        overlay={
          <>
            <SheetHost />
            <ShortcutsHost />
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
