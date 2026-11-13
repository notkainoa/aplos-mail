/**
 * The composer's From row (owner's hands-on pass 2026-11-12: with two accounts there was no way to say which one
 * sends). Shown only when more than one account is connected. A new message is written in the account chosen here
 * (the current one by default); a reply, a forward or a message already being sent is written in the account the
 * thread belongs to, so its row shows that address and offers no menu. Accounts are named by their address.
 */
import { useId, useRef, useState } from 'react';
import type { Account } from '../../../data';
import { Button } from '../../../ui/buttons-keys';
import type { MenuEntry } from '../../../ui/props';
import { Menu } from '../../../ui/surfaces';

/** Props for `FromRow`. */
export interface FromRowProps {
  readonly accounts: readonly Account[];
  readonly accountId: string;
  /** False for good when the account cannot change (a reply or forward). A moment's lockout (a save in flight) keeps the menu: the move waits for it. */
  readonly canChange: boolean;
  readonly onChange: (accountId: string) => void;
}

function entriesOf(accounts: readonly Account[]): readonly MenuEntry[] {
  return accounts.map(account => ({ kind: 'item', id: account.id, label: account.address }));
}

/** The From row, or nothing when there is only one account to send from. */
export function FromRow({ accounts, accountId, canChange, onChange }: FromRowProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(accountId);
  const anchor = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  if (accounts.length < 2) return null;
  const current = accounts.find(account => account.id === accountId);
  const address = current?.address ?? accountId;
  return (
    <div className="ui-recipient-field aplos-from" role="group" aria-label="From">
      <span className="ui-recipient-field__label" aria-hidden="true">
        From
      </span>
      {canChange ? (
        <>
          <Button
            ref={anchor}
            variant="text"
            size="sm"
            label={address}
            ariaLabel={`From ${address}, change account`}
            trailingIcon="chevron-down"
            popup={{ kind: 'menu', expanded: open, controls: menuId }}
            onPress={() => {
              setActive(accountId);
              setOpen(value => !value);
            }}
          />
          <Menu
            id={menuId}
            open={open}
            anchor={anchor.current}
            label="Send from"
            entries={entriesOf(accounts)}
            checkedId={accountId}
            activeId={active}
            onActiveChange={setActive}
            onSelect={id => {
              setOpen(false);
              onChange(id);
            }}
            onClose={() => setOpen(false)}
          />
        </>
      ) : (
        <span className="aplos-from__address">{address}</span>
      )}
    </div>
  );
}
