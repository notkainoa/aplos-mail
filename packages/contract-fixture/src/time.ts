/** Wall-clock helpers in one IANA zone, through `Intl` only (no Node), for due bands, Later presets and demo events. */

const formats = new Map<string, Intl.DateTimeFormat>();
function format(zone: string) {
  let f = formats.get(zone);
  if (!f)
    formats.set(
      zone,
      (f = new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })),
    );
  return f;
}

/** The zone's offset from UTC at instant `ms`, in ms (negative west of Greenwich). */
export function zoneOffset(ms: number, zone: string): number {
  const p = Object.fromEntries(
    format(zone)
      .formatToParts(new Date(ms))
      .map(x => [x.type, x.value]),
  );
  const wall = Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour! % 24, +p.minute!, +p.second!);
  return Math.round((wall - Math.floor(ms / 1000) * 1000) / 60_000) * 60_000;
}

/** `YYYY-MM-DD` of instant `ms` in the zone. */
export function localDay(ms: number, zone: string): string {
  return new Date(ms + zoneOffset(ms, zone)).toISOString().slice(0, 10);
}

/** The instant of a wall-clock time on a local day. */
export function atLocal(day: string, hour: number, minute: number, zone: string): number {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const wall = Date.UTC(y, m - 1, d, hour, minute);
  const first = wall - zoneOffset(wall, zone);
  return wall - zoneOffset(first, zone);
}

export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** 0 Sunday to 6 Saturday. */
export function weekday(day: string): number {
  return new Date(`${day}T00:00:00Z`).getUTCDay();
}

/** Whole days from local `from` to local `to`. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** Home's due band (ARCH 8.2): 0 overdue or today, 1 tomorrow, 2 within 7 days, 3 later or undated. */
export function dueBand(dueDate: string | undefined, today: string): 0 | 1 | 2 | 3 {
  if (!dueDate) return 3;
  const days = daysBetween(today, dueDate);
  return days <= 0 ? 0 : days === 1 ? 1 : days <= 7 ? 2 : 3;
}
