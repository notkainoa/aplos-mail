import type { CalendarEvent, Draft } from '@aplos/contract/legacy/types';

// Platform-free validation for what a model proposes. Nothing here acts; it only decides what may be shown on a card.
const str = (value: unknown, max = 20000) => (typeof value === 'string' ? value.slice(0, max) : '');
export const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const dayPattern = /^\d{4}-\d{2}-\d{2}$/;
// V8 also "parses" phrases like "Friday at 11", so require real ISO 8601 before trusting Date.parse.
const timePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;
/** Local wall time with its UTC offset, e.g. 2026-10-20T09:15:00-07:00, so "Friday at 11am" resolves in the user's zone. */
export function localNow(timeZone?: string, date = new Date()) {
  let zone: string | undefined;
  try {
    if (timeZone) zone = new Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone;
  } catch {
    zone = undefined;
  }
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      weekday: 'long',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZoneName: 'longOffset',
    })
      .formatToParts(date)
      .map(p => [p.type, p.value]),
  );
  const offset = parts.timeZoneName === 'GMT' ? '+00:00' : parts.timeZoneName.slice(3);
  // Models are unreliable at weekday arithmetic, so spell out the next two weeks.
  // Step by calendar day, not 24 h, and give each day its own offset so dates past a daylight-saving change stay right.
  const offsetAt = (at: Date) => {
    const name =
      new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
        .formatToParts(at)
        .find(x => x.type === 'timeZoneName')?.value ?? 'GMT';
    return name === 'GMT' ? '+00:00' : name.slice(3);
  };
  const minutes = (offset: string) =>
    (offset[0] === '-' ? -1 : 1) * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6)));
  const upcoming = Array.from({ length: 14 }, (_, i) => {
    const noon = new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day + i + 1, 12));
    const local = new Date(+noon - minutes(offset) * 60000);
    return `${noon.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })} ${noon.toISOString().slice(0, 10)} ${offsetAt(local)}`;
  });
  return {
    now: `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`,
    weekday: parts.weekday,
    timeZone: zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    upcoming,
  };
}
/**
 * Each message's own week: the weekday it was sent and the seven dates after it, in the user's zone. "Friday" in a
 * Monday email is then a lookup rather than weekday arithmetic, which models get wrong now and then.
 */
export function messageWeek(sent: string, timeZone?: string) {
  let zone: string | undefined;
  try {
    if (timeZone) zone = new Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone;
  } catch {
    zone = undefined;
  }
  const at = new Date(sent);
  if (Number.isNaN(+at)) return;
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
  const label = (i: number) => {
    const noon = new Date(Date.parse(day + 'T12:00:00Z') + i * 86400000);
    return `${noon.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })} ${noon.toISOString().slice(0, 10)}`;
  };
  return { sentOn: label(0), following: Array.from({ length: 7 }, (_, i) => label(i + 1)) };
}
/** A model-proposed event, or nothing: titles are required, dates must parse, all-day dates are plain days and the end follows the start. */
export function calendarEvent(
  value: unknown,
  guest: (email: string) => boolean,
): Partial<CalendarEvent> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const e = value as Record<string, unknown>,
    allDay = e.allDay === true,
    start = str(e.start, 80),
    end = str(e.end, 80);
  if (
    !str(e.title).trim() ||
    Number.isNaN(Date.parse(start)) ||
    Number.isNaN(Date.parse(end)) ||
    Date.parse(end) <= Date.parse(start)
  )
    return;
  if (
    !(allDay
      ? dayPattern.test(start) && dayPattern.test(end)
      : timePattern.test(start) && timePattern.test(end))
  )
    return;
  // Date.parse rolls impossible days over (Feb 30 → Mar 2), so the calendar day itself must survive a round trip.
  const realDay = (value: string) => {
    const day = value.slice(0, 10);
    return new Date(day + 'T00:00:00Z').toISOString().slice(0, 10) === day;
  };
  if (!realDay(start) || !realDay(end)) return;
  return {
    title: str(e.title, 500).trim(),
    start,
    end,
    allDay,
    location: str(e.location, 1000),
    description: str(e.description, 4000),
    guests: Array.isArray(e.guests)
      ? [
          ...new Set(
            e.guests
              .filter(
                (x): x is string =>
                  typeof x === 'string' && emailPattern.test(x.trim()) && guest(x.trim()),
              )
              .map(x => x.trim()),
          ),
        ]
      : [],
  };
}
export function draftProposal(value: unknown): Partial<Draft> {
  if (!value || typeof value !== 'object') return {};
  const data = value as Record<string, unknown>,
    result: Partial<Draft> = {};
  for (const key of ['to', 'cc', 'bcc', 'subject', 'html'] as const)
    if (typeof data[key] === 'string') result[key] = str(data[key]);
  return result;
}
