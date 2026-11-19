/**
 * Time zone and calendar-date arithmetic for the Calendar emulator. Recurring events repeat at the
 * same wall-clock time in their own zone, so every expansion goes through these helpers; adding
 * 7 x 24 h to an instant would drift by an hour at a DST change.
 */
const DAY_MS = 86_400_000;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let formatter = formatters.get(tz);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(tz, formatter);
  }
  return formatter;
}

/** True for names the platform's time zone database knows ('America/Los_Angeles', 'UTC'). */
export function isValidZone(tz: string): boolean {
  try {
    formatterFor(tz);
    return true;
  } catch {
    return false;
  }
}

export interface LocalParts {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

export function localParts(ms: number, tz: string): LocalParts {
  const parts: Record<string, number> = {};
  for (const part of formatterFor(tz).formatToParts(new Date(Math.floor(ms / 1000) * 1000))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return {
    y: parts.year,
    mo: parts.month,
    d: parts.day,
    h: parts.hour,
    mi: parts.minute,
    s: parts.second,
  };
}

/** Zone offset from UTC at an instant, in ms (negative west of Greenwich). */
export function offsetMs(ms: number, tz: string): number {
  const p = localParts(ms, tz);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant at which the zone's wall clock reads `p`. A time that happens twice (clocks going
 * back) resolves to the first; a time that never happens (clocks going forward) lands after the gap,
 * as Google does (02:30 becomes 03:30).
 */
export function localToUtc(p: LocalParts, tz: string): number {
  const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  const found: number[] = [];
  for (const off of new Set([offsetMs(asUtc - DAY_MS, tz), offsetMs(asUtc + DAY_MS, tz)])) {
    const candidate = asUtc - off;
    if (offsetMs(candidate, tz) === off) found.push(candidate);
  }
  return found.length ? Math.min(...found) : asUtc - offsetMs(asUtc - DAY_MS, tz);
}

const two = (n: number): string => String(n).padStart(2, '0');

/** RFC 3339 text for an instant as the zone shows it, e.g. 2026-11-02T10:00:00-08:00. */
export function isoInZone(ms: number, tz: string): string {
  const p = localParts(ms, tz);
  const offsetMinutes = Math.round(offsetMs(ms, tz) / 60_000);
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  const zone =
    tz === 'UTC' || tz === 'Etc/UTC' ? 'Z' : `${sign}${two(Math.floor(abs / 60))}:${two(abs % 60)}`;
  return `${p.y}-${two(p.mo)}-${two(p.d)}T${two(p.h)}:${two(p.mi)}:${two(p.s)}${zone}`;
}

const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export const isDateText = (value: unknown): value is string =>
  typeof value === 'string' && DATE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));

/** Parses RFC 3339; a value without an offset needs `tz`. Returns undefined when it is not valid. */
export function parseDateTime(value: unknown, tz?: string): number | undefined {
  if (typeof value !== 'string') return undefined;
  const m = DATE_TIME.exec(value);
  if (!m) return undefined;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 60) return undefined;
  if (m[7]) {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? undefined : ms;
  }
  return tz ? localToUtc({ y, mo, d, h, mi, s }, tz) : undefined;
}

// ---------- calendar dates as day numbers ----------

/** Days since 1970-01-01 for 'YYYY-MM-DD'. */
export const dayOf = (date: string): number => Math.floor(Date.parse(`${date}T00:00:00Z`) / DAY_MS);

export function dateOfDay(day: number): string {
  const d = new Date(day * DAY_MS);
  return `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}`;
}

/** 0 = Sunday. */
export const weekdayOfDay = (day: number): number => (((day + 4) % 7) + 7) % 7;

export function civilOfDay(day: number): { y: number; mo: number; d: number } {
  const d = new Date(day * DAY_MS);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

export const dayOfCivil = (y: number, mo: number, d: number): number =>
  Math.floor(Date.UTC(y, mo - 1, d) / DAY_MS);

export const daysInMonth = (y: number, mo: number): number =>
  new Date(Date.UTC(y, mo, 0)).getUTCDate();

/** Instance id suffix: UTC 'YYYYMMDDTHHMMSSZ' for timed occurrences, 'YYYYMMDD' for all-day ones. */
export function utcKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}T${two(d.getUTCHours())}${two(d.getUTCMinutes())}${two(d.getUTCSeconds())}Z`;
}

export const dateKey = (date: string): string => date.replaceAll('-', '');
