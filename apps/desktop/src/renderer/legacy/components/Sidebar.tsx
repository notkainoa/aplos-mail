import { memo } from 'react';
import {
  Archive,
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  ChevronsUpDown,
  Clock,
  FileText,
  Gear,
  HelpCircle,
  Home,
  Info,
  Keyboard,
  MenuLines,
  PanelLeft,
  Plus,
  RefreshCw,
  Send,
  ShieldAlert,
  Trash2,
  Users,
} from '../icons';
import type { Account, AppState, View } from '@aplos/contract/legacy/types';
import { Count, IconButton, Keys, Menu, cx, useMenu, type Icon } from '../ui';
import { showSettingsTab } from '../Settings';

export const sections: { view: View; label: string; icon: Icon; divider?: boolean }[] = [
  { view: 'home', label: 'Home', icon: Home },
  { view: 'later', label: 'Later', icon: Clock },
  { view: 'all', label: 'All mail', icon: Archive, divider: true },
  { view: 'drafts', label: 'Drafts', icon: FileText },
  { view: 'sent', label: 'Sent', icon: Send },
  { view: 'calendar', label: 'Calendar', icon: CalendarDays },
  { view: 'trash', label: 'Trash', icon: Trash2, divider: true },
  { view: 'spam', label: 'Spam', icon: ShieldAlert },
];

/** Calendar isn't a mailbox, so the sidebar shows it in the footer; it keeps its place here for ⌃6. */
const mailboxes = sections.filter(s => s.view !== 'calendar');

export function accountName(account: Account) {
  return account.provider === 'demo' ? (account.id === 'work' ? 'Work' : 'Personal') : account.name;
}
function accountInitial(account: Account) {
  return (
    account.provider === 'demo' ? (account.id === 'work' ? 'W' : 'P') : account.name[0] || '?'
  ).toUpperCase();
}

type SidebarProps = {
  state: AppState;
  view: View | null;
  counts: Partial<Record<View, number>>;
  zen: boolean;
  online: boolean;
  syncing: boolean;
  canBack: boolean;
  canForward: boolean;
  navigate: (view: View) => void;
  back: () => void;
  forward: () => void;
  sync: () => void;
  hide: () => void;
  selectAccount: (id: string) => void;
  shortcuts: () => void;
  onError: (error: Error) => void;
};

export const Sidebar = memo(function Sidebar({
  state,
  view,
  counts,
  zen,
  online,
  syncing,
  canBack,
  canForward,
  navigate,
  back,
  forward,
  sync,
  hide,
  selectAccount,
  shortcuts,
  onError,
}: SidebarProps) {
  const accounts = useMenu();
  const help = useMenu();
  const current = state.accounts.find(a => a.id === state.selectedAccountId);
  const shown = current ? [current] : state.accounts.slice(0, 2);
  const status = !online || state.sync.busy || !!state.sync.error;
  return (
    <aside className="sidebar">
      <div className="sidebar-titlebar">
        <IconButton label="Hide sidebar" shortcut="[" icon={PanelLeft} onClick={hide} />
        <div className="actions">
          <IconButton
            label="Refresh mail"
            icon={RefreshCw}
            iconSize={14}
            disabled={syncing}
            className={syncing ? 'is-syncing' : undefined}
            onClick={sync}
          />
          <IconButton label="Back" icon={ArrowLeft} disabled={!canBack} onClick={back} />
          <IconButton label="Forward" icon={ArrowRight} disabled={!canForward} onClick={forward} />
        </div>
      </div>
      <button
        className={cx('account-trigger', accounts.open && 'is-open')}
        aria-label="Switch account"
        aria-haspopup="menu"
        aria-expanded={accounts.open}
        onClick={accounts.toggle}
      >
        <span className="account-stack">
          {shown.map(a => (
            <span key={a.id} className="account-avatar" style={{ background: a.color }}>
              {accountInitial(a)}
            </span>
          ))}
        </span>
        <span className="account-name">{current ? accountName(current) : 'All accounts'}</span>
        <ChevronsUpDown size={15} />
      </button>
      <Menu
        open={accounts.open}
        anchor={accounts.anchor}
        onClose={accounts.close}
        placement="bottom-start"
        matchWidth
        label="Accounts"
        className="account-menu"
        onError={onError}
        groups={[
          [
            {
              label: 'All accounts',
              checked: state.selectedAccountId === 'all',
              onSelect: () => selectAccount('all'),
            },
            ...state.accounts.map(a => ({
              label: accountName(a),
              hint: a.email,
              leading: <span className="account-dot" style={{ background: a.color }} />,
              checked: a.id === state.selectedAccountId,
              onSelect: () => selectAccount(a.id),
            })),
          ],
          [
            {
              label: 'Manage accounts',
              icon: Plus,
              onSelect: () => {
                showSettingsTab('Accounts');
                navigate('settings');
              },
            },
          ],
        ]}
      />
      <nav className="main-nav" aria-label="Mailboxes">
        {mailboxes.map(({ view: id, label, icon: NavIcon, divider }) => {
          const value = counts[id] ?? 0,
            index = sections.findIndex(s => s.view === id);
          return (
            <div key={id} className={divider ? 'nav-divider' : undefined}>
              <button
                className={cx('nav-item', view === id && 'active')}
                aria-current={view === id ? 'page' : undefined}
                onClick={() => navigate(id)}
              >
                <NavIcon size={18} />
                <span className="nav-label">{label}</span>
                {index < 9 && <Keys combo={'⌃ ' + (index + 1)} size="sm" className="nav-keys" />}
                {(!zen || id === 'home') && value > 0 && (
                  <Count value={value} className="nav-count" />
                )}
              </button>
            </div>
          );
        })}
      </nav>
      <footer className="sidebar-footer">
        {status && (
          <div className="sidebar-status">
            <span
              className={cx(
                'sync-dot',
                (!online || state.sync.error) && 'offline',
                state.sync.busy && 'busy',
              )}
            />
            <span>
              {!online
                ? 'Available offline'
                : state.sync.busy
                  ? 'Syncing mail…'
                  : 'Sync needs attention'}
            </span>
          </div>
        )}
        <div className="sidebar-footer-row">
          <button
            className={cx('footer-link', 'footer-calendar', view === 'calendar' && 'active')}
            aria-current={view === 'calendar' ? 'page' : undefined}
            onClick={() => navigate('calendar')}
          >
            <CalendarDays size={18} />
            <span className="nav-label">Calendar</span>
            <Keys combo="⌃ 6" size="sm" className="nav-keys" />
          </button>
          <IconButton
            label="Settings"
            shortcut="⌘ ,"
            placement="top"
            icon={Gear}
            iconSize={16}
            className={cx(view === 'settings' && 'is-active')}
            aria-current={view === 'settings' ? 'page' : undefined}
            onClick={() => navigate('settings')}
          />
          <IconButton
            label="Help"
            icon={HelpCircle}
            iconSize={16}
            active={help.open}
            aria-haspopup="menu"
            aria-expanded={help.open}
            onClick={help.toggle}
          />
        </div>
        <Menu
          open={help.open}
          anchor={help.anchor}
          onClose={help.close}
          placement="top-end"
          label="Help"
          onError={onError}
          groups={[
            [
              { label: 'Keyboard shortcuts', icon: Keyboard, keys: '?', onSelect: shortcuts },
              {
                label: 'About Aplos Mail',
                icon: Info,
                onSelect: () => {
                  showSettingsTab('Help & about');
                  navigate('settings');
                },
              },
            ],
          ]}
        />
      </footer>
    </aside>
  );
});

type SidebarMenuProps = {
  state: AppState;
  view: View | null;
  counts: Partial<Record<View, number>>;
  zen: boolean;
  online: boolean;
  syncing: boolean;
  navigate: (view: View) => void;
  sync: () => void;
  selectAccount: (id: string) => void;
  shortcuts: () => void;
  onError: (error: Error) => void;
};

/** The minimized sidebar: everything the sidebar holds, in one small menu at the top left. */
export const SidebarMenu = memo(function SidebarMenu({
  state,
  view,
  counts,
  zen,
  online,
  syncing,
  navigate,
  sync,
  selectAccount,
  shortcuts,
  onError,
}: SidebarMenuProps) {
  const menu = useMenu();
  const status = !online
    ? 'Available offline'
    : state.sync.busy
      ? 'Syncing mail…'
      : state.sync.error
        ? 'Sync needs attention'
        : undefined;
  const mailbox = (from: number, to: number) =>
    mailboxes.slice(from, to).map(({ view: id, label, icon }) => {
      const value = counts[id] ?? 0;
      return {
        label,
        icon,
        checked: view === id,
        count: (!zen || id === 'home') && value > 0 ? value : undefined,
        onSelect: () => navigate(id),
      };
    });
  return (
    <>
      <IconButton
        label="Mailboxes"
        shortcut="["
        icon={MenuLines}
        active={menu.open}
        className="sidebar-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={menu.open}
        onClick={menu.toggle}
      />
      <Menu
        open={menu.open}
        anchor={menu.anchor}
        onClose={menu.close}
        placement="bottom-start"
        label="Mailboxes"
        className="sidebar-menu"
        onError={onError}
        groups={[
          state.accounts.length > 1
            ? [
                {
                  label: 'All accounts',
                  icon: Users,
                  checked: state.selectedAccountId === 'all',
                  onSelect: () => selectAccount('all'),
                },
                ...state.accounts.map(a => ({
                  label: accountName(a),
                  leading: (
                    <span className="menu-dot">
                      <span className="account-dot" style={{ background: a.color }} />
                    </span>
                  ),
                  checked: a.id === state.selectedAccountId,
                  onSelect: () => selectAccount(a.id),
                })),
              ]
            : [],
          mailbox(0, 2),
          mailbox(2, 5),
          mailbox(5, 7),
          [
            {
              label: 'Calendar',
              icon: CalendarDays,
              keys: '⌃ 6',
              checked: view === 'calendar',
              onSelect: () => navigate('calendar'),
            },
            {
              label: 'Refresh mail',
              icon: RefreshCw,
              hint: status,
              disabled: syncing,
              onSelect: sync,
            },
            {
              label: 'Settings',
              icon: Gear,
              keys: '⌘ ,',
              checked: view === 'settings',
              onSelect: () => navigate('settings'),
            },
            { label: 'Keyboard shortcuts', icon: Keyboard, keys: '?', onSelect: shortcuts },
          ],
        ]}
      />
    </>
  );
});
