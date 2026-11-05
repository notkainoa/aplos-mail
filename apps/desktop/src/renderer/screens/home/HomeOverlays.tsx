/** What opens over Home: the Low importance sheet, the focus letter's ⋯ menu and "Why it's here". */
import type { Account, AccountId, ThreadId, ThreadRow } from '../../data';
import type { Density, SuggestedAction } from '../../ui/props';
import { HomeMenu, type HomeMenuChoice } from './HomeMenu';
import { LowSheetHost } from './LowSheetHost';
import { WhyHost, type WhyTarget } from './WhyHost';
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
  /** The focus letter's suggestion, for the ⋯ menu's first row. */
  readonly suggestion?: SuggestedAction;
  readonly onOpen: (id: ThreadId, how: OpenHow) => void;
  readonly actions: HomeActions;
  /** The thread "Why it's here" is open for, or null. */
  readonly why: WhyTarget | null;
  readonly onWhy: () => void;
  readonly onCloseWhy: () => void;
}

/** Runs a ⋯ menu choice on the row under the cursor. */
export function chooseFromHomeMenu(id: HomeMenuChoice, props: HomeOverlaysProps): void {
  // The menu belongs to the row under the cursor, so it acts on that row even while others are picked.
  const key = props.cursorKey ?? undefined;
  switch (id) {
    case 'suggested':
      return props.actions.suggested();
    case 'later':
      return props.actions.later(key);
    case 'done':
      return props.actions.done(key);
    case 'setDate':
      return props.actions.setDate();
    case 'bookmark':
      return props.actions.bookmark(key);
    case 'why':
      return props.onWhy();
    case 'trash':
      return props.actions.trash(key);
  }
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
        suggestion={props.suggestion}
        onSelect={id => {
          onCloseMenu();
          chooseFromHomeMenu(id, props);
        }}
        onClose={onCloseMenu}
      />
      {props.why ? (
        <WhyHost
          key={props.why.id}
          target={props.why}
          current={cursorKey}
          onMove={direction => {
            if (cursorKey === props.why?.id) actions.lane(direction);
          }}
          onClose={props.onCloseWhy}
        />
      ) : null}
    </>
  );
}
