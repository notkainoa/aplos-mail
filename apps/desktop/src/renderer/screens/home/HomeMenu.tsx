/** The ⋯ menu on the focus letter (DESIGN 7.2): bookmark and trash, each with its key from the registry. */
import type { ThreadRow } from '../../data';
import type { MenuEntry } from '../../ui/props';
import { Menu } from '../../ui/surfaces';

/** The menu's entries for the row under the cursor. */
export function menuEntries(row: ThreadRow | undefined): readonly MenuEntry[] {
  return [
    {
      kind: 'item',
      id: 'bookmark',
      label: row?.workflow.bookmarked ? 'Remove bookmark' : 'Bookmark',
      icon: 'bookmark',
      commandId: 'mail.bookmark',
    },
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

/** Props for `HomeMenu`. */
export interface HomeMenuProps {
  readonly anchor: HTMLElement | null;
  readonly row: ThreadRow | undefined;
  readonly onSelect: (id: 'bookmark' | 'trash') => void;
  readonly onClose: () => void;
}

export function HomeMenu({ anchor, row, onSelect, onClose }: HomeMenuProps) {
  return (
    <Menu
      open={anchor !== null}
      anchor={anchor}
      label="More"
      entries={menuEntries(row)}
      onSelect={id => {
        if (id === 'bookmark' || id === 'trash') onSelect(id);
      }}
      onClose={onClose}
    />
  );
}
