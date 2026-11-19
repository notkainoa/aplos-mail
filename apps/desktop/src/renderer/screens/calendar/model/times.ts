/**
 * Writing times back (review1 1a, 1d and the series-scope move). A save writes `start` or `end` only when that instant
 * changed, and writes it the way the event already stores it: an instant stays `utc`, a wall-clock time stays
 * `floating` in its own zone, a date stays a date. So a title-only edit never rewrites times, and an edit never pins a
 * series' occurrences to UTC.
 *
 * "All events" (scope `series`) on a time change, DECIDED by the engine (DECISIONS 2026-11-04): the update carries
 * the occurrence id and the fields the user sees — the dragged occurrence's new absolute start and end — and the
 * ENGINE maps them to the master as a wall-clock shift in the series' zone. The UI never computes the master's
 * times, so the write is the same whatever the scope; the optimistic overlay mirrors the shift on every loaded
 * occurrence of the series (`wallDeltaMs` + `shiftInZone` below).
 */
import type { EventFields } from '@aplos/contract';
import type { EpochMs, Event, EventTime } from '../../../data';
import { addDays, parseDate } from '../../../ui/calendar/dates';
import { msOf, wallToMs, zoneOffsetMs } from './period';
import { DAY_MS, pad } from './units';

/** Two event times are the same when they name the same instant (a date: the same day). */
export function sameInstant(a: EventTime, b: EventTime): boolean {
  if (a.type === 'date' || b.type === 'date')
    return a.type === 'date' && b.type === 'date' && a.date === b.date;
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

/** This machine's IANA zone: the stamp a floating write needs when neither the time nor its event carries one. */
export function localZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * The instant `ms` written the way `like` is written: `utc` stays `utc`, `floating` keeps its zone — and
 * a floating time never leaves without one (Google refuses `event.timeZoneRequired`): a zone-less
 * `floating` gains `fallbackZone` (the event's zone, else the write's), else this machine's zone,
 * the same zone its `local` was always read in.
 */
export function timeLike(like: EventTime, ms: EpochMs, fallbackZone?: string): EventTime {
  if (like.type === 'floating') {
    const zone = like.timeZone ?? fallbackZone ?? localZone();
    return {
      type: 'floating',
      local: wallOf(ms, zone, hasSeconds(like.local)),
      timeZone: zone,
    };
  }
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
  if (t.type === 'date')
    return { type: 'date', date: addDays(t.date, Math.round(deltaMs / DAY_MS)) };
  return { ...t, local: shiftWall(t.local, deltaMs) };
}

/** A wall-clock string ("2026-10-29T11:00") as naive UTC ms, so two wall times give a wall-clock distance. */
function naiveMs(local: string): EpochMs {
  const [date, time = '00:00'] = local.split('T');
  const { y, m, d } = parseDate(date);
  const [hh = 0, mm = 0, ss = 0] = time.split(':').map(Number);
  return Date.UTC(y, m - 1, d, hh, mm, ss);
}

/**
 * The wall-clock distance `before` → `after` read on the `timeZone` clock (else the machine's): the amount a drag
 * moved the event, so a move that crosses a DST change is the move the user made, not the instants' distance.
 */
export function wallDeltaMs(before: EventTime, after: EventTime, timeZone?: string): EpochMs {
  const wall = (t: EventTime): string =>
    t.type === 'date' ? `${t.date}T00:00` : wallOf(msOf(t), timeZone, true);
  return naiveMs(wall(after)) - naiveMs(wall(before));
}

/**
 * `t` moved by `deltaMs` on the `timeZone` wall clock (else the machine's): like `shiftTime` for floating and date,
 * but an instant converts to the zone's wall time, shifts, and converts back — so "All events" keeps every
 * occurrence at its local hour across a DST change, never just adding the milliseconds.
 */
export function shiftInZone(t: EventTime, deltaMs: number, timeZone?: string): EventTime {
  if (t.type !== 'utc') return shiftTime(t, deltaMs);
  const local = shiftWall(wallOf(t.utc, timeZone, true), deltaMs);
  return { type: 'utc', utc: wallToMs(local, timeZone) };
}

/** A new time as the event stores it: a date as given, else the instant in the event's own type and zone. */
function written(like: EventTime, next: EventTime, fallbackZone?: string): EventTime {
  if (next.type === 'date' || like.type === 'date') return next;
  return timeLike(like, msOf(next), fallbackZone);
}

/**
 * The id and the `start` / `end` fields an update writes for new times; no field for a time that did not change.
 * The scope no longer shapes the write: under `series` the engine maps the occurrence's own new times to a
 * wall-clock shift of the master (DECISIONS 2026-11-04), so the fields are always the ones the user sees.
 * A floating time with no zone of its own is stamped in the event's, else `zone` (the write's zone).
 */
export function timeChange(
  event: Event,
  next: { readonly start: EventTime; readonly end: EventTime },
  zone?: string,
): { id: string; fields: Pick<Partial<EventFields>, 'start' | 'end'> } {
  const fields: Pick<Partial<EventFields>, 'start' | 'end'> = {};
  const fallback = event.timeZone ?? zone;
  if (!sameInstant(next.start, event.start))
    fields.start = written(event.start, next.start, fallback);
  if (!sameInstant(next.end, event.end)) fields.end = written(event.end, next.end, fallback);
  return { id: event.id, fields };
}
