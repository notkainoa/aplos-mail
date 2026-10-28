/**
 * Lane layout for one day column (DESIGN 7.8). Overlapping entries share the width. When more lanes are needed
 * than fit (3 or more overlapping in a week column), the first lane stays and the rest fold into one "+N" stack,
 * so no lane is ever narrower than 44 px.
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
  /** The first lane of a folded cluster: it sits beside the "+N" stack. */
  beside: boolean;
}

export interface LaidStack {
  events: CalendarEventData[];
  at: number;
  end: number;
}

export interface DayLayout {
  items: LaidItem[];
  stacks: LaidStack[];
}

/** Lanes that fit side by side: two in a week column, six in a single wide day column. */
export const MAX_LANES = { week: 2, day: 6 } as const;

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
  return events.filter((e) => {
    if (!e.allDay) return false;
    const first = dayOf(e.start);
    const last = isoOf(new Date(new Date(e.end).getTime() - 60000));
    return first <= day && day <= (last < first ? first : last);
  });
}

export function sortTimed<T extends Timed>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => a.at - b.at || b.end - b.at - (a.end - a.at) || a.event.id.localeCompare(b.event.id));
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
      let lane = laneEnds.findIndex((end) => end <= e.at + EPS);
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
      const folded = cluster.filter((e) => e.lane >= keep);
      for (const e of cluster.filter((e) => e.lane < keep)) out.items.push({ ...e, lane: 0, lanes: 1, beside: true });
      out.stacks.push({
        events: folded.map((e) => e.event),
        at: Math.min(...folded.map((e) => e.at)),
        end: Math.max(...folded.map((e) => e.end)),
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
  return [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(start, i));
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
  if (kind === 'resize') return { at: origin.at, end: Math.min(24, Math.max(origin.at + step, snap(origin.end + delta))) };
  const a = snap(origin.pointer);
  const b = snap(pointer);
  const at = Math.max(0, Math.min(a, b));
  const end = Math.min(24, Math.max(a, b, at + step));
  return { at, end: end === at ? at + step : end };
}
