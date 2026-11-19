/** Whether the shortcut sheet (`?`, DESIGN 8) is open. The shell mounts it once, in `ShortcutsHost`. */
import { useSyncExternalStore } from 'react';
import { createStore } from './store-core';

const shortcutsStore = createStore(false);

/** Opens the sheet; `?` and Settings → Help & about's Show shortcuts both call it. */
export function openShortcuts(): void {
  shortcutsStore.set(true);
}

export function closeShortcuts(): void {
  shortcutsStore.set(false);
}

export function useShortcutsOpen(): boolean {
  return useSyncExternalStore(shortcutsStore.subscribe, shortcutsStore.get, shortcutsStore.get);
}

/** The open flag now, for tests. */
export const getShortcutsOpenForTest = shortcutsStore.get;
