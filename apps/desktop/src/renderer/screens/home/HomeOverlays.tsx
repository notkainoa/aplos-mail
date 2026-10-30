/** What opens over Home: the Low importance sheet and the focus letter's ⋯ menu. */
import type { Account, AccountId, ThreadId, ThreadRow } from '../../data';
import type { Density } from '../../ui/props';
import { HomeMenu } from './HomeMenu';
import { LowSheetHost } from './LowSheetHost';
import type { HomeActions, OpenHow } from './homeActions';

/** Props for `HomeOverlays`. */
export interface HomeOverlaysProps {
  readonly accountId?: AccountId;
  readonly lowOpen: boolean;
  readonly onCloseLow: () => void;
  readonly menuAnchor: HTMLElement | null;
  readonly onCloseMenu: () => void;
  readonly density: Density;
  readonly accounts: readonly Account[];
  readonly rowOf: (id: ThreadId) => ThreadRow | undefined;
  readonly cursorKey: string | null;
  readonly onOpen: (id: ThreadId, how: OpenHow) => void;
  readonly actions: HomeActions;
}

export function HomeOverlays(props: HomeOverlaysProps) {
  const { actions, menuAnchor, onCloseMenu, cursorKey, rowOf } = props;
  return (
    <>
      {props.lowOpen ? (
        <LowSheetHost
          accountId={props.accountId}
          density={props.density}
          accounts={props.accounts}
          onOpenThread={id => props.onOpen(id, 'open')}
          onClose={props.onCloseLow}
        />
      ) : null}
      <HomeMenu
        anchor={menuAnchor}
        row={cursorKey === null ? undefined : rowOf(cursorKey)}
        onSelect={id => {
          onCloseMenu();
          if (id === 'bookmark') actions.bookmark();
          else actions.trash();
        }}
        onClose={onCloseMenu}
      />
    </>
  );
}
