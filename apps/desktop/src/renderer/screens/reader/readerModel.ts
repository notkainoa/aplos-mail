/**
 * The reader's pure decisions (DESIGN 7.5, 8): where J and K go in the list the reader was opened from, who gets the
 * cursor when a thread leaves, which buffered letters are worth keeping, and the ↑/↓ message cursor. No React and no
 * engine; the models in `./model` do the work and this file only gives them the reader's words.
 */
import type { CursorDirection } from './model/threadCursor';
import { moveCursor, positionOf, settleCursor } from './model/threadCursor';
import type { LetterState } from './model/letterBuffer';

/**
 * The thread J or K opens, or null when the cursor is at an end (it never wraps) or the list is empty. A thread that is
 * not in the list (opened from somewhere else) starts the walk at an end: J opens the first row, K the last.
 */
export function stepThread(
  ids: readonly string[],
  current: string | null,
  direction: CursorDirection,
): string | null {
  if (ids.length === 0) return null;
  if (current === null || !ids.includes(current)) {
    return (direction === 'next' ? ids[0] : ids[ids.length - 1]) ?? null;
  }
  const next = moveCursor({ ids, current }, direction).current;
  return next !== null && next !== current ? next : null;
}

/** What the reader remembers of the list while a thread is open: the ids it last saw the open thread in. */
export interface ListMemory {
  readonly ids: readonly string[];
  readonly open: string | null;
}

/** Nothing seen yet. */
export const NO_MEMORY: ListMemory = { ids: [], open: null };

/**
 * The list J, K and Done walk, and what to remember for the next call. While the open thread is in `ids` it is just
 * `ids`. When it has left (another device, a reclassification, a Done a moment ago) it is put back where it was, next to
 * the row that now fills its place, so the neighbour is chosen rather than the top row. A thread that was never in the
 * list gets no such place.
 */
export function walkList(
  memory: ListMemory,
  ids: readonly string[],
  open: string | null,
): { readonly walk: readonly string[]; readonly memory: ListMemory } {
  if (open === null || ids.includes(open)) return { walk: ids, memory: { ids, open } };
  if (memory.open !== open) return { walk: ids, memory: { ids, open } };
  const was = memory.ids.indexOf(open);
  if (was < 0) return { walk: ids, memory };
  return { walk: restoreAt(memory.ids, was, ids), memory };
}

/** `ids` with `open` (which sat at `was` in `before`) put back just before its nearest surviving successor, else after its predecessor. */
function restoreAt(
  before: readonly string[],
  was: number,
  ids: readonly string[],
): readonly string[] {
  const open = before[was] ?? '';
  const below = before.slice(was + 1).find(id => ids.includes(id));
  if (below !== undefined) return ids.flatMap(id => (id === below ? [open, id] : [id]));
  const above = before
    .slice(0, was)
    .reverse()
    .find(id => ids.includes(id));
  return ids.flatMap(id => (id === above ? [id, open] : [id]));
}

/** The thread to show once `current` has left the list (Done, Later, Trash); null when nothing is left. */
export function afterRemoval(ids: readonly string[], current: string): string | null {
  const rest = ids.filter(id => id !== current);
  return settleCursor({ ids, current }, rest).current;
}

/**
 * "1 of 16" for the pane header's crumb; null when the thread is not in the list. `crumbPlace` is the screen's call: it
 * counts a thread that is not in the list (Low importance mail, a deep link) as the list's first, so every reader
 * screen shows the same crumb.
 */
export function crumbPosition(
  ids: readonly string[],
  current: string | null,
): { readonly index: number; readonly of: number } | null {
  const at = positionOf({ ids, current });
  return at === null ? null : { index: at.index + 1, of: at.total };
}

export function crumbPlace(
  ids: readonly string[],
  current: string | null,
): { readonly index: number; readonly of: number } | null {
  if (current === null) return null;
  return crumbPosition(ids.includes(current) ? ids : [current, ...ids], current);
}

/**
 * Letters the buffer holds as ready that are neither on paper nor asked for. A letter is rendered only while it is one
 * of those two, so a held `ready` for any other would show a blank frame the next time it is wanted: evict them.
 */
export function staleReady(state: LetterState): string[] {
  return [...state.ready].filter(id => id !== state.shown && id !== state.wanted);
}

/** The next or previous message id for ↑/↓, stopping at the ends; the first when the cursor is unset or off the list. */
export function stepMessage(
  ids: readonly string[],
  cursor: string | null,
  direction: CursorDirection,
): string | null {
  if (ids.length === 0) return null;
  const at = cursor === null ? -1 : ids.indexOf(cursor);
  if (at < 0) return ids[0] ?? null;
  const delta = direction === 'next' ? 1 : -1;
  return ids[Math.max(0, Math.min(ids.length - 1, at + delta))] ?? null;
}
