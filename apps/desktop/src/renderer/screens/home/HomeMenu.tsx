/**
 * The ⋯ menu on the focus letter (DESIGN 7.2): every action the letter has a handler for, including the ones
 * already shown as buttons — the suggested action, Later and Done, then Set a date, the bookmark toggle and
 * "Why it's here", with Move to Trash last in the danger style. Each key comes from the registry through the
 * command's `commandId`; Mark read/unread, Reply all and Forward stay out until Home owns handlers for them.
 */
import type { ThreadRow } from '../../data';
import type { MenuEntry, SuggestedAction } from '../../ui/props';
import { Menu } from '../../ui/surfaces';

/** The menu's entries for the row under the cursor. */
export function menuEntries(
  row: ThreadRow | undefined,
  suggestion?: SuggestedAction,
): readonly MenuEntry[] {
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
      label: suggestion?.verb ?? 'Reply',
      icon: suggestion?.icon ?? 'reply',
      commandId: 'mail.suggested',
    },
    {
      kind: 'item',
      id: 'later',
      label: 'Later',
      icon: 'clock',
      commandId: 'mail.later',
    },
    ...(suggestion?.isDone ? [] : [done]),
    { kind: 'separator' },
    {
      kind: 'item',
      id: 'setDate',
      label: 'Set a date',
      icon: 'calendar',
      commandId: 'mail.setDate',
    },
    {
      kind: 'item',
      id: 'bookmark',
      label: row?.workflow.bookmarked ? 'Remove bookmark' : 'Bookmark',
      icon: 'bookmark',
      commandId: 'mail.bookmark',
    },
    {
      kind: 'item',
      id: 'why',
      label: 'Why it’s here',
      icon: 'help',
      commandId: 'mail.why',
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

/** What the menu can choose. */
export type HomeMenuChoice =
  'suggested' | 'later' | 'done' | 'setDate' | 'bookmark' | 'why' | 'trash';

const CHOICES: ReadonlySet<string> = new Set([
  'suggested',
  'later',
  'done',
  'setDate',
  'bookmark',
  'why',
  'trash',
]);

/** Props for `HomeMenu`. */
export interface HomeMenuProps {
  readonly anchor: HTMLElement | null;
  readonly row: ThreadRow | undefined;
  /** The focus letter's suggestion: the first row's verb and icon. Absent: "Reply". */
  readonly suggestion?: SuggestedAction;
  readonly onSelect: (id: HomeMenuChoice) => void;
  readonly onClose: () => void;
}

export function HomeMenu({ anchor, row, suggestion, onSelect, onClose }: HomeMenuProps) {
  return (
    <Menu
      open={anchor !== null}
      anchor={anchor}
      label="More"
      entries={menuEntries(row, suggestion)}
      onSelect={id => {
        if (CHOICES.has(id)) onSelect(id as HomeMenuChoice);
      }}
      onClose={onClose}
    />
  );
}
