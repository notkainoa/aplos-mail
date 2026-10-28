/**
 * Occurrence keys: one string per original start, the same for an override, the instance it
 * replaces and Google's instance id. 'YYYYMMDDTHHMMSSZ' for an instant, 'YYYYMMDD' for an all-day
 * date, 'YYYYMMDDTHHMMSS' for a floating time.
 */
import { parseIcalValue, parseOffsetTime, utcKey, valueKey } from './time';
import type { EventTime } from './types';
import { fromWall } from './zone';

/**
 * The key of an EventTime or of a value text: an iCalendar DATE or DATE-TIME, or an RFC 3339 time
 * with an offset or fraction (Google's `originalStartTime.dateTime`). Throws RangeError on text
 * that is not a date.
 */
export function occurrenceKey(time: EventTime | string): string {
  if (typeof time !== 'string' && 'utc' in time) {
    if (!Number.isFinite(time.utc)) throw new RangeError(`${time.utc} is not an instant`);
    return utcKey(time.utc);
  }
  const text = typeof time === 'string' ? time : 'date' in time ? time.date : time.local;
  // Offsets are only meaningful in the bare-string form: a { local } reading carries its zone in `tzid`.
  const value =
    parseIcalValue(text) ?? (typeof time === 'string' ? parseOffsetTime(text) : undefined);
  if (!value) throw new RangeError(`'${text}' is not a date or date-time`);
  const tzid = typeof time === 'string' || 'date' in time ? undefined : time.tzid;
  // A zoned local time names an instant; everything else keeps its own form.
  return tzid && value.kind === 'local' ? utcKey(fromWall(value.wall, tzid)) : valueKey(value);
}

/**
 * Google Calendar's id for one instance of a recurring event: the master id, '_', and the
 * original start in UTC basic form, or the date for all-day events (proto-google §7). Google
 * events always have a zone, so a floating time has no Google id and throws RangeError.
 */
export function googleInstanceId(masterId: string, originalStart: EventTime | string): string {
  const key = occurrenceKey(originalStart);
  if (/^\d{8}T\d{6}$/.test(key))
    throw new RangeError(`a floating time (${key}) has no Google instance id; give its zone`);
  return `${masterId}_${key}`;
}
