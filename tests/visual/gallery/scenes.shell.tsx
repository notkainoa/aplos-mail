// ui-shell scenes: the shell's own frame (sidebar, status slot, pane header, toasts, sheets, fatal and empty
// screens) drawn from the shell's presentational pieces with fixed demo data. No engine and no data layer boot:
// the status rows go through the shell's own mapping (StatusView -> toSyncStatus -> StatusSlot).

import { useEffect, type ComponentProps, type ReactElement, type ReactNode } from 'react';
import { createClient } from '@aplos/contract/client';
import '../../../apps/desktop/src/renderer/shell/shell.css';
import '../../../apps/desktop/src/renderer/screens/screens.css';
import {
  HARNESS_NOW_MS,
  toIsoDateTime,
  type Account,
  type StatusSlotState,
} from '../../../apps/desktop/src/renderer/data';
import { ListBox, ListRow } from '../../../apps/desktop/src/renderer/ui/list';
import { EmptyLine } from '../../../apps/desktop/src/renderer/ui/list';
import { ReconnectSheet } from '../../../apps/desktop/src/renderer/ui/status';
import type {
  CalendarListProps,
  MiniMonthProps,
  PaneHeaderProps,
  ToastData,
} from '../../../apps/desktop/src/renderer/ui/props';
import { AddAccountView } from '../../../apps/desktop/src/renderer/shell/AddAccountHost';
import { AccountMenu } from '../../../apps/desktop/src/renderer/shell/AccountMenu';
import { FatalHost, ShellLayout } from '../../../apps/desktop/src/renderer/shell/Shell';
import { StatusView } from '../../../apps/desktop/src/renderer/shell/StatusHost';
import { ToastHostView } from '../../../apps/desktop/src/renderer/shell/ToastHost';
import { failureReason } from '../../../apps/desktop/src/renderer/shell/SheetHost';
import {
  FirstSyncLine,
  ListFailedLine,
  NoAccountsLine,
} from '../../../apps/desktop/src/renderer/shell/states';
import { placeCounts, type PlaceId } from '../../../apps/desktop/src/renderer/shell/nav';
import {
  DRAFTS_CONFIG,
  SENT_CONFIG,
} from '../../../apps/desktop/src/renderer/screens/lists/listKinds';
import {
  navigate,
  useSidebarSlot,
  type Screen,
  type SidebarSlot,
} from '../../../apps/desktop/src/renderer/shell';
import { App, type AppClient } from '../../../apps/desktop/src/renderer/App';
import { connectStandInDataLayer } from '../../../apps/desktop/src/renderer/data/standin-layer';
import { noop, row } from './scenes.shared';

/* ------------------------------ demo data ------------------------------ */

const at = (iso: string): number => Date.parse(iso);

function account(over: {
  id: string;
  address: string;
  colorTag: string;
  status?: Account['health']['status'];
  health?: Partial<Account['health']>;
  pendingChanges?: number;
}): Account {
  return {
    id: over.id,
    address: over.address,
    name: over.address,
    colorTag: over.colorTag,
    demo: false,
    pendingChanges: over.pendingChanges ?? 0,
    health: {
      status: over.status ?? { state: 'ok' },
      lastSyncAt: at('2026-10-29T09:58:00-07:00'),
      ...over.health,
    },
  } as unknown as Account;
}

const SKY = account({ id: 'acc-1', address: 'alex.moreno@gmail.com', colorTag: 'sky' });
const HILL = account({ id: 'acc-2', address: 'alex@fernlane.studio', colorTag: 'hill' });
const ACCOUNTS: readonly Account[] = [SKY, HILL];

const COUNTS = { home: 9, laterDue: 3, drafts: 2 };

function counts(hidden = false): Readonly<Partial<Record<PlaceId, number>>> {
  return placeCounts(
    { home: COUNTS.home, laterDue: COUNTS.laterDue, drafts: COUNTS.drafts } as never,
    hidden,
  );
}

function slotState(over: {
  status: Account['health']['status'];
  reasonCode?: string | null;
  reconnectSoon?: boolean;
  pendingChanges?: number;
  health?: Partial<Account['health']>;
}): StatusSlotState {
  const acc = account({
    id: SKY.id,
    address: SKY.address,
    colorTag: 'sky',
    status: over.status,
    pendingChanges: over.pendingChanges,
    health: over.health,
  });
  return {
    account: acc,
    status: over.status,
    reasonCode: (over.reasonCode ?? null) as StatusSlotState['reasonCode'],
    reconnectSoon: over.reconnectSoon ?? false,
    demo: false,
  };
}

const OK_STATE = slotState({ status: { state: 'ok' } });

/* ------------------------------ the frame ------------------------------ */

const HEADER: PaneHeaderProps = {
  ask: { pressed: false, scope: 'mail', onPress: noop },
  today: { pressed: false, onPress: noop },
};

interface FrameProps {
  screen?: Screen;
  state?: StatusSlotState;
  hidden?: boolean;
  minimised?: boolean;
  header?: PaneHeaderProps;
  toasts?: readonly ToastData[];
  overlay?: ReactNode;
  children?: ReactNode;
}

/** The scenes draw the sidebar open, in a plain (non-macOS, non-fullscreen) window, so baselines stay as they were. */
const WINDOW_CHROME = { fullscreen: false, collapsed: false } as const;

function Frame({
  screen = 'home',
  state = OK_STATE,
  hidden = false,
  minimised = false,
  header = HEADER,
  toasts = [],
  overlay,
  children,
}: FrameProps): ReactElement {
  return (
    <ShellLayout
      screen={screen}
      counts={counts(hidden)}
      minimised={minimised}
      chrome={WINDOW_CHROME}
      mac={false}
      onNavigate={noop}
      onCompose={noop}
      onToggleSidebar={noop}
      accountSwitcher={
        <AccountMenu
          accounts={ACCOUNTS}
          scope={undefined}
          onScope={noop}
          onReconnect={noop}
          onAddAccount={noop}
        />
      }
      status={
        <StatusView
          state={state}
          accountCount={ACCOUNTS.length}
          now={toIsoDateTime(HARNESS_NOW_MS)}
          onAction={noop}
        />
      }
      header={header}
      toasts={<ToastHostView toasts={toasts} onAction={noop} onDismiss={noop} />}
      overlay={overlay}
    >
      {children ?? <HomeRows />}
    </ShellLayout>
  );
}

function HomeRows(): ReactElement {
  return (
    <div className="stage__column">
      <ListBox binding={{ id: 'home', label: 'Home' }}>
        <ListRow
          {...row({
            id: 's-1',
            sender: 'Jordan Park',
            primary: 'A quieter home for the Hollow Creek site',
            unread: true,
            date: '2026-10-29T08:12:00-07:00',
          })}
        />
        <ListRow
          {...row({
            id: 's-2',
            sender: 'Studio Kettle',
            primary: 'Print run for November',
            date: '2026-10-28T11:02:00-07:00',
          })}
        />
        <ListRow
          {...row({ id: 's-3', sender: 'Leah Okafor', primary: 'Lunch for six tomorrow' })}
        />
      </ListBox>
    </div>
  );
}

/** Opens the menu behind a trigger the way a click would, once the shell has painted. */
function useOpenAfterPaint(selector: string): void {
  useEffect(() => {
    const frame = requestAnimationFrame(() =>
      document.querySelector<HTMLElement>(selector)?.click(),
    );
    return () => cancelAnimationFrame(frame);
  }, [selector]);
}

/* ------------------------------ sidebar, switcher, header ------------------------------ */

function SidebarGroups(): ReactElement {
  return <Frame />;
}

function SidebarFirstSync(): ReactElement {
  const state = slotState({ status: { state: 'syncing' } });
  return (
    <Frame hidden state={state}>
      <FirstSyncLine />
    </Frame>
  );
}

function AccountSwitcherOpen(): ReactElement {
  useOpenAfterPaint('.ui-account-switcher');
  return <Frame />;
}

const DETAIL_HEADER: PaneHeaderProps = {
  lead: { kind: 'back', label: 'Back', commandId: 'nav.back', onPress: noop },
  crumb: { label: 'Home', position: { index: 1, of: 9 } },
  tools: [
    {
      commandId: 'reader.previousThread',
      icon: 'chevron-up',
      label: 'Previous email',
    },
    { commandId: 'reader.nextThread', icon: 'chevron-down', label: 'Next email' },
    {
      commandId: 'list.more',
      icon: 'more',
      label: 'More',
      detail: 'bookmark, trash, forward, why it’s here',
    },
  ],
  onTool: noop,
  ask: { pressed: false, scope: 'mail', onPress: noop },
  today: { pressed: false, onPress: noop },
};

function PaneHeaderScene(): ReactElement {
  return <Frame header={DETAIL_HEADER} />;
}

function MinimisedNavScene(): ReactElement {
  useOpenAfterPaint('.aplos-rail button');
  return <Frame minimised />;
}

/* ------------------------------ status rows (plan 30 U5 table) ------------------------------ */

const THROTTLE = slotState({
  status: {
    state: 'paused',
    until: at('2026-10-29T14:14:00-07:00'),
    class: 'rateLimited',
    reason: 'rateLimitExceeded',
  },
  reasonCode: 'rate.minute',
});

function statusScene(state: StatusSlotState): () => ReactElement {
  return function StatusRowScene(): ReactElement {
    return <Frame state={state} />;
  };
}

const STATUS_SCENES: Record<string, () => ReactElement> = {
  'shell-status-ok-synced': statusScene(OK_STATE),
  'shell-status-starting': statusScene(slotState({ status: { state: 'starting' } })),
  'shell-status-syncing': statusScene(slotState({ status: { state: 'syncing' } })),
  'shell-status-backfilling': statusScene(
    slotState({ status: { state: 'backfilling', done: 214, of: 500 } }),
  ),
  'shell-status-reconnect-soon': statusScene({
    ...OK_STATE,
    reconnectSoon: true,
    account: account({
      id: SKY.id,
      address: SKY.address,
      colorTag: 'sky',
      health: { reconnectBy: at('2026-10-30T09:00:00-07:00') },
    }),
  }),
  'shell-status-paused-throttle': statusScene(THROTTLE),
  'shell-status-paused-daily': statusScene(
    slotState({
      status: {
        state: 'paused',
        until: at('2026-10-30T00:00:00-07:00'),
        class: 'quota',
        reason: 'dailyLimitExceeded',
      },
      reasonCode: 'quota.daily',
    }),
  ),
  'shell-status-needs-reauth': statusScene(
    slotState({
      status: { state: 'needsReauth', reason: 'invalid_grant' },
      reasonCode: 'auth.expired',
    }),
  ),
  'shell-status-needs-permission': statusScene(
    slotState({
      status: { state: 'needsPermission', missingScopes: ['mail.modify'] },
      reasonCode: 'permission.mailModify',
    }),
  ),
  'shell-status-needs-admin': statusScene(
    slotState({
      status: { state: 'needsAdmin', reason: 'admin_policy_enforced' },
      reasonCode: 'auth.adminPolicy',
    }),
  ),
  'shell-status-misconfigured': statusScene(
    slotState({
      status: { state: 'misconfigured', reason: 'accessNotConfigured' },
      reasonCode: 'config.clientMissing',
    }),
  ),
  'shell-status-offline': statusScene(
    slotState({ status: { state: 'offline' }, reasonCode: 'net.offline', pendingChanges: 2 }),
  ),
  'shell-status-error': statusScene(
    slotState({
      status: { state: 'error', reason: 'backend 500: internal' },
      reasonCode: 'unknown',
    }),
  ),
};

/* ------------------------------ toasts ------------------------------ */

const UNDO_ACTION = [{ id: 'undo', label: 'Undo', commandId: 'app.undo' }] as const;

const DONE_TOAST: ToastData = {
  id: 'sh-done',
  kind: 'done',
  message: 'Done',
  actions: UNDO_ACTION,
  undoable: true,
};

const STACK_THREE: readonly ToastData[] = [
  DONE_TOAST,
  {
    id: 'sh-later',
    kind: 'later',
    message: 'Moved to Later',
    actions: [{ id: 'setDate', label: 'Set a date', commandId: 'mail.setDate' }, ...UNDO_ACTION],
    undoable: true,
  },
  { id: 'sh-pending', kind: 'pending', message: 'Moving 3 emails to Trash…', undoable: false },
];

const ERROR_TOAST: ToastData = {
  id: 'sh-error',
  kind: 'error',
  message: 'Couldn’t move 3 emails to Trash. They’re still in Home.',
  actions: [{ id: 'retry', label: 'Try again' }],
  undoable: false,
  persistent: true,
};

function toastScene(toasts: readonly ToastData[]): () => ReactElement {
  return function ToastShellScene(): ReactElement {
    return <Frame toasts={toasts} />;
  };
}

/* ------------------------------ errors, empties, fatal, sheet ------------------------------ */

function ErrorListFailed(): ReactElement {
  return (
    <Frame>
      <div className="stage__column">
        <ListFailedLine onRetry={noop} />
      </div>
    </Frame>
  );
}

function EmptyInboxZero(): ReactElement {
  return (
    <Frame>
      <EmptyLine
        placement="pane"
        text="You handled 12 emails"
        size="display"
        detail="Next: Design review at 2:00 PM"
        action={{ label: 'Undo last', commandId: 'app.undo', emphasis: 'text', onSelect: noop }}
      />
    </Frame>
  );
}

function EmptyFirstSync(): ReactElement {
  const state = slotState({ status: { state: 'backfilling', done: 214, of: 500 } });
  return (
    <Frame hidden state={state}>
      <FirstSyncLine reason="Importing 214 of 500" />
    </Frame>
  );
}

function EmptyNoAccounts(): ReactElement {
  return (
    <Frame>
      <NoAccountsLine onAddAccount={noop} onTryDemo={noop} />
    </Frame>
  );
}

function EmptyDrafts(): ReactElement {
  return (
    <Frame screen="drafts">
      <EmptyLine placement="pane" icon={DRAFTS_CONFIG.emptyIcon} text={DRAFTS_CONFIG.empty} />
    </Frame>
  );
}

/** Sent's empty line: the stand-in's Sent view keeps trashed mail, so the screen's own line is drawn here. */
function EmptySent(): ReactElement {
  return (
    <Frame screen="sent">
      <EmptyLine placement="pane" icon={SENT_CONFIG.emptyIcon} text={SENT_CONFIG.empty} />
    </Frame>
  );
}

let fatalLayerConnected = false;

/** The fatal screen's toast host reads the data layer (the undo-send notice), so one stand-in is connected first; the screen itself still draws from `kind`. */
function connectFatalLayer(): void {
  if (fatalLayerConnected) return;
  connectStandInDataLayer({ scenario: 'demo', clock: 'real' });
  fatalLayerConnected = true;
}

function FatalScene({ kind }: { kind: 'unreachable' | 'parked' }): ReactElement {
  connectFatalLayer();
  return <FatalHost kind={kind} />;
}

function reconnectScene(
  state: 'waiting' | 'failed',
  mode: 'reconnect' | 'grant',
  reason?: string,
): () => ReactElement {
  return function ReconnectShellScene(): ReactElement {
    return (
      <Frame
        overlay={
          <ReconnectSheet
            open
            address={SKY.address}
            state={state}
            reason={reason}
            mode={mode}
            onCancel={noop}
            onRetry={noop}
          />
        }
      />
    );
  };
}

function addAccountScene(
  over: Partial<ComponentProps<typeof AddAccountView>> = {},
): () => ReactElement {
  return function AddAccountScene(): ReactElement {
    return (
      <Frame
        overlay={
          <AddAccountView
            mode="choose"
            address=""
            notice={null}
            failure={null}
            onEdit={noop}
            onSubmit={noop}
            onConnect={noop}
            onChooseGoogle={noop}
            onCancel={noop}
            onClear={noop}
            onClose={noop}
            {...over}
          />
        }
      />
    );
  };
}

/* ------------------------------ the sidebar slot (Calendar's MiniMonth and Calendars list) ------------------------------ */

const SLOT_MONTH: MiniMonthProps = {
  month: '2026-10',
  today: '2026-10-29',
  range: { start: '2026-10-25', end: '2026-10-31' },
  weekStartsOn: 0,
  onMonthChange: noop,
  onPick: noop,
  marks: ['2026-10-27', '2026-10-29', '2026-10-30'],
};

const SLOT_CALENDARS: CalendarListProps = {
  calendars: [
    { id: 'work', name: 'Work', color: 'sky', visible: true },
    { id: 'personal', name: 'Personal', color: 'ember', visible: true },
    { id: 'hollow', name: 'Hollow Creek', color: 'hill', visible: false },
  ],
  onToggle: noop,
  onSolo: noop,
};

const SLOT: SidebarSlot = { miniMonth: SLOT_MONTH, calendars: SLOT_CALENDARS };

/** A throwaway screen: it only mounts the slot a real Calendar screen would. */
function SlotMount(): null {
  useSidebarSlot(SLOT);
  return null;
}

function SidebarCalendarSlot(): ReactElement {
  return (
    <Frame screen="calendar">
      <SlotMount />
      <HomeRows />
    </Frame>
  );
}

/** The shell's scenes by state id (tests/visual/states.ts, section `ui-shell`). */
export const shellScenes: Record<string, () => ReactElement> = {
  'shell-sidebar-groups': SidebarGroups,
  'shell-sidebar-first-sync': SidebarFirstSync,
  'shell-account-switcher-open': AccountSwitcherOpen,
  'shell-pane-header': PaneHeaderScene,
  'shell-minimised-nav': MinimisedNavScene,
  'shell-sidebar-calendar-slot': SidebarCalendarSlot,
  ...STATUS_SCENES,
  'shell-toast-undo': toastScene([DONE_TOAST]),
  'shell-toast-stack-three': toastScene(STACK_THREE),
  'shell-toast-error-persistent': toastScene([ERROR_TOAST]),
  'shell-error-list-failed': ErrorListFailed,
  'shell-empty-inbox-zero': EmptyInboxZero,
  'shell-empty-first-sync': EmptyFirstSync,
  'shell-empty-no-accounts': EmptyNoAccounts,
  'shell-empty-drafts': EmptyDrafts,
  'shell-empty-sent': EmptySent,
  'shell-fatal-screen': () => <FatalScene kind="unreachable" />,
  'shell-fatal-parked': () => <FatalScene kind="parked" />,
  'shell-add-account-open': addAccountScene(),
  'shell-add-account-typed': addAccountScene({ mode: 'typed', address: 'noor@studio.example' }),
  'shell-add-account-waiting': addAccountScene({
    mode: 'waiting',
    address: 'noor@studio.example',
  }),
  'shell-add-account-failed': addAccountScene({
    mode: 'failed',
    address: 'noor@studio.example',
    failure: 'auth.denied',
  }),
  'shell-reconnect-sheet': reconnectScene('waiting', 'reconnect'),
  'shell-reconnect-sheet-grant': reconnectScene('waiting', 'grant'),
  'shell-reconnect-sheet-failed': reconnectScene(
    'failed',
    'reconnect',
    failureReason('auth.wrongAccount'),
  ),
  'shell-settings-mounted': SettingsMountedScene,
};

/* ------------------------------ Settings mounted in the real app ------------------------------ */

let settingsClient: AppClient | null = null;

/** One stand-in per page load: the real app on the `demo` scenario at the Settings screen. */
function settingsApp(): AppClient {
  if (!settingsClient) {
    const layer = connectStandInDataLayer({ scenario: 'demo', clock: 'real' });
    settingsClient = createClient(layer.engine.connect());
  }
  return settingsClient;
}

const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

/** The real Settings screen in the real shell, held back for the screenshot until the screen has drawn. */
function SettingsMountedScene(): ReactElement {
  const client = settingsApp();
  useEffect(() => {
    navigate('settings');
    void (async () => {
      for (let i = 0; i < 400 && !document.querySelector('.settings-screen'); i += 1)
        await nextFrame();
      for (let i = 0; i < 8; i += 1) await nextFrame();
      await new Promise(resolve => setTimeout(resolve, 400));
      document.querySelector('[data-gallery-pending]')?.removeAttribute('data-gallery-pending');
    })();
  }, []);
  return (
    <>
      <App client={client} />
      <div hidden data-gallery-pending="" />
    </>
  );
}
