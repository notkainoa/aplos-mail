import type { LayoutSection } from './specs';

/*
 * Holds (views-2, DESIGN section 5 rule 6): a row the owner is working on keeps its place in a window while the list
 * reshuffles around it, until it is released or the owner has been idle for `HOLD_LAPSE_MS`. Every `View/hold`,
 * `View/move` and `View/watch` with `holdIds` is an activity signal that pushes the lapse out.
 */

/** A hold lapses this long after the last activity signal. */
export const HOLD_LAPSE_MS = 2_000;
/** A window holds at most this many rows (a page is at most 200); the oldest holds are dropped first. */
export const HOLD_LIMIT = 200;

export interface Holds {
  ids: Set<string>;
  /** Epoch ms when the holds lapse; meaningful only while `ids` is not empty. */
  until: number;
}

export const newHolds = (): Holds => ({ ids: new Set(), until: 0 });

/** Records an activity signal: the holds now lapse `HOLD_LAPSE_MS` from `now`. */
export function touchHolds(holds: Holds, now: number): void {
  if (holds.ids.size) holds.until = now + HOLD_LAPSE_MS;
}

export function holdIds(holds: Holds, ids: readonly string[], now: number): void {
  for (const id of ids) holds.ids.add(id);
  for (const old of holds.ids) {
    if (holds.ids.size <= HOLD_LIMIT) break;
    holds.ids.delete(old);
  }
  touchHolds(holds, now);
}

/** Drops the given holds, or all when `ids` is absent. */
export function releaseHolds(holds: Holds, ids?: readonly string[]): void {
  if (ids) for (const id of ids) holds.ids.delete(id);
  else holds.ids.clear();
}

/** Lapses the holds when the owner has been idle long enough; true when it dropped any. */
export function lapseHolds(holds: Holds, now: number): boolean {
  if (!holds.ids.size || now < holds.until) return false;
  holds.ids.clear();
  return true;
}

/**
 * The fresh page with held rows put back at the slot they were last sent in, even if they left the view. Rows that are
 * not held fill the other slots in view order. `prev` is the last sent page, `limit` the window size.
 */
export function placeHeld(
  fresh: readonly string[],
  prev: readonly string[],
  held: ReadonlySet<string>,
  limit: number,
): { ids: string[]; kept: string[] } {
  const slots: [number, string][] = [];
  prev.forEach((id, slot) => held.has(id) && slots.push([slot, id]));
  if (!slots.length) return { ids: fresh.slice(0, limit), kept: [] };
  const kept = new Set(slots.map(s => s[1]));
  const rest = fresh.filter(id => !kept.has(id));
  const ids: string[] = [];
  let next = 0;
  for (const [slot, id] of slots) {
    while (ids.length < slot && next < rest.length) ids.push(rest[next++]);
    ids.push(id);
  }
  ids.push(...rest.slice(next));
  return { ids: ids.slice(0, limit), kept: [...kept] };
}

const holdsRows = (s: LayoutSection) => s.senders === undefined && s.count > 0;

/**
 * Makes room in `sections` for a row inserted at window index `index` that the view no longer holds (a departed held
 * row): the section it sits in grows by one and the later ones start one row further on.
 */
export function growSections(sections: LayoutSection[], index: number): LayoutSection[] {
  // A count-only band (Home's Low, the only section with `senders`) holds no rows of the window.
  const hit = sections.findIndex(
    s => holdsRows(s) && index >= s.start && index < s.start + s.count,
  );
  const at = hit >= 0 ? hit : sections.findLastIndex(holdsRows);
  return at < 0 ? sections : resize(sections, at, 1);
}

/**
 * Takes a row at view index `index` out of the section it sits in: that section shrinks by one and the later ones start
 * one row earlier. A section left empty stays until `withoutEmpty`, so a row put back in the same pass finds it.
 */
export function shrinkSections(sections: LayoutSection[], index: number): LayoutSection[] {
  const at = sections.findIndex(s => holdsRows(s) && index >= s.start && index < s.start + s.count);
  return at < 0 ? sections : resize(sections, at, -1);
}

export const withoutEmpty = (sections: LayoutSection[]) =>
  sections.filter(s => s.senders !== undefined || s.count > 0);

function resize(sections: LayoutSection[], at: number, by: 1 | -1): LayoutSection[] {
  return sections.map((s, i) => {
    if (i === at) return { ...s, count: s.count + by };
    return i > at ? { ...s, start: s.start + by } : s;
  });
}
