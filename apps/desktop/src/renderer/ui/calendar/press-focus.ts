/**
 * Where focus goes when the pointer presses inside the hours scroller. The scroller is a tab stop (keyboard users
 * reach it with Tab), which also makes it the nearest focusable ancestor of everything in it; left alone, a press on
 * the empty track, the hour gutter or an entry's padding would focus the scroller and the arrows would scroll the
 * hours instead of walking the entries. So an incidental press keeps focus on the grid root.
 */

/** What the decision reads about the pressed element. */
export interface PressTarget {
  closest(selector: string): unknown;
}

/** Elements that take focus themselves on a press (a button, a link, a field); the browser's default stays. */
const OWN_FOCUS = 'button, a[href], input, select, textarea, [contenteditable="true"]';

/** True when the press should be redirected to the grid root: not the scroller itself (its scrollbar) and not a control. */
export function redirectsToGrid(target: unknown, scroller: unknown): boolean {
  if (target === scroller) return false;
  // A target without `closest` (a text node, the document) is not a control.
  const control = (target as Partial<PressTarget>).closest?.(OWN_FOCUS);
  return !control;
}

/** The minimum of a mouse event this needs. */
export interface PressEvent {
  /** The mouse button; 0 is the primary one. Middle and right presses are left alone (autoscroll, context menu). */
  readonly button?: number;
  readonly target: unknown;
  readonly currentTarget: unknown;
  preventDefault(): void;
}

/** onMouseDown of the scroller: keeps focus (and the selection of nothing) on the grid root for an incidental press. */
export function keepGridFocus(e: PressEvent, grid: { focus(o?: FocusOptions): void } | null): void {
  if (!grid || (e.button ?? 0) !== 0 || !redirectsToGrid(e.target, e.currentTarget)) return;
  e.preventDefault();
  grid.focus({ preventScroll: true });
}
