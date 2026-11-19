/**
 * Date helpers for the calendar family. Pure functions, en-US, no Intl: the harness freezes the locale, and the
 * same strings must come out in node tests and in the renderer.
 *
 * Date-times are read with `new Date(iso)`, so an ISO string without an offset is local wall-clock time and one
 * with an offset is converted to the machine's zone. Dates ("2026-10-29") are parsed by hand, because
 * `new Date('2026-10-29')` is UTC midnight and would land on the wrong day west of Greenwich.
 */
import type { IsoDate, IsoDateTime, IsoTime, IsoYearMonth } from '../props';

export const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

export const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

const pad = (n: number): string => String(n).padStart(2, '0');

/** A calendar day as numbers; `m` is 1 to 12. */
export interface Ymd {
  y: number;
  m: number;
  d: number;
}

export function parseDate(iso: IsoDate): Ymd {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return { y, m, d };
}

/** Local midnight of an ISO date. */
export function dateOf(iso: IsoDate): Date {
  const { y, m, d } = parseDate(iso);
  return new Date(y, m - 1, d);
}

export function isoOf(date: Date): IsoDate {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function addDays(iso: IsoDate, days: number): IsoDate {
  const { y, m, d } = parseDate(iso);
  return isoOf(new Date(y, m - 1, d + days));
}

export function parseYearMonth(ym: IsoYearMonth): { y: number; m: number } {
  const [y, m] = ym.split('-').map(Number);
  return { y, m };
}

export function yearMonthOf(iso: IsoDate): IsoYearMonth {
  return iso.slice(0, 7);
}

export function shiftMonth(ym: IsoYearMonth, by: number): IsoYearMonth {
  const { y, m } = parseYearMonth(ym);
  const date = new Date(y, m - 1 + by, 1);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
}

export function monthTitle(ym: IsoYearMonth): string {
  const { y, m } = parseYearMonth(ym);
  return `${MONTHS[m - 1]} ${y}`;
}

/** "Thursday, October 29" */
export function longDay(iso: IsoDate): string {
  const date = dateOf(iso);
  return `${WEEKDAYS[date.getDay()]}, ${MONTHS[date.getMonth()]} ${date.getDate()}`;
}

/** "Thursday, October 29, 2026": the comma after the day is DESIGN 7.8's fix. */
export function dayTitle(iso: IsoDate): string {
  return `${longDay(iso)}, ${parseDate(iso).y}`;
}

/** "Thu" */
export function shortWeekday(iso: IsoDate): string {
  return WEEKDAYS[dateOf(iso).getDay()].slice(0, 3);
}

/** "Wed, Nov 4" */
export function shortDay(iso: IsoDate): string {
  const date = dateOf(iso);
  return `${WEEKDAYS[date.getDay()].slice(0, 3)}, ${MONTHS[date.getMonth()].slice(0, 3)} ${date.getDate()}`;
}

/** The calendar day an ISO date-time falls on, in local time. */
export function dayOf(at: IsoDateTime): IsoDate {
  return isoOf(new Date(at));
}

/** Hours since local midnight, e.g. 14.5 for 2:30 PM. */
export function hoursOf(at: IsoDateTime): number {
  const date = new Date(at);
  return date.getHours() + date.getMinutes() / 60;
}

export function minutesBetween(start: IsoDateTime, end: IsoDateTime): number {
  return Math.round((new Date(end).getTime() - new Date(start).getTime()) / 60000);
}

function meridiem(hour: number): string {
  return hour >= 12 ? 'PM' : 'AM';
}

function hour12(hour: number): number {
  return ((hour + 11) % 12) + 1;
}

/** "2:30 PM" */
export function timeOf(at: IsoDateTime): string {
  const date = new Date(at);
  return `${hour12(date.getHours())}:${pad(date.getMinutes())} ${meridiem(date.getHours())}`;
}

/** "14:30" to "2:30 PM" */
export function formatClock(time: IsoTime): string {
  const [h, m] = time.split(':').map(Number);
  return `${hour12(h)}:${pad(m)} ${meridiem(h)}`;
}

/** "11:00 AM – 12:00 PM", or "10:30 – 11:30 AM" when both ends share AM or PM. */
export function rangeOf(start: IsoDateTime, end: IsoDateTime): string {
  const a = new Date(start);
  const b = new Date(end);
  if (meridiem(a.getHours()) === meridiem(b.getHours())) {
    return `${hour12(a.getHours())}:${pad(a.getMinutes())} – ${hour12(b.getHours())}:${pad(b.getMinutes())} ${meridiem(b.getHours())}`;
  }
  return `${timeOf(start)} – ${timeOf(end)}`;
}

/** "8 AM", for the hour gutter. */
export function hourLabel(hour: number): string {
  return `${hour12(hour)} ${meridiem(hour)}`;
}

/** "2 h 45 min", "30 min", "3 h" */
export function durationText(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** Six weeks of days that cover a month, starting on the locale's first weekday. */
export function monthMatrix(ym: IsoYearMonth, weekStartsOn: 0 | 1): IsoDate[][] {
  const { y, m } = parseYearMonth(ym);
  const first = new Date(y, m - 1, 1);
  const lead = (first.getDay() - weekStartsOn + 7) % 7;
  const rows: IsoDate[][] = [];
  for (let w = 0; w < 6; w += 1) {
    const row: IsoDate[] = [];
    for (let d = 0; d < 7; d += 1) row.push(isoOf(new Date(y, m - 1, 1 - lead + w * 7 + d)));
    rows.push(row);
  }
  return rows;
}

/** Weekday indexes (0 Sunday) in column order. */
export function weekdayOrder(weekStartsOn: 0 | 1): number[] {
  return [0, 1, 2, 3, 4, 5, 6].map(i => (i + weekStartsOn) % 7);
}

/** Half-hour options "00:00" to "23:30", with `extra` added if it falls between. */
export function timeOptions(extra?: IsoTime): IsoTime[] {
  const out: IsoTime[] = [];
  for (let h = 0; h < 24; h += 1) for (const m of [0, 30]) out.push(`${pad(h)}:${pad(m)}`);
  if (extra && !out.includes(extra)) {
    out.push(extra);
    out.sort();
  }
  return out;
}

/** The grid draws the whole day, midnight to midnight, and scrolls (DESIGN 7.8). */
export const DAY_HOURS = 24;

/** The hour the grid opens at when nothing else says (DESIGN 7.8: 8 AM to 8 PM fits the pane at 56 px an hour). */
export const OPEN_HOUR = 8;

/** The earliest hour the grid opens at: the first hours of the night are never what you came for. */
export const OPEN_FLOOR = 7;
/** How far above now the grid opens when today is shown: ninety minutes of lead-in above the line. */
export const NOW_LEAD = 1.5;
/** A half hour of air above the first event, so its title is never against the edge. */
export const EVENT_LEAD = 0.5;

/**
 * The hour at the top of the grid when it opens: `override` if the screen gives one; else the earlier of
 * now minus ninety minutes (today shown) or 8 AM, and the first timed event of the days shown, so the day's first
 * event is in view. Never above 7 AM, and clamped to the day.
 */
export function openHour(opts: {
  today: boolean;
  nowHours: number;
  override?: number;
  firstEvent?: number;
}): number {
  const base = opts.today ? opts.nowHours - NOW_LEAD : OPEN_HOUR;
  const toward =
    opts.firstEvent === undefined ? base : Math.min(base, opts.firstEvent - EVENT_LEAD);
  const raw = opts.override ?? Math.max(OPEN_FLOOR, toward);
  return Math.min(DAY_HOURS, Math.max(0, Number.isFinite(raw) ? raw : OPEN_HOUR));
}

/** Snap a position in hours to a step of `stepMinutes`. */
export function snapHours(hours: number, stepMinutes = 15): number {
  const step = stepMinutes / 60;
  return Math.round(hours / step) * step;
}

/** Hours since midnight on `day` as an ISO date-time without an offset (local wall-clock). */
export function dateTimeAt(day: IsoDate, hours: number): IsoDateTime {
  const total = Math.round(hours * 60);
  const { y, m, d } = parseDate(day);
  const date = new Date(y, m - 1, d, 0, total);
  return `${isoOf(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}:00`;
}
