/**
 * Home as DESIGN 7.2 draws it, from the `home` window: Do now (with Back from Later at its bottom), Important updates
 * and Follow up as lists, the Low band as a count with up to three names. A section emptied during a hold stays
 * visible at 0 until the hold releases (DESIGN 5 rule 6).
 */
import type { Id, ThreadId, ThreadRow, WindowSection } from './contract-shapes';
import type { HomeBlockView, HomeSectionView, HomeView, LowBandView, ViewResult } from './index';
import { sectionAt } from './optimistic';
import type { HomeSection } from './ui-types';

/** What the home window says about holds, beyond its `ViewResult`. */
export interface HomeHoldState {
  readonly held: boolean;
  /** Section keys that had rows when the hold began. */
  readonly sectionsAtHold: ReadonlySet<string>;
  /** Rows waiting to arrive per section key. */
  readonly waiting: (section: string) => number;
}

const LISTS: readonly HomeSection[] = ['do', 'update', 'follow'];

export function toHomeView(
  home: ViewResult<ThreadRow>,
  lowSendersTotal: number,
  hold: HomeHoldState,
): HomeView {
  const byKey = new Map<string, WindowSection>(home.sections.map(s => [s.key, s]));
  const idsOf = new Map<string, ThreadId[]>();
  home.ids.forEach((id, i) => {
    const key = sectionAt(home, i);
    if (!key) return;
    let list = idsOf.get(key);
    if (!list) idsOf.set(key, (list = []));
    list.push(id);
  });
  const visible = (key: string, count: number) =>
    count > 0 || (hold.held && hold.sectionsAtHold.has(key));

  let cursor = 0;
  const startOf = (key: string): number => {
    const s = byKey.get(key);
    return s ? s.start : cursor;
  };

  const sections: HomeSectionView[] = LISTS.map(key => {
    const own = byKey.get(key);
    let fromLater: HomeBlockView | null = null;
    let count = own?.count ?? 0;
    const start = startOf(key);
    if (own) cursor = own.start + own.count;
    if (key === 'do') {
      const block = byKey.get('fromLater');
      const blockCount = block?.count ?? 0;
      const blockStart = block ? block.start : cursor;
      if (block) cursor = block.start + block.count;
      count += blockCount;
      if (visible('fromLater', blockCount))
        fromLater = {
          key: 'fromLater',
          ids: idsOf.get('fromLater') ?? [],
          count: blockCount,
          start: blockStart,
          visible: true,
        };
    }
    return {
      key,
      ids: idsOf.get(key) ?? [],
      count,
      start: own ? start : key === 'do' && fromLater ? fromLater.start : start,
      visible: visible(key, own?.count ?? 0) || (key === 'do' && (count > 0 || fromLater !== null)),
      fromLater,
      waiting: hold.held ? hold.waiting(key) + (key === 'do' ? hold.waiting('fromLater') : 0) : 0,
    };
  });

  const lowSection = byKey.get('low');
  const names = lowSection?.senders ?? [];
  const low: LowBandView = {
    count: lowSection?.count ?? 0,
    names,
    moreSenders: Math.max(0, lowSendersTotal - names.length),
  };

  return {
    sections,
    low,
    rows: home.rows as ReadonlyMap<Id, ThreadRow>,
    failures: home.failures,
    total: home.total,
    state: home.state,
    status: home.status,
    error: home.error,
    move: home.move,
  };
}
