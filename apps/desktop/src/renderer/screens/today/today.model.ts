/**
 * The Today tab's view model (DESIGN §7.7 Today). Pure, no React.
 *
 * Rules: today's timed events that have not ended yet — the one under way marked, the next one, the following two
 * in full and the rest folded ("2 more"); what already ended only counts into the quiet "N earlier" line; a now
 * line; free gaps of 30 minutes or more between now and the last event of the day (never after it). Declined,
 * cancelled, hidden and free (transparent) events are left out, so they neither show nor block a gap. All-day
 * events sit above the timeline. Times are local.
 *
 * `CalendarGrid` (view 'agenda', agenda 'today') draws the agenda from `events` and `now`; this model chooses which
 * events it gets and works out the facts the screen states itself (the fold, the announcement) and that tests check.
 */
import { toIsoDate, toIsoDateTime } from '../../data';
import type { Calendar, Event, EventTime } from '../../data';
import type { CalendarEventData, TagColor } from '../../ui/props';

export const MINUTE = 60_000;
/** Gaps shorter than this are not worth a line. */
export const MIN_GAP_MINUTES = 30;
/** The next event plus the following two (DESIGN §7.7). */
export const SHOWN_AHEAD = 3;

const TAGS: readonly TagColor[] = ['sky', 'hill', 'stamp', 'dusk', 'sand', 'ember'];

/** A calendar as Today needs it. */
export interface TodayCalendar {
  readonly id: string;
  readonly name: string;
  readonly color: TagColor;
}

/** A calendar's tag colour: its own `colorTag` when it names one, else a stable pick from its id. */
export function calendarColor(calendar: Pick<Calendar, 'id' | 'colorTag'>): TagColor {
  const tag = calendar.colorTag as TagColor | undefined;
  if (tag && TAGS.includes(tag)) return tag;
  let hash = 0;
  for (const char of calendar.id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return TAGS[hash % TAGS.length];
}

export function todayCalendar(calendar: Pick<Calendar, 'id' | 'name' | 'colorTag'>): TodayCalendar {
  return { id: calendar.id, name: calendar.name, color: calendarColor(calendar) };
}

/** Epoch ms of an event time; a day is its local midnight; a floating time is read as local. */
export function instant(time: EventTime): number {
  switch (time.type) {
    case 'utc':
      return time.utc;
    case 'date': {
      const [y, m, d] = time.date.split('-').map(Number);
      return new Date(y, m - 1, d).getTime();
    }
    case 'floating':
      return new Date(time.local).getTime();
    default:
      return Number.NaN;
  }
}

/** "2 h 45 min", "3 h", "45 min". */
export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** "10:00 AM" (en-US, the harness locale). */
export function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

/** "Thu 2:00–2:30 PM", "Thu 11:30 AM–12:30 PM", "Thu, Oct 29 · All day". */
export function formatWhen(start: number, end: number, allDay: boolean): string {
  const day = new Date(start).toLocaleDateString('en-US', { weekday: 'short' });
  if (allDay) {
    const date = new Date(start).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return `${day}, ${date} · All day`;
  }
  const a = clock(start);
  const b = clock(end);
  const meridiem = (text: string) => text.slice(-2);
  const sameHalf =
    meridiem(a) === meridiem(b) && new Date(start).toDateString() === new Date(end).toDateString();
  return `${day} ${sameHalf ? a.slice(0, -3) : a}–${b}`;
}

/** Whether an event belongs in Today at all. */
export function blocksTime(event: Event): boolean {
  if (event.status === 'cancelled') return false;
  if (event.myResponse === 'declined') return false;
  if (event.hidden) return false;
  if (event.transparency === 'transparent') return false;
  return true;
}

/** One event placed on today's timeline. */
export interface AgendaEntry {
  readonly event: CalendarEventData;
  readonly start: number;
  readonly end: number;
}

/** A free stretch between now and the last event. */
export interface FreeGap {
  readonly from: number;
  readonly to: number;
  readonly minutes: number;
  /** "Free for 2 h 45 min". */
  readonly text: string;
  /** The event the gap ends at. */
  readonly beforeId: string;
}

export interface TodayModel {
  /** The local day, "2026-10-29". */
  readonly day: string;
  readonly now: string;
  /** What CalendarGrid gets: today's all-day and timed events that block time. */
  readonly events: readonly CalendarEventData[];
  readonly allDay: readonly AgendaEntry[];
  /** Timed events already over; they fold into the "N earlier" line, never rows. */
  readonly earlier: number;
  /** Under way now. */
  readonly current: readonly AgendaEntry[];
  readonly next?: AgendaEntry;
  /** The two after the next. */
  readonly following: readonly AgendaEntry[];
  /** Upcoming events after those three, folded. */
  readonly folded: readonly AgendaEntry[];
  /** "2 more", or undefined. */
  readonly moreText?: string;
  /** Every gap of 30 minutes or more from now to the last event's start. */
  readonly gaps: readonly FreeGap[];
  /** The gaps before the three shown events. */
  readonly shownGaps: readonly FreeGap[];
  /** "4 left today · next at 11:00 AM" (the same sentence the agenda's header shows). */
  readonly headline: string;
  readonly empty: boolean;
}

function toData(event: Event, calendar: TodayCalendar | undefined): CalendarEventData {
  const start = instant(event.start);
  const end = instant(event.end);
  return {
    id: event.id,
    title: event.title,
    start: toIsoDateTime(start),
    end: toIsoDateTime(end),
    allDay: event.allDay || undefined,
    calendar: calendar ?? { id: event.calendarId, name: 'Calendar', color: 'sky' },
    place: event.location,
    kind: 'event',
    unanswered: event.myResponse === 'needsAction' || undefined,
    persisted: event.sync !== 'localOnly',
    recurring: event.recurring || undefined,
  };
}

/** Today's agenda at `now`. */
export function todayModel(
  events: readonly Event[],
  calendars: ReadonlyMap<string, TodayCalendar>,
  now: number,
): TodayModel {
  const day = toIsoDate(now);
  const dayStart = new Date(
    new Date(now).getFullYear(),
    new Date(now).getMonth(),
    new Date(now).getDate(),
  ).getTime();
  const dayEnd = new Date(dayStart + 36 * 60 * MINUTE).setHours(0, 0, 0, 0);

  const entries: AgendaEntry[] = [];
  for (const event of events) {
    if (!blocksTime(event)) continue;
    const start = instant(event.start);
    const end = instant(event.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const onToday = event.allDay
      ? start < dayEnd && end > dayStart
      : start >= dayStart && start < dayEnd;
    if (!onToday) continue;
    entries.push({
      event: toData(event, calendars.get(event.calendarId)),
      start,
      end: Math.max(end, start),
    });
  }
  entries.sort((a, b) => a.start - b.start || a.event.title.localeCompare(b.event.title));

  const allDay = entries.filter(e => e.event.allDay);
  const timed = entries.filter(e => !e.event.allDay);
  const upcoming = timed.filter(e => e.start >= now);
  const current = timed.filter(e => e.start < now && e.end > now);
  const earlier = timed.filter(e => e.end <= now).length;
  const left = allDay.length + current.length + upcoming.length;
  const ahead = upcoming.slice(0, SHOWN_AHEAD);

  const gaps: FreeGap[] = [];
  let free = Math.max(now, ...current.map(e => e.end));
  for (const entry of upcoming) {
    const minutes = Math.floor((entry.start - free) / MINUTE);
    if (minutes >= MIN_GAP_MINUTES) {
      gaps.push({
        from: free,
        to: entry.start,
        minutes,
        text: `Free for ${formatDuration(minutes)}`,
        beforeId: entry.event.id,
      });
    }
    free = Math.max(free, entry.end);
  }
  const shownIds = new Set(ahead.map(e => e.event.id));
  const folded = upcoming.slice(SHOWN_AHEAD);
  const next = upcoming[0];

  return {
    day,
    now: toIsoDateTime(now),
    events: entries.map(e => e.event),
    allDay,
    earlier,
    current,
    next,
    following: ahead.slice(1),
    folded,
    moreText: folded.length > 0 ? `${folded.length} more` : undefined,
    gaps,
    shownGaps: gaps.filter(g => shownIds.has(g.beforeId)),
    headline:
      left === 0
        ? 'Nothing left today'
        : `${left} left today${next ? ` · next at ${clock(next.start)}` : ''}`,
    empty: entries.length === 0,
  };
}
