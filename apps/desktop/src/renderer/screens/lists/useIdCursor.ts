/**
 * The cursor as React state: one key (a row id), settled against the list on every render so a row that leaves under it
 * (Done, Restore, Move to Home) hands the cursor to its neighbour and a row that arrives never moves it. Moving it is a
 * state update on the keydown, so it commits in the same event.
 */
import { useCallback, useRef, useState } from 'react';
import { settleKey } from './listModel';

interface CursorState {
  readonly key: string | null;
  readonly ids: readonly string[];
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

export function useIdCursor(source: readonly string[]): IdCursor {
  const ids = useStableIds(source);
  const [state, setState] = useState<CursorState>({ key: null, ids });
  const key = settleKey(state.ids, ids, state.key);
  if (state.ids !== ids || state.key !== key) setState({ key, ids });
  const setCursor = useCallback((next: string | null) => {
    setState(current => ({ ...current, key: next }));
  }, []);
  return { key, ids, setCursor };
}
