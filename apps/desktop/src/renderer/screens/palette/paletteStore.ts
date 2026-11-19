/**
 * The palette's one state, outside React so the container, the tests and Search's `>` handoff all reach the same
 * palette. Pure transitions live in `palette.model.ts`; this file holds the current value plus the pending open
 * request (`requestPaletteOpen`) that Search's `>` writes and the shell's overlay slot honours (REQUESTS.md).
 * `PaletteHost` is props-in on `open`, so the store's `open` flag only tracks what the host shows; the host sets it.
 */
import { useSyncExternalStore } from 'react';
import { closedPalette, openPalette, type PaletteState } from './palette.model';

let current: PaletteState = closedPalette;
const listeners = new Set<() => void>();
const openListeners = new Set<(query: string) => void>();
let pendingQuery: string | null = null;

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
};

/**
 * Search's `>` asks for the palette with `query` already typed. Subscribers (the shell's overlay slot, or the dev
 * harness) open it; `PaletteHost` then seeds its field from `consumePaletteQuery` when `open` turns true.
 */
export function requestPaletteOpen(query = ''): void {
  pendingQuery = query;
  for (const listener of openListeners) listener(query);
}

/** The query the last `requestPaletteOpen` asked for, once; null afterwards. */
export function consumePaletteQuery(): string | null {
  const query = pendingQuery;
  pendingQuery = null;
  return query;
}

/** Listens for `requestPaletteOpen` (Search's `>`); returns the unlisten. */
export function onPaletteOpenRequest(listener: (query: string) => void): () => void {
  openListeners.add(listener);
  return () => openListeners.delete(listener);
}

/** The mounted host's view of the state. */
export function usePaletteState(): PaletteState {
  return useSyncExternalStore(paletteStore.subscribe, paletteStore.get, paletteStore.get);
}

/** For tests and the harness: a fresh palette. */
export function resetPaletteStore(query = ''): void {
  pendingQuery = null;
  paletteStore.set(query === '' ? closedPalette : openPalette(query));
}
