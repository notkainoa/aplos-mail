/**
 * Lane layout for one day column (DESIGN 7.8). Overlapping entries share the width. When more lanes are needed
 * than fit, the lanes that fit stay side by side (each at its own lane index) beside one "+N" stack that holds
 * the rest, so no lane is ever narrower than 44 px. If not even one lane plus the stack fits, everything folds
 * into the stack.
 */
import type { CalendarEventData, IsoDate } from '../props';
import { addDays, dayOf, hoursOf, isoOf } from './dates';

/** An entry with its time as hours since midnight on the column's day. */
export interface Timed {
  event: CalendarEventData;
  /** Start, hours since midnight. */
  at: number;
  /** End, hours since midnight (clamped to 24). */
  end: number;
}

export interface LaidItem extends Timed {
  lane: number;
  lanes: number;
  /** A lane of a folded cluster: `lanes` counts only the kept lanes, and they sit beside the "+N" stack. */
  beside: boolean;
}

export interface LaidStack {
  events: CalendarEventData[];
  at: number;
  end: number;
  /** No lane is kept beside it: the stack takes the whole column. */
  alone: boolean;
}

export interface DayLayout {
  items: LaidItem[];
  stacks: LaidStack[];
}

/** Lanes that fit side by side, the "+N" stack counting as one: two in a week column, six in a day column. */
export const MAX_LANES = { week: 2, day: 6 } as const;

/** Mirrors `--lane-min` in calendar.css (44 px): the narrowest a lane or the stack may be. */
export const LANE_MIN_PX = 44;

/** How many lanes (the "+N" stack included) a column of `width` px holds, capped at `cap`; at least 1. */
export function lanesFor(width: number, cap: number): number {
  if (!(width > 0)) return cap;
  return Math.max(1, Math.min(cap, Math.floor(width / LANE_MIN_PX)));
}

const EPS = 1e-6;

export function timedOn(event: CalendarEventData, day: IsoDate): Timed | null {
  if (event.allDay || dayOf(event.start) !== day) return null;
  const at = hoursOf(event.start);
  const sameDay = dayOf(event.end) === day;
  const end = sameDay ? hoursOf(event.end) : 24;
  return { event, at, end: Math.max(end, at) };
}

/** All-day entries that cover `day`. */
export function allDayOn(events: readonly CalendarEventData[], day: IsoDate): CalendarEventData[] {
  return events.filter(e => {
    if (!e.allDay) return false;
    const first = dayOf(e.start);
    const last = isoOf(new Date(new Date(e.end).getTime() - 60000));
    return first <= day && day <= (last < first ? first : last);
  });
}

/**
 * One row per all-day entry across the visible days, so a multi-day entry sits on the same row in every column it
 * covers and reads as one bar. Longest and earliest first; an entry takes the first row free on all its days.
 */
export function allDayRows(
  events: readonly CalendarEventData[],
  days: readonly IsoDate[],
): Map<string, number> {
  const covering = new Map<string, number[]>();
  days.forEach((day, i) => {
    for (const e of allDayOn(events, day)) covering.set(e.id, [...(covering.get(e.id) ?? []), i]);
  });
  const order = [...covering.entries()].sort(
    ([aId, a], [bId, b]) => b.length - a.length || a[0] - b[0] || aId.localeCompare(bId),
  );
  const taken: Array<Set<number>> = [];
  const rows = new Map<string, number>();
  for (const [id, span] of order) {
    let row = taken.findIndex(used => span.every(i => !used.has(i)));
    if (row < 0) {
      row = taken.length;
      taken.push(new Set());
    }
    for (const i of span) taken[row].add(i);
    rows.set(id, row);
  }
  return rows;
}

export function sortTimed<T extends Timed>(list: readonly T[]): T[] {
  return [...list].sort(
    (a, b) => a.at - b.at || b.end - b.at - (a.end - a.at) || a.event.id.localeCompare(b.event.id),
  );
}

export function layoutDay(timed: readonly Timed[], maxLanes: number): DayLayout {
  const list = sortTimed(timed);
  const out: DayLayout = { items: [], stacks: [] };
  let cluster: Array<Timed & { lane: number }> = [];
  let clusterEnd = -1;

  const flush = (): void => {
    if (cluster.length === 0) return;
    const laneEnds: number[] = [];
    for (const e of cluster) {
      let lane = laneEnds.findIndex(end => end <= e.at + EPS);
      if (lane < 0) {
        lane = laneEnds.length;
        laneEnds.push(0);
      }
      laneEnds[lane] = e.end;
      e.lane = lane;
    }
    const lanes = laneEnds.length;
    if (lanes <= maxLanes) {
      for (const e of cluster) out.items.push({ ...e, lane: e.lane, lanes, beside: false });
    } else {
      const keep = maxLanes - 1;
      const folded = cluster.filter(e => e.lane >= keep);
      for (const e of cluster.filter(e => e.lane < keep))
        out.items.push({ ...e, lane: e.lane, lanes: keep, beside: true });
      out.stacks.push({
        events: folded.map(e => e.event),
        at: Math.min(...folded.map(e => e.at)),
        end: Math.max(...folded.map(e => e.end)),
        alone: keep === 0,
      });
    }
    cluster = [];
    clusterEnd = -1;
  };

  for (const e of list) {
    if (e.at >= clusterEnd - EPS) flush();
    cluster.push({ ...e, lane: 0 });
    clusterEnd = Math.max(clusterEnd, e.end);
  }
  flush();
  return out;
}

/** Days shown for a view, in column order. */
export function daysOf(view: 'day' | 'week' | 'agenda', start: IsoDate): IsoDate[] {
  if (view === 'day') return [start];
  return [0, 1, 2, 3, 4, 5, 6].map(i => addDays(start, i));
}

/** Where a pointer move puts an entry or a new range: snapped start and end in hours, at least 15 minutes long. */
export function dragRange(
  kind: 'create' | 'move' | 'resize',
  origin: { at: number; end: number; pointer: number },
  pointer: number,
  step = 0.25,
): { at: number; end: number } {
  const snap = (h: number): number => Math.round(h / step) * step;
  const delta = snap(pointer) - snap(origin.pointer);
  if (kind === 'move') {
    const length = origin.end - origin.at;
    const at = Math.min(24 - length, Math.max(0, snap(origin.at + delta)));
    return { at, end: at + length };
  }
  if (kind === 'resize')
    return {
      at: origin.at,
      end: Math.min(24, Math.max(origin.at + step, snap(origin.end + delta))),
    };
  const a = snap(origin.pointer);
  const b = snap(pointer);
  const at = Math.max(0, Math.min(a, b));
  const end = Math.min(24, Math.max(a, b, at + step));
  return { at, end: end === at ? at + step : end };
}
