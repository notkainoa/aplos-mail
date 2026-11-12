/**
 * The cursor as React state: one key (a row id), settled against the list on every render so a row that leaves under it
 * (Done, Restore, Move to Home) hands the cursor to its neighbour and a row that arrives never moves it. Moving it is a
 * state update on the keydown, so it commits in the same event.
 */
import { useCallback, useRef, useState } from 'react';
import { restoreKey, type ReturnPoint } from '../../shell';
import { settleKey } from './listModel';

interface CursorState {
  readonly key: string | null;
  readonly ids: readonly string[];
  /** The place the reader closed over, until the rows are there to land it on. */
  readonly restore: ReturnPoint | null;
}

/** Returns the previous array while the content is equal, so the cursor settles only on a real change. */
function useStableIds(ids: readonly string[]): readonly string[] {
  const signature = ids.join('\u0000');
  const last = useRef({ signature, ids });
  if (last.current.signature !== signature) last.current = { signature, ids };
  return last.current.ids;
}

/** The cursor over `ids`. */
export interface IdCursor {
  /** The id under the cursor; null for an empty list. */
  readonly key: string | null;
  /** The list the key was settled against. */
  readonly ids: readonly string[];
  /** Moves the cursor now. */
  setCursor(key: string | null): void;
}

/** The key after a render: a pending return lands on its row once there are rows, and waits for them until then. */
function keyAfter(state: CursorState, ids: readonly string[], ready: boolean): string | null {
  if (state.restore === null) return settleKey(state.ids, ids, state.key);
  if (ids.length === 0 || !ready) return state.key;
  return restoreKey(state.restore, ids) ?? settleKey(state.ids, ids, state.key);
}

/**
 * `restore` (the point the reader closed over) puts the cursor back on its row, or on the nearest row still there when
 * that one left, as soon as the list has rows. `ready` is false while the window does not yet reach the saved row.
 */
export function useIdCursor(
  source: readonly string[],
  restore: ReturnPoint | null = null,
  ready = true,
): IdCursor {
  const ids = useStableIds(source);
  const [state, setState] = useState<CursorState>({ key: restore?.cursorId ?? null, ids, restore });
  const key = keyAfter(state, ids, ready);
  const landed = state.restore !== null && ids.length > 0 && ready;
  if (state.ids !== ids || state.key !== key || landed) {
    setState({ key, ids, restore: landed ? null : state.restore });
  }
  const setCursor = useCallback((next: string | null) => {
    setState(current => ({ ...current, key: next, restore: null }));
  }, []);
  return { key, ids, setCursor };
}
