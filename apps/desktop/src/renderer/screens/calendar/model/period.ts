/** Views, periods, the top row's labels, and contract `EventTime` to the grid's ISO strings. */
import {
  toIsoDate,
  toIsoDateTime,
  type EpochMs,
  type EventTime,
  type ViewSpecOf,
} from '../../../data';
import type { CalendarView, IsoDate, IsoDateTime } from '../../../ui/props';
import {
  addDays,
  dateOf,
  dayTitle,
  isoOf,
  longDay,
  monthMatrix,
  monthTitle,
  MONTHS,
  parseDate,
  yearMonthOf,
} from '../../../ui/calendar/dates';
import { DAY_MS } from './units';

// ---------------------------------------------------------------------------
// Views and periods
// ---------------------------------------------------------------------------

/** The views D, W and M choose. The agenda is not chosen: it replaces the grid in a narrow pane. */
export type GridView = 'day' | 'week' | 'month';

/** Under this pane width the grid gives way to the agenda list (DESIGN 7.8 Narrow). */
export const NARROW_PANE_PX = 720;

/** The longest range one `events` window may cover (contract `ViewSpec` events: else `rangeTooLarge`). */
export const MAX_RANGE_DAYS = 62;

/** What the pane draws: the chosen view, or the agenda under 720 px. An unmeasured pane (0) keeps the chosen view. */
export function shownViewFor(view: GridView, paneWidth: number): CalendarView {
  return paneWidth > 0 && paneWidth < NARROW_PANE_PX ? 'agenda' : view;
}

/**
 * The first weekday: the setting when it is Sunday or Monday (the components draw only those two), else the locale.
 * `Intl.Locale#getWeekInfo` reports Monday as 1 and Sunday as 7.
 */
export function weekStartsOnFor(setting: number | undefined, locale?: string): 0 | 1 {
  if (setting === 0 || setting === 1) return setting;
  try {
    const loc = new Intl.Locale(locale ?? 'en-US') as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number };
      weekInfo?: { firstDay: number };
    };
    const info = loc.getWeekInfo?.() ?? loc.weekInfo;
    return info?.firstDay === 1 ? 1 : 0;
  } catch {
    return 0;
  }
}

/** The first day of the week holding `day`. */
export function weekStartOf(day: IsoDate, weekStartsOn: 0 | 1): IsoDate {
  const dow = dateOf(day).getDay();
  return addDays(day, -((dow - weekStartsOn + 7) % 7));
}

/** What one view shows: the grid's `start`, every day drawn, and the instants that bound them. */
export interface Period {
  view: CalendarView;
  /** `CalendarGrid.start`: the day, the week's first day, or the month's first day. */
  start: IsoDate;
  /** Every day the grid draws, in order (six weeks for a month). */
  days: readonly IsoDate[];
  /** Local midnight of the first day. */
  from: EpochMs;
  /** Local midnight after the last day; a DST day is 23 or 25 hours long. */
  to: EpochMs;
}

export function periodOf(view: CalendarView, anchor: IsoDate, weekStartsOn: 0 | 1): Period {
  let start: IsoDate;
  let days: IsoDate[];
  if (view === 'day') {
    start = anchor;
    days = [anchor];
  } else if (view === 'month') {
    const ym = yearMonthOf(anchor);
    start = `${ym}-01`;
    days = monthMatrix(ym, weekStartsOn).flat();
  } else {
    start = weekStartOf(anchor, weekStartsOn);
    days = [0, 1, 2, 3, 4, 5, 6].map(i => addDays(start, i));
  }
  return {
    view,
    start,
    days,
    from: dateOf(days[0]).getTime(),
    to: dateOf(addDays(days[days.length - 1], 1)).getTime(),
  };
}

/** Whole days a period spans (a DST hour does not add a day). */
export function periodDays(period: Pick<Period, 'from' | 'to'>): number {
  return Math.round((period.to - period.from) / DAY_MS);
}

/** The `events` window for a period over the visible calendars; throws past 62 days rather than ask for `rangeTooLarge`. */
export function eventsSpec(period: Period, calendarIds: readonly string[]): ViewSpecOf<'events'> {
  if (periodDays(period) > MAX_RANGE_DAYS)
    throw new RangeError('A calendar range covers 62 days at most.');
  return { kind: 'events', from: period.from, to: period.to, calendarIds: [...calendarIds].sort() };
}

/** The `plans` window over the same range: the grid's dashed "From mail" outlines. */
export function plansSpec(period: Period): ViewSpecOf<'plans'> {
  return { kind: 'plans', from: period.from, to: period.to };
}

/** How far ahead an empty day or week looks for its "Next:" line (DESIGN 7.14). */
export const LOOKAHEAD_DAYS = 14;

/** Local midnight `LOOKAHEAD_DAYS` after `ms`: the horizon the "next two weeks" line is honest about. */
export function lookaheadEnd(ms: EpochMs): EpochMs {
  return dateOf(addDays(toIsoDate(ms), LOOKAHEAD_DAYS)).getTime();
}

/**
 * The events window the screen watches: the period plus [today, the lookahead horizon], so an empty period can
 * still say what comes next (DESIGN 7.14). The plain period when the union would pass the 62-day cap.
 */
export function eventsRange(
  period: Pick<Period, 'from' | 'to'>,
  now: EpochMs,
): Pick<Period, 'from' | 'to'> {
  const from = Math.min(period.from, dateOf(toIsoDate(now)).getTime());
  const to = Math.max(period.to, lookaheadEnd(now), lookaheadEnd(period.from));
  return to - from <= MAX_RANGE_DAYS * DAY_MS ? { from, to } : period;
}

/** J/→ and K/←: one day, week or month (the day of the month kept, or the month's last day). */
export function stepAnchor(view: CalendarView, anchor: IsoDate, dir: 1 | -1): IsoDate {
  if (view === 'day') return addDays(anchor, dir);
  if (view !== 'month') return addDays(anchor, 7 * dir);
  const { y, m, d } = parseDate(anchor);
  const first = new Date(y, m - 1 + dir, 1);
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  return isoOf(new Date(first.getFullYear(), first.getMonth(), Math.min(d, last)));
}

// ---------------------------------------------------------------------------
// Labels (DESIGN 7.8 Top row and Fixes, 11.3)
// ---------------------------------------------------------------------------

const shortMonth = (m: number): string => MONTHS[m - 1].slice(0, 3);

/** "1 event", "12 events", "1,204 events", "No events". */
export function eventCount(n: number): string {
  if (n === 0) return 'No events';
  return `${n.toLocaleString('en-US')} ${n === 1 ? 'event' : 'events'}`;
}

/**
 * The PageHead's date label: a small `title` "October 2026" with the range beside it, "October 25 – 31";
 * a week across two months reads "Oct – Nov 2026" and "Oct 25 – Nov 1"; a day reads "Thursday, October 29";
 * a month counts its events.
 */
export function topLabel(
  view: CalendarView,
  period: Period,
  anchor: IsoDate,
  monthEvents = 0,
): { label: string; range: string } {
  if (view === 'day') return { label: monthTitle(yearMonthOf(anchor)), range: longDay(anchor) };
  if (view === 'month')
    return { label: monthTitle(yearMonthOf(anchor)), range: eventCount(monthEvents) };
  const a = parseDate(period.days[0]);
  const b = parseDate(period.days[period.days.length - 1]);
  if (a.m === b.m && a.y === b.y)
    return { label: `${MONTHS[a.m - 1]} ${a.y}`, range: `${MONTHS[a.m - 1]} ${a.d} – ${b.d}` };
  const range = `${shortMonth(a.m)} ${a.d} – ${shortMonth(b.m)} ${b.d}`;
  if (a.y === b.y) return { label: `${shortMonth(a.m)} – ${shortMonth(b.m)} ${b.y}`, range };
  return { label: `${shortMonth(a.m)} ${a.y} – ${shortMonth(b.m)} ${b.y}`, range };
}

/**
 * The grid's accessible name, which CalendarGrid also announces when it changes: a day title with the comma and the
 * count ("Sunday, November 1, 2026. Nothing scheduled"), "Week of Sunday, October 25, 2026", "October 2026".
 */
export function gridLabel(
  view: CalendarView,
  period: Period,
  anchor: IsoDate,
  dayCount: number,
): string {
  if (view === 'day')
    return `${dayTitle(anchor)}. ${dayCount === 0 ? 'Nothing scheduled' : `${eventCount(dayCount)}.`}`;
  if (view === 'month') return monthTitle(yearMonthOf(anchor));
  return `Week of ${dayTitle(period.days[0])}`;
}

/** Tooltip and accessible names for previous and next. */
export function periodWord(view: CalendarView): 'day' | 'week' | 'month' {
  return view === 'day' ? 'day' : view === 'month' ? 'month' : 'week';
}

// ---------------------------------------------------------------------------
// Time: contract EventTime to the grid's ISO strings
// ---------------------------------------------------------------------------

/** Milliseconds east of UTC that `timeZone` keeps at the instant `ms`. */
export function zoneOffsetMs(ms: EpochMs, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(new Date(ms));
  const get = (type: string): number => Number(parts.find(p => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** A wall-clock time ("2026-10-29T09:00") as an instant: in `timeZone` when given, else in the machine's zone. */
export function wallToMs(local: string, timeZone?: string): EpochMs {
  const [date, time = '00:00'] = local.split('T');
  const { y, m, d } = parseDate(date);
  const [hh = 0, mm = 0, ss = 0] = time.split(':').map(Number);
  if (!timeZone) return new Date(y, m - 1, d, hh, mm, ss).getTime();
  try {
    const guess = Date.UTC(y, m - 1, d, hh, mm, ss);
    const first = guess - zoneOffsetMs(guess, timeZone);
    return guess - zoneOffsetMs(first, timeZone);
  } catch {
    return new Date(y, m - 1, d, hh, mm, ss).getTime();
  }
}

/** An `EventTime` as an instant: a date is local midnight. */
export function msOf(t: EventTime): EpochMs {
  if (t.type === 'utc') return t.utc;
  if (t.type === 'date') return dateOf(t.date).getTime();
  return wallToMs(t.local, t.timeZone);
}

/** An `EventTime` as the grid's ISO string: local wall-clock with offset, or local midnight for a date. */
export function isoOfTime(t: EventTime): IsoDateTime {
  if (t.type === 'date') return `${t.date}T00:00:00`;
  return toIsoDateTime(msOf(t));
}

/** "meet.example.com/design-review": the link as the detail shows it, without the scheme. */
export function displayUrl(url: string): string {
  return url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/$/, '');
}
