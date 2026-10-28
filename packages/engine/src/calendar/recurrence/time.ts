/**
 * Calendar arithmetic on UTC `Date` fields only (setUTCFullYear avoids Date.UTC's two-digit years).
 * A "day" is a day number (0 = 1970-01-01); a "wall" time is a wall-clock reading in ms on that
 * day scale, with no zone.
 */

export const DAY_MS = 86_400_000;

export interface Civil {
  y: number;
  m: number;
  d: number;
}

/** Day number of a proleptic Gregorian date; month and day may overflow (month 13 is next January). */
export const dayFromCivil = (y: number, m: number, d: number): number =>
  new Date(0).setUTCFullYear(y, m - 1, d) / DAY_MS;

export function civilFromDay(day: number): Civil {
  const t = new Date(day * DAY_MS);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** 0 = Monday ... 6 = Sunday, the order RFC 5545 weeks use. */
export const weekdayOf = (day: number): number => (((day + 3) % 7) + 7) % 7;

export const daysInMonth = (y: number, m: number): number =>
  dayFromCivil(y, m + 1, 1) - dayFromCivil(y, m, 1);

export const dayOfWall = (wall: number): number => Math.floor(wall / DAY_MS);

/** 'YYYY-MM-DDTHH:MM:SS' (years 0 to 9999, the range iCalendar can write). */
export const isoLocal = (wall: number): string => new Date(wall).toISOString().slice(0, 19);

/** 'YYYY-MM-DD'. */
export const isoDate = (day: number): string => isoLocal(day * DAY_MS).slice(0, 10);

/** 'YYYYMMDDTHHMMSS', the floating form. */
export const wallKey = (wall: number): string => isoLocal(wall).replace(/[-:]/g, '');

/** 'YYYYMMDDTHHMMSSZ', the form Google appends to instance ids. */
export const utcKey = (ms: number): string => `${wallKey(ms)}Z`;

/** 'YYYYMMDD'. */
export const dateKey = (day: number): string => wallKey(day * DAY_MS).slice(0, 8);

/** A parsed iCalendar DATE or DATE-TIME value. */
export type IcalValue =
  { kind: 'date'; day: number } | { kind: 'utc'; ms: number } | { kind: 'local'; wall: number };

/** A value on the day scale whatever its kind (a UTC time reads as its UTC wall clock). */
export const valueMs = (v: IcalValue): number =>
  v.kind === 'date' ? v.day * DAY_MS : v.kind === 'utc' ? v.ms : v.wall;

/** The occurrence-key text of a value: 'YYYYMMDD', 'YYYYMMDDTHHMMSS' or 'YYYYMMDDTHHMMSSZ'. */
export const valueKey = (v: IcalValue): string =>
  v.kind === 'date' ? dateKey(v.day) : v.kind === 'utc' ? utcKey(v.ms) : wallKey(v.wall);

const VALUE = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/;

/**
 * Parses '20261025', '20261025T013000', '20261025T083000Z' and the ISO forms
 * '2026-10-25' / '2026-10-25T01:30:00(Z)'. Undefined when the text is not a real date and time.
 */
export function parseIcalValue(text: string): IcalValue | undefined {
  const compact = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}Z?)?$/i.test(text)
    ? text.replace(/[-:]/g, '')
    : text;
  const m = VALUE.exec(compact.toUpperCase());
  if (!m) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return undefined;
  const day = dayFromCivil(y, mo, d);
  if (m[4] === undefined) return { kind: 'date', day };
  const [h, mi, s] = [Number(m[4]), Number(m[5]), Number(m[6])];
  if (h > 23 || mi > 59 || s > 59) return undefined;
  const ms = day * DAY_MS + ((h * 60 + mi) * 60 + s) * 1000;
  return m[7] ? { kind: 'utc', ms } : { kind: 'local', wall: ms };
}

const OFFSET_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/i;

/**
 * An RFC 3339 time with an offset or fractional seconds, the form Google's `originalStartTime.dateTime`
 * and `Date#toISOString` use ('2026-11-01T01:30:00-08:00', '2026-11-01T09:30:00.000Z'), as a UTC
 * value. Fractions are dropped: occurrence keys have whole seconds. Undefined for any other text.
 */
export function parseOffsetTime(text: string): IcalValue | undefined {
  const m = OFFSET_TIME.exec(text);
  if (!m) return undefined;
  const local = parseIcalValue(`${m[1]}${m[2]}${m[3]}T${m[4]}${m[5]}${m[6]}`);
  if (local?.kind !== 'local') return undefined;
  const zone = m[7].toUpperCase();
  if (zone === 'Z') return { kind: 'utc', ms: local.wall };
  const [h, mi] = [Number(zone.slice(1, 3)), Number(zone.slice(4, 6))];
  if (h > 23 || mi > 59) return undefined;
  const offset = (h * 60 + mi) * 60_000 * (zone[0] === '-' ? -1 : 1);
  return { kind: 'utc', ms: local.wall - offset };
}
