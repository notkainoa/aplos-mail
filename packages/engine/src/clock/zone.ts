import { isKnownZone, toWall } from '../calendar/recurrence/zone';
import { DAY_MS, weekdayOf } from '../calendar/recurrence/time';

export { fromWall, toWall } from '../calendar/recurrence/zone';

const HOUR_MS = 3_600_000;

/** The zone the host runs in, or UTC when the runtime cannot say. The views lane defaults to the same zone. */
export function hostZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** `zone` when the runtime knows it, else the host's own zone: a bad setting never breaks Later or a reminder. */
export function usableZone(zone: string | undefined): string {
  return zone && isKnownZone(zone) ? zone : hostZone();
}

/** The local clock reading of an instant: days since 1970, the weekday (0 Sunday to 6) and whole hours into that day. */
export function localDayAndHour(
  at: number,
  zone: string,
): { day: number; weekday: number; hour: number } {
  const wall = toWall(at, zone);
  const day = Math.floor(wall / DAY_MS);
  // The recurrence helpers count Monday as 0.
  return {
    day,
    weekday: (weekdayOf(day) + 1) % 7,
    hour: Math.floor((wall - day * DAY_MS) / HOUR_MS),
  };
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string, key: string, options: Intl.DateTimeFormatOptions) {
  const id = `${zone}|${key}`;
  let f = formatters.get(id);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: zone, ...options });
    formatters.set(id, f);
  }
  return f;
}

const TIME = { hour: 'numeric', minute: '2-digit' } as const;
const DAY = { weekday: 'short', month: 'short', day: 'numeric' } as const;
/** Newer ICU puts a narrow no-break space before AM and PM. */
const plain = (text: string) => text.replace(/\s/g, ' ');

/**
 * "9:00 AM" for an instant on the same local day as `reference`, else "Mon, Oct 26, 9:00 AM": what "was due ..." says,
 * in the owner's zone.
 */
export function dueText(at: number, reference: number, zone: string): string {
  const time = plain(formatter(zone, 'time', TIME).format(at));
  if (localDayAndHour(at, zone).day === localDayAndHour(reference, zone).day) return time;
  return `${plain(formatter(zone, 'day', DAY).format(at))}, ${time}`;
}
