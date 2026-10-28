// Wall-clock arithmetic in an IANA time zone, over Intl.DateTimeFormat only (neutral: no libraries, no node:*).

const DAY_MS = 86_400_000;

export interface LocalTime {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 Sunday to 6 Saturday. */
  weekday: number;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string) {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      weekday: 'short',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(zone, f);
  }
  return f;
}

/** The zone the host runs in, or UTC when the runtime cannot say. */
export function defaultTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** `zone` when Intl knows it, else the host's own zone: a bad setting never breaks Later. */
export function usableZone(zone: string | undefined): string {
  if (!zone) return defaultTimeZone();
  try {
    formatter(zone);
    return zone;
  } catch {
    return defaultTimeZone();
  }
}

/** The wall-clock reading of the epoch-ms `at` in `zone`. */
export function localTime(at: number, zone: string): LocalTime {
  const get: Record<string, string> = {};
  for (const p of formatter(zone).formatToParts(new Date(at))) get[p.type] = p.value;
  return {
    year: Number(get.year),
    month: Number(get.month),
    day: Number(get.day),
    hour: Number(get.hour),
    minute: Number(get.minute),
    second: Number(get.second),
    weekday: WEEKDAYS[get.weekday] ?? 0,
  };
}

/** The zone's offset from UTC at `at`, in ms (negative west of Greenwich). */
export function offsetAt(at: number, zone: string): number {
  const l = localTime(at, zone);
  const wall = Date.UTC(l.year, l.month - 1, l.day, l.hour, l.minute, l.second);
  return wall - Math.floor(at / 1000) * 1000;
}

/**
 * The epoch ms of the wall time `year-month-day hour:minute` in `zone` (`day` may overflow the month). The offsets
 * a day either side of the guess bracket any one transition, and the earliest candidate that reads back as the same
 * wall time wins, so a repeated hour (fall back) is its first occurrence. A time the clock skips (spring forward)
 * lands the same distance after the gap, as calendars do.
 */
export function zonedEpoch(
  zone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute = 0,
): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const before = offsetAt(wall - DAY_MS, zone);
  const after = offsetAt(wall + DAY_MS, zone);
  const candidates = [...new Set([before, after])]
    .map(offset => wall - offset)
    .sort((a, b) => a - b);
  for (const at of candidates) if (offsetAt(at, zone) === wall - at) return at;
  return wall - before;
}
