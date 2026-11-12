/**
 * The cursor as React state: one key (a thread id or the Low band), settled against the list on every render so a row
 * that leaves under it (Done, Later, a lane move) hands the cursor to its neighbour and a row that arrives never moves
 * it. Moving it is a state update on the keydown, so it commits in the same event.
 */
import { useCallback, useRef, useState } from 'react';
import { restoreKey, type ReturnPoint } from '../../shell';
import { keyOf, settleCursor, type HomeItem } from './homeModel';

interface CursorState {
  readonly key: string | null;
  readonly items: readonly HomeItem[];
  /** The place the reader closed over, until the rows are there to land it on. */
  readonly restore: ReturnPoint | null;
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

/** The key after a render: a pending return lands on its row once there are rows, and waits for them until then. */
function keyAfter(state: CursorState, items: readonly HomeItem[]): string | null {
  if (state.restore === null) return settleCursor(state.items, items, state.key);
  if (items.length === 0) return state.key;
  return restoreKey(state.restore, items.map(keyOf)) ?? settleCursor(state.items, items, state.key);
}

/**
 * `restore` (the point the reader closed over) puts the cursor back on its row, or on the nearest row still there when
 * that one left, as soon as Home has rows.
 */
export function useHomeCursor(
  source: readonly HomeItem[],
  restore: ReturnPoint | null = null,
): HomeCursor {
  const items = useStableItems(source);
  const [state, setState] = useState<CursorState>({
    key: restore?.cursorId ?? null,
    items,
    restore,
  });
  const key = keyAfter(state, items);
  const landed = state.restore !== null && items.length > 0;
  if (state.items !== items || state.key !== key || landed) {
    setState({ key, items, restore: landed ? null : state.restore });
  }
  const setCursor = useCallback((next: string | null) => {
    setState(current => ({ ...current, key: next, restore: null }));
  }, []);
  return { key, items, setCursor };
}
