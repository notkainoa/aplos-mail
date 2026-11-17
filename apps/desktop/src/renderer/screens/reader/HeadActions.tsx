/**
 * The right side of the card's header (owner request 2026-11-10, image B): the Importance menu, the notification bell
 * and ⋯. Importance is the lane move (Important or Low importance, with Home's "Always do this for [sender]" and Undo
 * toast); the bell says whether the email notified, and stays neutral until the engine reports that; ⋯ lists the
 * actions the reader already has handlers for. Every control is a real button with a name, and Esc closes a menu.
 */
import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Message, ThreadRow } from '../../data';
import { useRegisterCommands, type CommandHandlerTable } from '../../shell';
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
  /** Absent where the view has no reply-all of its own (one by one): the ⋯ menu then leaves the row out. */
  readonly replyAll?: () => void;
  /** Absent where the view has no forward of its own: the ⋯ menu then leaves the row out. */
  readonly forward?: () => void;
  /** Marks the thread read or unread (a read thread is marked unread and the reader returns to its list). */
  readonly toggleRead?: () => void;
  readonly bookmark: () => void;
  readonly trash: () => void;
  readonly lane: (to: MovableLane) => void;
}

/** Props for `HeadActions`. */
export interface HeadActionsProps {
  readonly row: ThreadRow;
  /** The message whose header this is (the latest): the bell reports whether it notified. */
  readonly message: Message;
  /** The filled suggestion's verb and icon, for the menu's first row. */
  readonly suggestion: SuggestedAction;
  readonly controls: HeadControls;
  /**
   * This letter answers the pane header's ⋯ (`list.more`): the reader's letter on paper. An off-paper letter is still
   * laying itself out, and one by one has its own menu for the key.
   */
  readonly topBarMore?: boolean;
}

const noop = () => undefined;

const NO_HANDLERS: CommandHandlerTable = {};

const IMPORTANCE_ENTRIES: readonly MenuEntry[] = (['important', 'low'] as const).map(choice => ({
  kind: 'item',
  id: choice,
  label: IMPORTANCE_LABEL[choice],
}));

/**
 * A button that opens a Menu under it: the open flag, the anchor, the ids the two need to point at each other and the
 * keyboard cursor (the Menu is controlled: Arrow keys move `active` and Enter chooses it). It opens on `first`.
 */
function useMenuButton(first: string) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(first);
  const ref = useRef<HTMLButtonElement>(null);
  const id = useId();
  const toggle = () => {
    setActive(first);
    setOpen(value => !value);
  };
  const show = useCallback(() => {
    setActive(first);
    setOpen(true);
  }, [first]);
  return { open, ref, id, active, setActive, toggle, show, close: () => setOpen(false) };
}

function ImportanceMenu({ row, controls }: Pick<HeadActionsProps, 'row' | 'controls'>) {
  const at = importanceOf(row);
  const menu = useMenuButton(at ?? 'important');
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
        activeId={menu.active}
        onActiveChange={menu.setActive}
        onSelect={id => choose(id === 'low' ? 'low' : 'important')}
        onClose={menu.close}
      />
    </>
  );
}

const BELL: Readonly<
  Record<Exclude<NotificationState, 'unknown'>, { icon: 'bell' | 'bell-off'; label: string }>
> = {
  notified: { icon: 'bell', label: 'This email notified you' },
  silent: { icon: 'bell-off', label: 'This email did not notify you' },
};

/**
 * The bell: a status mark, not a control. A bell when the email notified, a slashed bell when it did not. While the engine
 * has not said (mail older than its notification log) there is no bell at all: a plain bell would read as "notified".
 */
function NotificationBell({ state }: { readonly state: NotificationState }) {
  if (state === 'unknown') return null;
  const { icon, label } = BELL[state];
  return (
    <span className="aplos-bell" role="img" aria-label={label} title={label} data-state={state}>
      <Icon name={icon} />
    </span>
  );
}

/** The ⋯ menu: the actions the reader has handlers for, each with its key from the registry. */
export function moreEntries(
  row: ThreadRow,
  suggestion: SuggestedAction,
  has: { readonly replyAll: boolean; readonly forward: boolean; readonly toggleRead: boolean },
): readonly MenuEntry[] {
  const replyAll: MenuEntry = {
    kind: 'item',
    id: 'replyAll',
    label: 'Reply all',
    icon: 'reply-all',
    commandId: 'mail.replyAll',
  };
  const forward: MenuEntry = {
    kind: 'item',
    id: 'forward',
    label: 'Forward',
    icon: 'forward',
    commandId: 'mail.forward',
  };
  const toggleRead: MenuEntry = {
    kind: 'item',
    id: 'toggleRead',
    label: row.unread ? 'Mark read' : 'Mark unread',
    icon: 'mail',
    commandId: 'mail.toggleRead',
  };
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
    ...(has.replyAll ? [replyAll] : []),
    ...(has.forward ? [forward] : []),
    ...(has.toggleRead ? [toggleRead] : []),
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

/** The pane header's ⋯ button, which the reader's top bar draws above the card (the menu opens under it). */
function headerMoreButton(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.ui-pane__tools [aria-label="Thread actions"]');
}

function MoreMenu({ row, suggestion, controls, topBarMore }: HeadActionsProps) {
  const menu = useMenuButton('suggested');
  const [from, setFrom] = useState<HTMLElement | null>(null);
  const close = useCallback(() => {
    setFrom(null);
    menu.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `menu.close` only sets state
  }, []);
  const { show, open: isOpen } = menu;
  // The top bar's ⋯ and the . key run `list.more`: the same menu, under the bar's button; a second click of the bar's ⋯ closes it.
  const table = useMemo<CommandHandlerTable>(() => {
    if (!topBarMore) return NO_HANDLERS;
    const run = () => {
      if (isOpen) return close();
      setFrom(headerMoreButton());
      show();
    };
    return { 'list.more': { run } };
  }, [topBarMore, isOpen, show, close]);
  useRegisterCommands(table);
  // The bar's ⋯ is the pane's own button: while its menu is open it says so, which also hides its tooltip.
  useLayoutEffect(() => {
    if (!from || !isOpen) return undefined;
    from.setAttribute('aria-expanded', 'true');
    return () => from.removeAttribute('aria-expanded');
  }, [from, isOpen]);
  const run: Readonly<Record<string, () => void>> = {
    suggested: controls.suggest,
    replyAll: controls.replyAll ?? noop,
    forward: controls.forward ?? noop,
    toggleRead: controls.toggleRead ?? noop,
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
        label="Message actions"
        popup={{ kind: 'menu', expanded: menu.open, controls: menu.id }}
        onPress={() => {
          setFrom(null);
          menu.toggle();
        }}
      />
      <Menu
        id={menu.id}
        open={menu.open}
        anchor={from ?? menu.ref.current}
        label={from ? 'Thread actions' : 'Message actions'}
        entries={moreEntries(row, suggestion, {
          replyAll: controls.replyAll !== undefined,
          forward: controls.forward !== undefined,
          toggleRead: controls.toggleRead !== undefined,
        })}
        activeId={menu.active}
        onActiveChange={menu.setActive}
        onSelect={id => {
          close();
          run[id]?.();
        }}
        onClose={close}
      />
    </>
  );
}

/** The bell, Importance and ⋯, in that order (owner sketch 2026-11-10). */
export function HeadActions(props: HeadActionsProps) {
  return (
    <>
      <NotificationBell state={notificationOf(props.message)} />
      <ImportanceMenu row={props.row} controls={props.controls} />
      <MoreMenu {...props} />
    </>
  );
}
