/**
 * The palette's one state, outside React so ⌘K (the registry's `app.palette`), Search's `>` and the container all
 * reach the same palette. Pure transitions live in `palette.model.ts`; this file only holds the current value.
 */
import { useSyncExternalStore } from 'react';
import { closedPalette, openPalette, togglePalette, type PaletteState } from './palette.model';

let current: PaletteState = closedPalette;
const listeners = new Set<() => void>();

export const paletteStore = {
  get: (): PaletteState => current,
  set(next: PaletteState): void {
    if (next === current) return;
    current = next;
    for (const listener of listeners) listener();
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  /** Opens with a query (Search's `>`), or empty. */
  open(query = ''): void {
    paletteStore.set(openPalette(query));
  },
  /** ⌘K. */
  toggle(): void {
    paletteStore.set(togglePalette(current));
  },
};

export function usePaletteState(): PaletteState {
  return useSyncExternalStore(paletteStore.subscribe, paletteStore.get, paletteStore.get);
}
