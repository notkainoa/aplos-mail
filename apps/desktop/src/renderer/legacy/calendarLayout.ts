import type { Account, CalendarEvent, CalendarInfo } from '@aplos/contract/legacy/types';
import { addDays, ymd } from './calendarTime';

/** Layout for the Calendar page: one combined list of calendars, which events show, and where they sit. */
export type CalendarView = 'day' | 'week' | 'month';
export interface CalendarSource extends CalendarInfo {
  color: string;
  key: string;
}

export const calendarKey = (accountId: string, calendarId: string) => `${accountId}/${calendarId}`;
const palette = [
  '#5b7fa6',
  '#8a74b0',
  '#4f9488',
  '#c07a5a',
  '#bf9638',
  '#5f9a62',
  '#b0657f',
  '#6f8fb3',
];
const validColor = (value?: string) => !!value && /^#[0-9a-f]{6}$/i.test(value);
const hash = (text: string) => [...text].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

/** A readable name for a calendar that is only known from its events (a CalDAV path or a Google ID). */
function nameFromId(id: string) {
  if (id === 'primary') return 'Calendar';
  const tail = id.replace(/\/+$/, '').split('/').pop() ?? '';
  try {
    const name = decodeURIComponent(tail).split('@')[0];
    return name && name.length < 40 && !/^[0-9a-f-]{16,}$/i.test(name) ? name : 'Calendar';
  } catch {
    return 'Calendar';
  }
}

/**
 * Every calendar across the accounts, in account order with each default calendar first.
 * Calendars seen only on events (offline, or a host that could not list them) still appear, so
 * every event has a calendar to toggle. Hosts' colours are kept; the default calendar otherwise
 * takes the account's colour and the rest take distinct colours from a calm palette.
 */
export function mergeCalendars(
  accounts: Account[],
  listed: CalendarInfo[],
  events: CalendarEvent[],
): CalendarSource[] {
  const result: CalendarSource[] = [];
  for (const account of accounts) {
    const own = listed.filter(c => c.accountId === account.id);
    const known = new Set(own.map(c => c.id));
    const hasPrimary = own.some(c => c.primary);
    for (const e of events) {
      if (
        e.accountId !== account.id ||
        known.has(e.calendarId) ||
        (e.calendarId === 'primary' && hasPrimary)
      )
        continue;
      known.add(e.calendarId);
      own.push({
        id: e.calendarId,
        accountId: account.id,
        name: nameFromId(e.calendarId),
        primary: e.calendarId === 'primary' || undefined,
      });
    }
    own.sort((a, b) => Number(!!b.primary) - Number(!!a.primary));
    const used = new Set(own.map(c => c.color?.toLowerCase()).filter(validColor));
    own.forEach((c, i) => {
      let color = validColor(c.color) ? c.color!.toLowerCase() : undefined;
      if (!color && i === 0 && !used.has(account.color.toLowerCase()))
        color = account.color.toLowerCase();
      if (!color) {
        const start = hash(calendarKey(account.id, c.id));
        color =
          palette.map((_, n) => palette[(start + n) % palette.length]).find(p => !used.has(p)) ??
          palette[start % palette.length];
      }
      used.add(color);
      result.push({ ...c, color, key: calendarKey(account.id, c.id) });
    });
  }
  return result;
}

/** Finds an event's calendar; `'primary'` stands for the account's default calendar. */
export function calendarIndex(sources: CalendarSource[]) {
  const index = new Map(sources.map(s => [s.key, s]));
  for (const s of sources)
    if (s.primary && !index.has(calendarKey(s.accountId, 'primary')))
      index.set(calendarKey(s.accountId, 'primary'), s);
  return (event: Pick<CalendarEvent, 'accountId' | 'calendarId'>) =>
    index.get(calendarKey(event.accountId, event.calendarId));
}

/** The events the page shows: the chosen account (or all), minus hidden calendars. */
export function visibleEvents<T extends Pick<CalendarEvent, 'accountId' | 'calendarId'>>(
  events: T[],
  sourceOf: (event: T) => CalendarSource | undefined,
  accountId: string,
  hidden: Iterable<string>,
): T[] {
  const off = new Set(hidden);
  return events.filter(
    e =>
      (accountId === 'all' || e.accountId === accountId) &&
      !off.has(sourceOf(e)?.key ?? calendarKey(e.accountId, e.calendarId)),
  );
}

const midnight = (day: string) => new Date(day + 'T00:00:00');
type Timed = { start: string; end: string; allDay: boolean };

/** Whether an event touches a day. All-day ends are exclusive, as Google stores them. */
export function onDay(event: Timed, day: string) {
  if (event.allDay) {
    const end = event.end.slice(0, 10);
    return event.start.slice(0, 10) <= day && (end > day || event.start.slice(0, 10) === day);
  }
  const from = +midnight(day),
    to = +midnight(addDays(day, 1));
  const start = +new Date(event.start),
    end = Math.max(+new Date(event.end), start + 1);
  return start < to && end > from;
}

/** A day's plans: all-day ones first, then by start time. */
export function eventsOnDay<T extends Timed>(events: T[], day: string): T[] {
  return events
    .filter(e => onDay(e, day))
    .sort(
      (a, b) =>
        Number(b.allDay) - Number(a.allDay) ||
        +new Date(a.start.length === 10 ? a.start + 'T00:00:00' : a.start) -
          +new Date(b.start.length === 10 ? b.start + 'T00:00:00' : b.start) ||
        a.end.localeCompare(b.end),
    );
}

export interface Placed<T> {
  event: T;
  start: number;
  end: number;
  column: number;
  columns: number;
  span: number;
}

/**
 * Timed events on one day as minutes from midnight, packed side by side where they overlap.
 * Each run of overlapping events shares a column count; an event widens into free columns to its right.
 * Very short events count as `minMinutes` long, since that is how tall they are drawn.
 */
export function layoutDay<T extends Timed>(events: T[], day: string, minMinutes = 20): Placed<T>[] {
  const from = +midnight(day),
    to = +midnight(addDays(day, 1)),
    length = (to - from) / 60000;
  const items = events
    .filter(e => !e.allDay && onDay(e, day))
    .map(event => {
      const start = Math.max(0, (+new Date(event.start) - from) / 60000);
      const end = Math.min(length, Math.max((+new Date(event.end) - from) / 60000, start + 1));
      return {
        event,
        start,
        end,
        shown: Math.min(length, Math.max(end, start + minMinutes)),
        column: 0,
        columns: 1,
        span: 1,
      };
    })
    .sort((a, b) => a.start - b.start || b.end - a.end);
  let run: typeof items = [],
    ends: number[] = [],
    runEnd = -1;
  const close = () => {
    for (const item of run) {
      item.columns = ends.length;
      for (
        let c = item.column + 1;
        c < ends.length &&
        !run.some(o => o.column === c && o.start < item.shown && o.shown > item.start);
        c++
      )
        item.span++;
    }
    run = [];
    ends = [];
  };
  for (const item of items) {
    if (item.start >= runEnd) close();
    let column = ends.findIndex(end => end <= item.start);
    if (column < 0) {
      column = ends.length;
      ends.push(0);
    }
    item.column = column;
    ends[column] = item.shown;
    run.push(item);
    runEnd = Math.max(runEnd, item.shown);
  }
  close();
  return items.map(({ event, start, end, column, columns, span }) => ({
    event,
    start,
    end,
    column,
    columns,
    span,
  }));
}

/** All-day events across consecutive days as bars: first and last column, and a lane so bars never overlap. */
export function allDayLanes<T extends Timed>(events: T[], days: string[]) {
  const first = days[0],
    last = days[days.length - 1];
  const bars = events
    .filter(e => e.allDay)
    .map(event => {
      const start = event.start.slice(0, 10);
      const end = event.end.slice(0, 10) > start ? addDays(event.end.slice(0, 10), -1) : start;
      return { event, start, end };
    })
    .filter(b => b.start <= last && b.end >= first)
    .map(b => ({
      event: b.event,
      from: days.indexOf(b.start < first ? first : b.start),
      to: days.indexOf(b.end > last ? last : b.end),
      lane: 0,
    }))
    .sort((a, b) => a.from - b.from || b.to - b.from - (a.to - a.from));
  const lanes: number[] = [];
  for (const bar of bars) {
    let lane = lanes.findIndex(end => end < bar.from);
    if (lane < 0) {
      lane = lanes.length;
      lanes.push(-1);
    }
    lanes[lane] = bar.to;
    bar.lane = lane;
  }
  return { bars, lanes: lanes.length };
}

export const startOfWeek = (day: string, weekStart = 0) => {
  const d = midnight(day);
  return addDays(day, -((d.getDay() - weekStart + 7) % 7));
};

/** The days a view shows around the anchor day: one, a week, or six weeks covering the month. */
export function viewDays(view: CalendarView, anchor: string, weekStart = 0): string[] {
  if (view === 'day') return [anchor];
  const first =
    view === 'week'
      ? startOfWeek(anchor, weekStart)
      : startOfWeek(anchor.slice(0, 8) + '01', weekStart);
  return Array.from({ length: view === 'week' ? 7 : 42 }, (_, i) => addDays(first, i));
}

/** The anchor one period earlier or later. Months keep the day where they can (31 Jan → 28 Feb). */
export function shiftAnchor(view: CalendarView, anchor: string, delta: number) {
  if (view === 'day') return addDays(anchor, delta);
  if (view === 'week') return addDays(anchor, 7 * delta);
  const d = midnight(anchor);
  const target = new Date(d.getFullYear(), d.getMonth() + delta, 1);
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(d.getDate(), last));
  return ymd(target);
}

type Proposal = Partial<CalendarEvent> & { start: string; end: string };
const dayOfEvent = (e: { start: string; allDay?: boolean }) =>
  e.allDay || e.start.length === 10 ? e.start.slice(0, 10) : ymd(new Date(e.start));

/**
 * What the open email means for Today: a plan found in it that is not on a calendar yet (shown as a ghost),
 * or else the event already saved from it. Either way Today moves to that day.
 */
export function emailContext(
  threadId: string | undefined,
  events: CalendarEvent[],
  plans: Partial<CalendarEvent>[] | undefined,
): { day: string; proposal?: Proposal; saved?: CalendarEvent } | undefined {
  if (!threadId) return;
  const saved = events
    .filter(e => e.threadId === threadId)
    .sort((a, b) => a.start.localeCompare(b.start));
  const known = (p: Partial<CalendarEvent>) => planSaved(p, saved);
  const proposal = plans?.find(
    (p): p is Proposal =>
      !!p.start && !!p.end && +new Date(p.end) > +new Date(p.start) && !known(p),
  );
  if (proposal) return { day: dayOfEvent(proposal), proposal };
  if (saved[0]) return { day: dayOfEvent(saved[0]), saved: saved[0] };
}

/**
 * Whether a found plan is already one of these saved events: the same moment (Groq writes local offsets, hosts write
 * UTC, so the strings differ), or the same title on the same day.
 */
export function planSaved(p: Partial<CalendarEvent>, saved: CalendarEvent[]) {
  const at = p.start ? Date.parse(p.start.length === 10 ? p.start + 'T00:00:00' : p.start) : NaN;
  return saved.some(
    e =>
      e.start === p.start ||
      (!Number.isNaN(at) && !e.allDay && !p.allDay && Date.parse(e.start) === at) ||
      (!!p.title &&
        !!p.start &&
        e.title.toLowerCase() === p.title.toLowerCase() &&
        dayOfEvent(e) === dayOfEvent(p as Proposal)),
  );
}

/** Timed plans that overlap a proposed time. All-day plans block no time, so they never clash. */
export function clashes<T extends Pick<CalendarEvent, 'id' | 'start' | 'end' | 'allDay'>>(
  proposal: { id?: string; start: string; end: string; allDay?: boolean },
  events: T[],
): T[] {
  if (proposal.allDay) return [];
  const start = +new Date(proposal.start),
    end = +new Date(proposal.end);
  return events.filter(
    e => !e.allDay && e.id !== proposal.id && +new Date(e.start) < end && +new Date(e.end) > start,
  );
}

/** Identifies a found plan by its original time and title, so edits made before adding do not change which plan it was. */
export const planKey = (p: Partial<CalendarEvent>) => (p.start ?? '') + '|' + (p.title ?? '');

/**
 * The plans Today offers for an email: none after "Not now", the one the user chose first, and never one already
 * added from Today (whose title or time may have been changed on the way, so it no longer looks like the saved event).
 */
export function plansToReview(
  entry: { found: Partial<CalendarEvent>[]; dismissed: boolean } | undefined,
  chosen: Partial<CalendarEvent> | undefined,
  added: ReadonlySet<string>,
) {
  if (!entry || entry.dismissed) return;
  return (chosen ? [chosen, ...entry.found] : entry.found).filter(p => !added.has(planKey(p)));
}
