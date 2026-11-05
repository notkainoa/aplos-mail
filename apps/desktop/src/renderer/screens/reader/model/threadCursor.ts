/**
 * The reader's thread cursor: J and K step through an ordered list of thread ids that keeps changing under it —
 * mail arrives above, rows leave on Done or Restore. The cursor is a key (an id), never an index, so an arrival
 * can not move it. No React and no engine; callers pass the ids in.
 */

/** J or K. */
export type CursorDirection = 'next' | 'previous';

/** The cursor: the list it was last settled against and the id under it (null when the list is empty). */
export interface CursorState {
  readonly ids: readonly string[];
  readonly current: string | null;
}

/** Ids without repeats, first occurrence kept, so one thread can never be two rows. */
function unique(ids: readonly string[]): readonly string[] {
  return [...new Set(ids)];
}

function indexOfKey(ids: readonly string[], key: string | null): number {
  return key === null ? -1 : ids.indexOf(key);
}

/**
 * One J/K step. Stops at the ends and never wraps; a cursor that is null or off the list goes to the first row.
 * An empty list leaves `current` null.
 */
export function moveCursor(state: CursorState, direction: CursorDirection): CursorState {
  const ids = unique(state.ids);
  if (ids.length === 0) return { ids, current: null };
  const at = indexOfKey(ids, state.current);
  const delta = direction === 'next' ? 1 : -1;
  const row = at < 0 ? 0 : Math.max(0, Math.min(ids.length - 1, at + delta));
  return { ids, current: ids[row] ?? null };
}

/** The surviving row nearest to `was` in the old order: below first, then above. */
function survivingNeighbour(
  before: readonly string[],
  was: number,
  ids: readonly string[],
): string | null {
  for (let at = was + 1; at < before.length; at++) {
    const id = before[at];
    if (id !== undefined && ids.includes(id)) return id;
  }
  for (let at = was - 1; at >= 0; at--) {
    const id = before[at];
    if (id !== undefined && ids.includes(id)) return id;
  }
  return null;
}

/**
 * The cursor after the list changed. An id still in the list stays, wherever it moved to. One that vanished hands
 * the cursor to the nearest surviving row that was below it in the old order, then the nearest above, then the
 * first row. A null cursor takes the first row. `current` is null only for an empty list.
 */
export function settleCursor(prev: CursorState, nextIds: readonly string[]): CursorState {
  const ids = unique(nextIds);
  if (ids.length === 0) return { ids, current: null };
  if (prev.current === null) return { ids, current: ids[0] ?? null };
  if (ids.includes(prev.current)) return { ids, current: prev.current };
  const before = unique(prev.ids);
  const was = before.indexOf(prev.current);
  const current = was < 0 ? null : survivingNeighbour(before, was, ids);
  return { ids, current: current ?? ids[0] ?? null };
}

/**
 * The cursor's 0-based index and the list's length, for a "n of total" line (the caller adds 1). Null when there
 * is no cursor or it is off the list.
 */
export function positionOf(
  state: CursorState,
): { readonly index: number; readonly total: number } | null {
  const ids = unique(state.ids);
  const index = indexOfKey(ids, state.current);
  return index < 0 ? null : { index, total: ids.length };
}
