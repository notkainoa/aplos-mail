/**
 * The right side of the card's header (owner request 2026-11-10, image B): the Importance menu, the notification bell
 * and ⋯. Importance is the lane move (Important or Low importance, with Home's "Always do this for [sender]" and Undo
 * toast); the bell says whether the email notified, and stays neutral until the engine reports that; ⋯ lists the
 * actions the reader already has handlers for. Every control is a real button with a name, and Esc closes a menu.
 */
import { useId, useRef, useState } from 'react';
import type { ThreadRow } from '../../data';
import { Button, Icon } from '../../ui/buttons-keys';
import type { MenuEntry, SuggestedAction } from '../../ui/props';
import { Menu } from '../../ui/surfaces';
import type { MovableLane } from '../home/homeModel';
import {
  IMPORTANCE_LABEL,
  importanceOf,
  laneForChoice,
  notificationOf,
  type Importance,
  type NotificationState,
} from './readerLane';

/** What the header's controls call; the screen implements them (the reader's own actions, or Home's in one by one). */
export interface HeadControls {
  readonly suggest: () => void;
  readonly later: () => void;
  readonly done: () => void;
  readonly replyAll: () => void;
  readonly bookmark: () => void;
  readonly trash: () => void;
  readonly lane: (to: MovableLane) => void;
}

/** Props for `HeadActions`. */
export interface HeadActionsProps {
  readonly row: ThreadRow;
  /** The filled suggestion's verb and icon, for the menu's first row. */
  readonly suggestion: SuggestedAction;
  readonly controls: HeadControls;
}

const IMPORTANCE_ENTRIES: readonly MenuEntry[] = (['important', 'low'] as const).map(choice => ({
  kind: 'item',
  id: choice,
  label: IMPORTANCE_LABEL[choice],
}));

/** A button that opens a Menu under it: the open flag, the anchor and the ids the two need to point at each other. */
function useMenuButton() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const id = useId();
  return { open, ref, id, toggle: () => setOpen(value => !value), close: () => setOpen(false) };
}

function ImportanceMenu({ row, controls }: Pick<HeadActionsProps, 'row' | 'controls'>) {
  const at = importanceOf(row);
  const menu = useMenuButton();
  if (at === null) return null;
  const choose = (choice: Importance) => {
    menu.close();
    const to = laneForChoice(row, choice);
    if (to !== null) controls.lane(to);
  };
  return (
    <>
      <Button
        ref={menu.ref}
        variant="text"
        size="sm"
        label={IMPORTANCE_LABEL[at]}
        ariaLabel={`${IMPORTANCE_LABEL[at]}, change importance`}
        trailingIcon="chevron-down"
        popup={{ kind: 'menu', expanded: menu.open, controls: menu.id }}
        onPress={menu.toggle}
      />
      <Menu
        id={menu.id}
        open={menu.open}
        anchor={menu.ref.current}
        label="Importance"
        entries={IMPORTANCE_ENTRIES}
        checkedId={at}
        onSelect={id => choose(id === 'low' ? 'low' : 'important')}
        onClose={menu.close}
      />
    </>
  );
}

const BELL: Readonly<Record<NotificationState, { icon: 'bell' | 'bell-off'; label: string }>> = {
  notified: { icon: 'bell', label: 'This email notified you' },
  silent: { icon: 'bell-off', label: 'This email did not notify you' },
  unknown: { icon: 'bell', label: 'Notification status is not reported yet' },
};

/** The bell: a status mark, not a control. Slashed when the email did not notify; neutral while that is unknown. */
function NotificationBell({ state }: { readonly state: NotificationState }) {
  const { icon, label } = BELL[state];
  return (
    <span className="aplos-bell" role="img" aria-label={label} title={label} data-state={state}>
      <Icon name={icon} />
    </span>
  );
}

/** The ⋯ menu: the actions the reader has handlers for, each with its key from the registry. */
export function moreEntries(row: ThreadRow, suggestion: SuggestedAction): readonly MenuEntry[] {
  const done: MenuEntry = {
    kind: 'item',
    id: 'done',
    label: 'Done',
    icon: 'check',
    commandId: 'mail.done',
  };
  return [
    {
      kind: 'item',
      id: 'suggested',
      label: suggestion.verb,
      icon: suggestion.icon,
      commandId: 'mail.suggested',
    },
    {
      kind: 'item',
      id: 'replyAll',
      label: 'Reply all',
      icon: 'reply-all',
      commandId: 'mail.replyAll',
    },
    { kind: 'item', id: 'later', label: 'Later', icon: 'clock', commandId: 'mail.later' },
    ...(suggestion.isDone ? [] : [done]),
    { kind: 'separator' },
    {
      kind: 'item',
      id: 'bookmark',
      label: row.workflow.bookmarked ? 'Remove bookmark' : 'Bookmark',
      icon: 'bookmark',
      commandId: 'mail.bookmark',
    },
    { kind: 'separator' },
    {
      kind: 'item',
      id: 'trash',
      label: 'Move to Trash',
      icon: 'trash',
      commandId: 'mail.trash',
      danger: true,
    },
  ];
}

function MoreMenu({ row, suggestion, controls }: HeadActionsProps) {
  const menu = useMenuButton();
  const run: Readonly<Record<string, () => void>> = {
    suggested: controls.suggest,
    replyAll: controls.replyAll,
    later: controls.later,
    done: controls.done,
    bookmark: controls.bookmark,
    trash: controls.trash,
  };
  return (
    <>
      <Button
        ref={menu.ref}
        variant="icon"
        size="sm"
        icon="more"
        label="More"
        popup={{ kind: 'menu', expanded: menu.open, controls: menu.id }}
        onPress={menu.toggle}
      />
      <Menu
        id={menu.id}
        open={menu.open}
        anchor={menu.ref.current}
        label="More"
        entries={moreEntries(row, suggestion)}
        onSelect={id => {
          menu.close();
          run[id]?.();
        }}
        onClose={menu.close}
      />
    </>
  );
}

/** Importance, the bell and ⋯, in that order. */
export function HeadActions(props: HeadActionsProps) {
  return (
    <>
      <ImportanceMenu row={props.row} controls={props.controls} />
      <NotificationBell state={notificationOf(props.row)} />
      <MoreMenu {...props} />
    </>
  );
}
