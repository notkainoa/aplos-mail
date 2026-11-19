/**
 * What Do now holds, read off the `home` view for the one-by-one walk: the ids in Home's order when the walk starts,
 * and the set of ids it holds right now (`live`). Do now is the `do` section plus Back from Later (DESIGN 7.2).
 */
import type { HomeView, ThreadId } from '../../data';
import { orderLayout, type RowOf } from './homeModel';

/** The ids in Do now as the view reports them: the new items and the Back from Later block under them. */
export interface DoNowIds {
  readonly do: readonly ThreadId[];
  readonly fromLater: readonly ThreadId[];
}

/** Do now's ids in the `home` view. */
export function doNowIdsOf(home: Pick<HomeView, 'sections'>): DoNowIds {
  const section = home.sections.find(candidate => candidate.key === 'do');
  return { do: section?.ids ?? [], fromLater: section?.fromLater?.ids ?? [] };
}

/** Do now in the order Home shows it: the new items, then Back from Later, each by DESIGN 7.2's order. */
export function doNowQueue(ids: DoNowIds, rowOf: RowOf): ThreadId[] {
  const layout = { ...ids, update: [], follow: [], lowCount: 0 };
  const ordered = orderLayout(layout, rowOf, false);
  return [...ordered.do, ...ordered.fromLater];
}

/** The ids Do now holds right now. */
export function liveDoNow(ids: DoNowIds): ReadonlySet<ThreadId> {
  return new Set([...ids.do, ...ids.fromLater]);
}

/** The threads whose last write was rejected. */
export function failedIds(home: Pick<HomeView, 'failures'>): ReadonlySet<ThreadId> {
  return new Set(home.failures.keys());
}
