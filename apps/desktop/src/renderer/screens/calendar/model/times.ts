/**
 * Writing times back (review1 1a, 1d and the series-scope move). A save writes `start` or `end` only when that instant
 * changed, and writes it the way the event already stores it: an instant stays `utc`, a wall-clock time stays
 * `floating` in its own zone, a date stays a date. So a title-only edit never rewrites times, and an edit never pins a
 * series' occurrences to UTC.
 *
 * "All events" (scope `series`) on a time change. Reading used here, pending a CONTRACT answer: an update with scope
 * `series` carries the series' own fields, as Google's events.patch on the recurring event does. Sending this
 * occurrence's absolute times would move the series' first start to this day. So when the series row (`seriesId`) is
 * in hand, the change targets it with its own start and end shifted by the same amount the occurrence moved; when it is
 * not, the occurrence's new times go out on the occurrence's id and the engine is trusted to shift the series by the
 * difference (the only form a window of occurrences can produce).
 */
import type { EventFields } from '@aplos/contract';
import type { EpochMs, Event, EventTime } from '../../../data';
import type { EventScope } from '../../../ui/props';
import { addDays, parseDate } from '../../../ui/calendar/dates';
import { msOf, zoneOffsetMs } from './period';
import { DAY_MS, pad } from './units';

/** Two event times are the same when they name the same instant (a date: the same day). */
export function sameInstant(a: EventTime, b: EventTime): boolean {
  if (a.type === 'date' || b.type === 'date') return a.type === b.type && a.date === (b as typeof a).date;
  return msOf(a) === msOf(b);
}

/** "2026-10-29T09:00" for the instant `ms` on the wall clock of `timeZone` (else this machine's zone). */
export function wallOf(ms: EpochMs, timeZone?: string, seconds = false): string {
  // The wall clock as UTC fields: this machine's offset, or the zone's.
  let offset = -new Date(ms).getTimezoneOffset() * 60_000;
  if (timeZone) {
    try {
      offset = zoneOffsetMs(ms, timeZone);
    } catch {
      // An unknown zone reads in this machine's zone, as `wallToMs` does.
    }
  }
  const at = new Date(ms + offset);
  const date = `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`;
  const time = `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}${seconds ? `:${pad(at.getUTCSeconds())}` : ''}`;
  return `${date}T${time}`;
}

const hasSeconds = (local: string): boolean => (local.split('T')[1] ?? '').split(':').length > 2;

/** The instant `ms` written the way `like` is written: `utc` stays `utc`, `floating` keeps its zone. */
export function timeLike(like: EventTime, ms: EpochMs): EventTime {
  if (like.type === 'floating')
    return {
      type: 'floating',
      local: wallOf(ms, like.timeZone, hasSeconds(like.local)),
      ...(like.timeZone ? { timeZone: like.timeZone } : {}),
    };
  return { type: 'utc', utc: ms };
}

/** A wall-clock string moved by `deltaMs` on its own clock (so a one-hour move stays one hour across a DST change). */
function shiftWall(local: string, deltaMs: number): string {
  const [date, time = '00:00'] = local.split('T');
  const { y, m, d } = parseDate(date);
  const [hh = 0, mm = 0, ss = 0] = time.split(':').map(Number);
  const at = new Date(Date.UTC(y, m - 1, d, hh, mm, ss) + deltaMs);
  const day = `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`;
  const clock = `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}`;
  return `${day}T${clock}${hasSeconds(local) ? `:${pad(at.getUTCSeconds())}` : ''}`;
}

/** `t` moved by `deltaMs`, in its own type and zone: an instant adds it, a wall-clock time moves its clock, a date whole days. */
export function shiftTime(t: EventTime, deltaMs: number): EventTime {
  if (t.type === 'utc') return { type: 'utc', utc: t.utc + deltaMs };
  if (t.type === 'date') return { type: 'date', date: addDays(t.date, Math.round(deltaMs / DAY_MS)) };
  return { ...t, local: shiftWall(t.local, deltaMs) };
}

/** A new time as the event stores it: a date as given, else the instant in the event's own type and zone. */
function written(like: EventTime, next: EventTime): EventTime {
  if (next.type === 'date' || like.type === 'date') return next;
  return timeLike(like, msOf(next));
}

/** The id and the `start` / `end` fields an update writes for new times; no field for a time that did not change. */
export function timeChange(
  event: Event,
  next: { readonly start: EventTime; readonly end: EventTime },
  scope: EventScope,
  series?: Event,
): { id: string; fields: Pick<Partial<EventFields>, 'start' | 'end'> } {
  const fields: Pick<Partial<EventFields>, 'start' | 'end'> = {};
  const startMoved = !sameInstant(next.start, event.start);
  const endMoved = !sameInstant(next.end, event.end);
  if (scope === 'series' && series && series.id !== event.id) {
    if (startMoved) fields.start = shiftTime(series.start, msOf(next.start) - msOf(event.start));
    if (endMoved) fields.end = shiftTime(series.end, msOf(next.end) - msOf(event.end));
    return { id: series.id, fields };
  }
  if (startMoved) fields.start = written(event.start, next.start);
  if (endMoved) fields.end = written(event.end, next.end);
  return { id: event.id, fields };
}
