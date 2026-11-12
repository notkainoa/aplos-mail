/**
 * The hooks a surface uses to be put back where it was (see `store-return.ts`): `useReturnSource` to say what it holds
 * while it is mounted, `useReturnRestore` to read what it held the last time the reader closed over it, and
 * `useRestoreScroll` to put its scroll offset back once its rows are drawn.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { registerReturnSource, takeReturnPoint } from './store-return';
import type { ReturnPoint, ReturnReader } from './store-return';

/** The nearest ancestor of `el` that scrolls, or null. */
export function scrollParent(el: Element | null): HTMLElement | null {
  for (let node = el?.parentElement ?? null; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    const scrolls = overflowY === 'auto' || overflowY === 'scroll';
    if (scrolls && node.scrollHeight > node.clientHeight) return node;
  }
  return null;
}

/** The scroll offset of the scroller holding `el` (0 when it has none). */
export function scrollTopOf(el: Element | null): number {
  return scrollParent(el)?.scrollTop ?? 0;
}

/** While mounted, the surface answers `read` with what it holds when a thread opens over it. `read` may change every render. */
export function useReturnSource(key: string | undefined, read: ReturnReader): void {
  const latest = useRef(read);
  latest.current = read;
  useEffect(() => {
    if (key === undefined) return undefined;
    return registerReturnSource(key, () => latest.current());
  }, [key]);
}

/** The point this surface left when the reader opened over it, read once at mount; null on any other visit. */
export function useReturnRestore(key: string | undefined): ReturnPoint | null {
  const [point] = useState(() => (key === undefined ? null : takeReturnPoint(key)));
  return point;
}

/** Tries this many renders to reach the saved offset (rows may still be arriving) before leaving the scroll alone. */
const SCROLL_ATTEMPTS = 5;

/**
 * Puts the saved scroll offset back as soon as the cursor's row is drawn (before paint). The row decides when: a
 * surface whose rows arrive late waits for them. An offset the content is still too short for is tried again on the
 * next renders; once the cursor has moved on, or after a few tries, the owner's scroll is left alone.
 */
export function useRestoreScroll(
  point: ReturnPoint | null,
  rowId: string | null | undefined,
): void {
  const state = useRef<{ row: string | null; tries: number; done: boolean }>({
    row: null,
    tries: 0,
    done: false,
  });
  useLayoutEffect(() => {
    const now = state.current;
    if (now.done || point === null || !rowId) return;
    if (now.row !== null && now.row !== rowId) now.done = true;
    const scroller = now.done ? null : scrollParent(document.getElementById(rowId));
    if (scroller === null) return;
    scroller.scrollTop = point.scrollTop;
    now.row = rowId;
    now.tries += 1;
    now.done = scroller.scrollTop >= point.scrollTop - 1 || now.tries >= SCROLL_ATTEMPTS;
  });
}
