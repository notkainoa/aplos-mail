/**
 * Later's groups (DESIGN 7.3): Overdue, Today, This week, Someday, taken from the `later` view's sections. Empty groups
 * do not render, except one that emptied under `hold`, which stays in place showing 0 until the hold releases so
 * nothing below it jumps (DESIGN 5 rule 6). Pure: no React, no engine.
 */
import type { WindowSection } from '../../data';

/** The group keys the engine documents for the `later` view, in display order. */
export type LaterGroupKey = 'overdue' | 'today' | 'week' | 'someday';

export const GROUP_ORDER: readonly LaterGroupKey[] = ['overdue', 'today', 'week', 'someday'];

/** Group labels follow the section-label rule (DESIGN 7.3). */
export const GROUP_LABEL: Readonly<Record<LaterGroupKey, string>> = {
  overdue: 'Overdue',
  today: 'Today',
  week: 'This week',
  someday: 'Someday',
};

/** One group as drawn. */
export interface LaterGroup {
  readonly key: LaterGroupKey;
  readonly label: string;
  /** The ids of this group inside the loaded window, in order. */
  readonly ids: readonly string[];
  /** Rows in the group across the whole view: the number beside the label. */
  readonly count: number;
  /** Emptied while a hold is active: shown at 0 until the hold releases. */
  readonly held: boolean;
}

function isGroupKey(key: string): key is LaterGroupKey {
  return GROUP_ORDER.some(known => known === key);
}

/**
 * The groups of a window. `ids` starts at index `position` of the whole view and each section says where it starts and
 * how many rows it has, so a group's ids are that span clipped to the window. A key a newer engine adds is ignored.
 */
export function groupsOf(
  ids: readonly string[],
  sections: readonly WindowSection[],
  position: number,
): LaterGroup[] {
  const known = sections.filter(section => isGroupKey(section.key) && section.count > 0);
  return GROUP_ORDER.flatMap(key => {
    const section = known.find(candidate => candidate.key === key);
    if (!section) return [];
    const from = Math.max(0, section.start - position);
    const to = Math.max(0, section.start + section.count - position);
    return [
      { key, label: GROUP_LABEL[key], ids: ids.slice(from, to), count: section.count, held: false },
    ];
  });
}

/**
 * While held, a group that was on screen and has emptied stays, at 0, in its place. Once the hold releases the engine's
 * groups are shown as they are.
 */
export function keepEmptied(
  previous: readonly LaterGroup[],
  next: readonly LaterGroup[],
  held: boolean,
): LaterGroup[] {
  if (!held) return [...next];
  return GROUP_ORDER.flatMap(key => {
    const now = next.find(group => group.key === key);
    if (now) return [now];
    const before = previous.find(group => group.key === key);
    return before ? [{ ...before, ids: [], count: 0, held: true }] : [];
  });
}

/** Every id across the groups, top to bottom: the cursor's stops. */
export function flatIds(groups: readonly LaterGroup[]): string[] {
  return groups.flatMap(group => group.ids);
}

/**
 * While a row is lifted every group Later offers as a drop target is on screen, even one with no rows, so there is
 * always somewhere to drop (DESIGN 7.3). Overdue is never a target, so it appears only when it has rows. The empty
 * zones show at 0, like a group emptied under a hold.
 */
export function withDropZones(groups: readonly LaterGroup[]): LaterGroup[] {
  return GROUP_ORDER.flatMap(key => {
    const present = groups.find(group => group.key === key);
    if (present) return [present];
    if (key === 'overdue') return [];
    return [{ key, label: GROUP_LABEL[key], ids: [], count: 0, held: true }];
  });
}
