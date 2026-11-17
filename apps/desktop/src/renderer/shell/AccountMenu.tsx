/**
 * The sidebar's account switcher and its menu (DESIGN 7.1). The switcher names the scope (All accounts by default); the
 * menu lists every account with its colour, the reason an unhealthy one needs attention and an inline Reconnect, then
 * "Add an account". The dot shows only when two or more accounts exist (DESIGN 4.2), through the Menu's swatches.
 */
import { useId, useState } from 'react';
import type { Account, AccountId } from '../data';
import type { MenuEntry } from '../ui/props';
import { statusCopy } from '../ui/status';
import { AccountSwitcher, Menu } from '../ui/surfaces';
import { useMenuActive } from './menu-active';
import { accountColor, needsReconnect } from './status-map';
import { setSheetOpener } from './index';

const ALL_ID = 'all-accounts';
const ADD_ID = 'add-account';
const ALL_LABEL = 'All accounts';

/** Props for `AccountMenu`. */
export interface AccountMenuProps {
  readonly accounts: readonly Account[];
  /** The scope: one account, or undefined for All accounts. */
  readonly scope: AccountId | undefined;
  readonly onScope: (accountId: AccountId | undefined) => void;
  /** Reconnect (or grant) was chosen on an account row. */
  readonly onReconnect: (account: Account) => void;
  readonly onAddAccount: () => void;
}

function reasonLine(account: Account): string | undefined {
  if (!needsReconnect(account)) return undefined;
  return statusCopy({ kind: account.health.status.state as 'needsReauth' | 'needsPermission' })
    ?.text;
}

function accountEntry(
  account: Account,
  index: number,
  onReconnect: AccountMenuProps['onReconnect'],
): MenuEntry {
  return {
    kind: 'item',
    id: account.id,
    label: account.address,
    swatch: accountColor(account, index),
    detail: reasonLine(account),
    inlineAction: needsReconnect(account)
      ? { label: 'Reconnect', tone: 'danger', onSelect: () => onReconnect(account) }
      : undefined,
  };
}

/** The menu's rows: All accounts (the people icon, never a dot), each account, a separator, Add an account. */
export function accountEntries(
  accounts: readonly Account[],
  onReconnect: AccountMenuProps['onReconnect'],
): MenuEntry[] {
  return [
    { kind: 'label', label: 'Accounts' },
    { kind: 'item', id: ALL_ID, label: ALL_LABEL, icon: 'users' },
    ...accounts.map((account, index) => accountEntry(account, index, onReconnect)),
    { kind: 'separator' },
    { kind: 'item', id: ADD_ID, label: 'Add an account', icon: 'plus' },
  ];
}

/** What the switcher says and its one-letter monogram. */
export function scopeLabel(accounts: readonly Account[], scope: AccountId | undefined) {
  const account = scope ? accounts.find(a => a.id === scope) : undefined;
  const label = account ? account.address : ALL_LABEL;
  return { label, monogram: label.slice(0, 1).toUpperCase() };
}

export function AccountMenu({
  accounts,
  scope,
  onScope,
  onReconnect,
  onAddAccount,
}: AccountMenuProps) {
  const menuId = useId();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const { label, monogram } = scopeLabel(accounts, scope);
  // The menu item unmounts when the menu closes, so the switcher is the opener the sheet returns focus to.
  const reconnect = (account: Account) => {
    setSheetOpener(anchor);
    onReconnect(account);
  };
  const entries = accountEntries(accounts, reconnect);
  const active = useMenuActive(entries);
  const close = () => {
    active.reset();
    setAnchor(null);
  };
  const select = (id: string) => {
    close();
    if (id === ADD_ID) {
      setSheetOpener(anchor);
      onAddAccount();
    } else onScope(id === ALL_ID ? undefined : id);
  };
  return (
    <>
      <AccountSwitcher
        label={label}
        monogram={monogram}
        open={anchor !== null}
        menuId={menuId}
        onOpen={setAnchor}
      />
      <Menu
        open={anchor !== null}
        anchor={anchor}
        label="Accounts"
        entries={entries}
        activeId={active.activeId}
        onActiveChange={active.onActiveChange}
        checkedId={scope ?? ALL_ID}
        onSelect={select}
        onClose={close}
      />
    </>
  );
}
