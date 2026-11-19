/**
 * Home's window follows the cursor like the lists' (`useFollowCursor`): the engine keeps one window of rows, so with
 * more rows than that the cursor asks for the window around itself as it nears the edge of the loaded rows. It reads
 * the `home` window through `useView` (the same watched window `useHome` reads), which says where the window sits.
 * A move is held back while the list is held: the window ignores its answer then, and it is asked again on release.
 * The Low importance sheet follows its own window the same way (`useFollowWindow`).
 */
import { useEffect } from 'react';
import { useView, type AccountId, type ViewResult } from '../../data';
import { pageRequest } from './homeModel';

/** Asks for the window around `key` when it nears the edge of the loaded rows of a view longer than one window. */
export function useFollowWindow(
  view: Pick<ViewResult<unknown>, 'ids' | 'position' | 'total' | 'move'>,
  key: string | null,
  held: boolean,
): void {
  const { ids, position, total, move } = view;
  const at = key === null ? -1 : ids.indexOf(key);
  const loaded = ids.length;
  useEffect(() => {
    if (held) return;
    const range = pageRequest({ position, loaded, total, at });
    if (range) move(range);
  }, [held, position, loaded, total, at, move]);
}

export function useFollowHomeCursor(
  accountId: AccountId | undefined,
  key: string | null,
  held: boolean,
): void {
  const view = useView({ kind: 'home' as const, ...(accountId ? { accountId } : {}) });
  useFollowWindow(view, key, held);
}
