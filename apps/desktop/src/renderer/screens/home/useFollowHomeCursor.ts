/**
 * Home's window follows the cursor like the lists' (`useFollowCursor`): the engine keeps one window of rows, so with
 * more rows than that the cursor asks for the window around itself as it nears the edge of the loaded rows. It reads
 * the `home` window through `useView` (the same watched window `useHome` reads), which says where the window sits.
 * A move is held back while the list is held: the window ignores its answer then, and it is asked again on release.
 */
import { useEffect } from 'react';
import { useView, type AccountId } from '../../data';
import { pageRequest } from './homeModel';

export function useFollowHomeCursor(
  accountId: AccountId | undefined,
  key: string | null,
  held: boolean,
): void {
  const view = useView({ kind: 'home' as const, ...(accountId ? { accountId } : {}) });
  const { ids, position, total, move } = view;
  const at = key === null ? -1 : ids.indexOf(key);
  const loaded = ids.length;
  useEffect(() => {
    if (held) return;
    const range = pageRequest({ position, loaded, total, at });
    if (range) move(range);
  }, [held, position, loaded, total, at, move]);
}
