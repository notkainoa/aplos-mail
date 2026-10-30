/**
 * The cursor as React state: one key (a thread id or the Low band), settled against the list on every render so a row
 * that leaves under it (Done, Later, a lane move) hands the cursor to its neighbour and a row that arrives never moves
 * it. Moving it is a state update on the keydown, so it commits in the same event.
 */
import { useCallback, useRef, useState } from 'react';
import { keyOf, settleCursor, type HomeItem } from './homeModel';

interface CursorState {
  readonly key: string | null;
  readonly items: readonly HomeItem[];
}

/** The list's identity: the same stops in the same order, so a new array of equal content changes nothing. */
function signatureOf(items: readonly HomeItem[]): string {
  return items
    .map(item => (item.kind === 'low' ? keyOf(item) : `${item.section}:${item.id}`))
    .join('|');
}

/** Returns the previous array while the content is equal, so the cursor settles only on a real change. */
function useStableItems(items: readonly HomeItem[]): readonly HomeItem[] {
  const signature = signatureOf(items);
  const last = useRef({ signature, items });
  if (last.current.signature !== signature) last.current = { signature, items };
  return last.current.items;
}

/** The cursor over `items`. */
export interface HomeCursor {
  /** The key under the cursor; null for an empty list. */
  readonly key: string | null;
  /** The list the key was settled against. */
  readonly items: readonly HomeItem[];
  /** Moves the cursor now. */
  setCursor(key: string | null): void;
}

export function useHomeCursor(source: readonly HomeItem[]): HomeCursor {
  const items = useStableItems(source);
  const [state, setState] = useState<CursorState>({ key: null, items });
  const key = settleCursor(state.items, items, state.key);
  if (state.items !== items || state.key !== key) setState({ key, items });
  const setCursor = useCallback((next: string | null) => {
    setState(current => ({ ...current, key: next }));
  }, []);
  return { key, items, setCursor };
}
