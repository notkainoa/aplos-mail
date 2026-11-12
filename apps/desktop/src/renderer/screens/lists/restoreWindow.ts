/**
 * Putting a list longer than one window back where it was: the saved row may be far outside the window a fresh view
 * opens on, so the window is moved to it first and the cursor lands once the window reaches it.
 */
import { useEffect, useRef } from 'react';
import type { ViewResult } from '../../data';
import type { ReturnPoint } from '../../shell';
import { LIST_WINDOW, rangeAround } from './listModel';

/** The part of a view this needs. */
type Window = Pick<ViewResult<unknown>, 'ids' | 'position' | 'total' | 'move'>;

/** True when the window holds the saved row's place (a point with no index has nothing to reach). */
export function windowReaches(
  point: ReturnPoint | null,
  view: Pick<Window, 'ids' | 'position' | 'total'>,
): boolean {
  if (point?.index === undefined) return true;
  const at = Math.min(point.index, Math.max(0, view.total - 1));
  return at >= view.position && at < view.position + view.ids.length;
}

/** Moves a window longer than one to the saved row, once. */
export function useRestoreWindow(view: Window, point: ReturnPoint | null): void {
  const moved = useRef(false);
  const { total, move } = view;
  const index = point?.index;
  useEffect(() => {
    if (moved.current || index === undefined || total <= LIST_WINDOW) return;
    moved.current = true;
    move(rangeAround(index, total));
  }, [index, total, move]);
}
