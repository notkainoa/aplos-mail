import type { CalendarEvent } from '@aplos/contract/legacy/types';

/** Date math for the calendar screen. All-day events use YYYY-MM-DD with an exclusive end, as Google does. */
const hour = 3600000;
const pad = (n: number) => String(n).padStart(2, '0');
export const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** Local calendar date (YYYY-MM-DD) of an ISO time or date. */
export const dayKey = (iso: string) => (iso.length === 10 ? iso : ymd(new Date(iso)));
export function addDays(day: string, n: number) {
  const d = new Date(day + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return ymd(d);
}
/** Value for a datetime-local input, in local time. */
export function localInput(iso: string) {
  const d = new Date(iso.length === 10 ? iso + 'T00:00:00' : iso);
  return `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** A sensible slot on a given day: the next whole hour today, otherwise 10 AM. */
export function slotOn(day: Date, now = new Date()) {
  const start = new Date(day);
  if (start.toDateString() === now.toDateString()) start.setHours(now.getHours() + 1, 0, 0, 0);
  else start.setHours(10, 0, 0, 0);
  return { start: start.toISOString(), end: new Date(+start + hour).toISOString() };
}

/** "2:00 PM – 3:00 PM", with the end date when the event crosses midnight. */
export function timeRange(event: Pick<CalendarEvent, 'start' | 'end' | 'allDay'>) {
  if (event.allDay) {
    const last = addDays(event.end.slice(0, 10), -1);
    return last > event.start.slice(0, 10)
      ? `All day · until ${new Date(last + 'T00:00:00').toLocaleDateString([], { month: 'short', day: 'numeric' })}`
      : 'All day';
  }
  if (dayKey(event.start) !== dayKey(event.end))
    return `${clock(event.start)} – ${new Date(event.end).toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${clock(event.end)}`;
  return `${clock(event.start)} – ${clock(event.end)}`;
}

/** A time without ":00" and, when asked, without AM/PM: "10", "9:30 AM". */
function compactClock(iso: string, period: boolean) {
  const d = new Date(iso);
  return new Intl.DateTimeFormat([], {
    hour: 'numeric',
    minute: d.getMinutes() ? '2-digit' : undefined,
  })
    .formatToParts(d)
    .filter(p => period || p.type !== 'dayPeriod')
    .map(p => p.value)
    .join('')
    .trim();
}
export const shortClock = (iso: string) => compactClock(iso, true);
/** "10 – 11 AM", "11:30 AM – 1 PM": the dense form for event blocks. */
export function shortRange(event: Pick<CalendarEvent, 'start' | 'end' | 'allDay'>) {
  if (event.allDay || dayKey(event.start) !== dayKey(event.end)) return timeRange(event);
  const period = (iso: string) =>
    new Intl.DateTimeFormat([], { hour: 'numeric' })
      .formatToParts(new Date(iso))
      .find(p => p.type === 'dayPeriod')?.value;
  return `${compactClock(event.start, period(event.start) !== period(event.end))} – ${compactClock(event.end, true)}`;
}

type Span = Pick<CalendarEvent, 'start' | 'end' | 'allDay'>;

/** Moving the start keeps the event's length, the way people expect from a calendar. */
export function moveStart<T extends Span>(event: T, next: string): T {
  if (event.allDay) {
    const days = Math.max(
      1,
      Math.round((+new Date(event.end) - +new Date(event.start)) / 86400000),
    );
    return { ...event, start: next, end: addDays(next, days) };
  }
  const length = +new Date(event.end) - +new Date(event.start);
  const start = new Date(next);
  return {
    ...event,
    start: start.toISOString(),
    end: new Date(+start + (length > 0 ? length : hour)).toISOString(),
  };
}

export function setAllDay<T extends Span>(event: T, allDay: boolean, now = new Date()): T {
  if (allDay === event.allDay) return event;
  if (allDay) {
    const first = dayKey(event.start);
    // An event ending exactly at midnight belongs to the day before.
    const last = ymd(new Date(+new Date(event.end) - 1));
    return { ...event, allDay, start: first, end: addDays(last < first ? first : last, 1) };
  }
  return { ...event, allDay, ...slotOn(new Date(event.start + 'T00:00:00'), now) };
}

export function parseGuests(text: string) {
  const guests = text
    .split(/[,;\s]+/)
    .map(x => x.trim())
    .filter(Boolean);
  return { guests, invalid: guests.filter(g => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(g)) };
}
