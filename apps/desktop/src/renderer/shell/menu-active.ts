/**
 * The active row of a shell menu. The ui Menu is controlled (`activeId` / `onActiveChange`): arrows move the id and
 * Return chooses it, so a menu that does not pass them cannot be driven from the keyboard. This keeps the id for the
 * shell's two menus: the first enabled row until the owner moves, and again on every open.
 */
import { useState } from 'react';
import type { MenuEntry } from '../ui/props';

type ItemEntry = Extract<MenuEntry, { kind: 'item' }>;

function enabledItems(entries: readonly MenuEntry[]): ItemEntry[] {
  return entries.filter((entry): entry is ItemEntry => entry.kind === 'item' && !entry.disabled);
}

/** The id of the first row that can be chosen, or undefined when none can. */
export function firstEnabledId(entries: readonly MenuEntry[]): string | undefined {
  return enabledItems(entries)[0]?.id;
}

/** The active id to render: the one the owner moved to while it is still a chooseable row, else the first enabled row. */
export function resolveActive(
  entries: readonly MenuEntry[],
  moved: string | undefined,
): string | undefined {
  const items = enabledItems(entries);
  return items.find(item => item.id === moved)?.id ?? items[0]?.id;
}

/** The `activeId` and `onActiveChange` to pass a Menu, plus `reset` to call when it closes so the next open starts at the top. */
export function useMenuActive(entries: readonly MenuEntry[]) {
  const [moved, setMoved] = useState<string | undefined>(undefined);
  return {
    activeId: resolveActive(entries, moved),
    onActiveChange: setMoved,
    reset: () => setMoved(undefined),
  };
}
