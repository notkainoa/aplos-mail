import type { Event, EventFields, EventTime } from '@aplos/contract';
import { addDays, zoneOffset } from './time';

// The stand-in's rule for `Event/set { update, id: <occurrence>, scope: 'series' }` (DECISIONS 2026-11-04, "Event/set
// with an occurrence id and scope series"): `fields` describe the occurrence the owner sees. The text fields copy to the
// whole series; `start` and `end` apply as a wall-clock shift in the series' zone, never as a literal copy, and every
// occurrence follows.

const DAY = 86_400_000;

/** A time as milliseconds on the zone's wall clock (a day is its midnight). */
export function wallOf(t: EventTime, zone: string): number {
  if (t.type === 'date') return Date.parse(`${t.date}T00:00:00Z`);
  if (t.type === 'floating') return Date.parse(`${t.local.slice(0, 19)}Z`);
  return t.utc + zoneOffset(t.utc, zone);
}

/** `t` moved by `delta` ms of wall-clock time on the zone's clock; the same kind of time comes back. */
export function shiftTime(t: EventTime, delta: number, zone: string): EventTime {
  if (delta === 0) return t;
  if (t.type === 'date') return { type: 'date', date: addDays(t.date, Math.round(delta / DAY)) };
  if (t.type === 'floating') {
    const wall = new Date(Date.parse(`${t.local.slice(0, 19)}Z`) + delta).toISOString();
    return { ...t, local: wall.slice(0, t.local.length >= 19 ? 19 : 16) };
  }
  const target = t.utc + zoneOffset(t.utc, zone) + delta;
  const first = target - zoneOffset(target, zone);
  return { type: 'utc', utc: target - zoneOffset(first, zone) };
}

/** The stored rows of the series an event is part of: its master, every occurrence, and the event itself. */
export function seriesOf(rows: readonly Event[], event: Event): Event[] {
  const sid = event.seriesId ?? event.id;
  return rows.filter(e => e.id === sid || e.seriesId === sid || e.id === event.id);
}

/** What an event row follows a series change with: the fields of the change, `start` and `end` shifted. */
export interface SeriesPatch {
  row: Event;
  fields: Partial<EventFields>;
  /** The row's `originalStart` moved the same way as its start; absent when the row has none. */
  originalStart?: EventTime;
}

/**
 * The patches for every row of the series after a `series` update named by an occurrence: the text fields as given,
 * `start` and `end` moved by the difference between the new value and the occurrence's current one. A row gets no
 * start or end in its patch when that difference is zero. The caller merges each patch into its row.
 */
export function seriesPatches(
  rows: readonly Event[],
  event: Event,
  fields: Partial<EventFields>,
  zone: string,
): SeriesPatch[] {
  const startDelta = fields.start ? wallOf(fields.start, zone) - wallOf(event.start, zone) : 0;
  const endDelta = fields.end ? wallOf(fields.end, zone) - wallOf(event.end, zone) : 0;
  const { start: _start, end: _end, ...text } = fields;
  return seriesOf(rows, event).map(row => ({
    row,
    fields: {
      ...text,
      ...(startDelta ? { start: shiftTime(row.start, startDelta, zone) } : {}),
      ...(endDelta ? { end: shiftTime(row.end, endDelta, zone) } : {}),
    },
    ...(startDelta && row.originalStart
      ? { originalStart: shiftTime(row.originalStart, startDelta, zone) }
      : {}),
  }));
}
