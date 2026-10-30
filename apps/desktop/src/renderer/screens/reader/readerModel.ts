/**
 * The reader's pure decisions (DESIGN 7.5, 8): where J and K go in the list the reader was opened from, who gets the
 * cursor when a thread leaves, which buffered letters are worth keeping, and the ↑/↓ message cursor. No React and no
 * engine; the models in `./model` do the work and this file only gives them the reader's words.
 */
import type { CursorDirection } from './model/threadCursor';
import { moveCursor, positionOf, settleCursor } from './model/threadCursor';
import type { LetterState } from './model/letterBuffer';

/** The thread J or K opens, or null when the cursor is at an end (it never wraps) or the list is empty. */
export function stepThread(
  ids: readonly string[],
  current: string | null,
  direction: CursorDirection,
): string | null {
  const next = moveCursor({ ids, current }, direction).current;
  return next !== null && next !== current ? next : null;
}

/** The thread to show once `current` has left the list (Done, Later, Trash); null when nothing is left. */
export function afterRemoval(ids: readonly string[], current: string): string | null {
  const rest = ids.filter(id => id !== current);
  return settleCursor({ ids, current }, rest).current;
}

/** "1 of 16" for the pane header's crumb; null when the thread is not in the list. */
export function crumbPosition(
  ids: readonly string[],
  current: string | null,
): { readonly index: number; readonly of: number } | null {
  const at = positionOf({ ids, current });
  return at === null ? null : { index: at.index + 1, of: at.total };
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
