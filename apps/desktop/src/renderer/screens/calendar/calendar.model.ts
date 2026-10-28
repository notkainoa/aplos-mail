/**
 * The Calendar screen's model (DESIGN 7.8, 7.14, 4.2, 8 Calendar keys, 11; plan 30 U7 acceptance 6). Pure: plain
 * functions from contract values (`Event`, `Plan`, `Calendar`, epoch ms) to the props the calendar family takes, plus
 * the screen's decisions as one reducer, `update`, which returns the next state and the effects the container runs
 * (contract calls, toasts, opening a thread). No React, no hooks, no clock: `now` comes in through the context.
 *
 * Times: the grid reads ISO strings in the machine's zone (ui/calendar/dates). Instants become local wall-clock
 * strings with their offset (`toIsoDateTime`), all-day dates local midnight, so DST days lay out by the wall clock.
 *
 * Readings of map-calendar.md's UNCLEAR items used here (UI-screens decisions): ↑/↓ walk events in time order
 * (CalendarGrid does the walk; `walk` below picks the next one after a delete); week start follows the locale with
 * `Settings.ui.calendar.weekStart` overriding it; colour is the calendar's `colorTag`, else DESIGN 4.2's stable hash of
 * the name; visibility is Aplos-side (`Calendar/set {shown}`), and solo is session state; a held RSVP reads
 * "Replying Yes to Priya · Undo Z"; "persisted" is any stored row (`sync` other than `localOnly`), so only an
 * unsaved draft lacks Delete; `following` is never offered.
 */
import type { EventChange, EventFields } from '@aplos/contract';
import {
  toIsoDate,
  toIsoDateTime,
  type Calendar,
  type EpochMs,
  type Event,
  type EventTime,
  type Plan,
  type Receipt,
  type ViewSpecOf,
} from '../../data';
import type {
  CalendarEventData,
  CalendarInfo,
  CalendarView,
  CommandId,
  EventGuest,
  EventScope,
  IsoDate,
  IsoDateTime,
  IsoTime,
  IsoYearMonth,
  MenuEntry,
  RsvpAnswer,
  TagColor,
  ToastKind,
} from '../../ui/props';
import {
  addDays,
  dateOf,
  dayOf,
  dayTitle,
  durationText,
  formatClock,
  hoursOf,
  isoOf,
  longDay,
  minutesBetween,
  monthMatrix,
  monthTitle,
  MONTHS,
  parseDate,
  rangeOf,
  timeOf,
  yearMonthOf,
} from '../../ui/calendar/dates';
import { firstNameOf } from '../../ui/calendar/EventDetail';
import { timedOn } from '../../ui/calendar/layout';

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const pad = (n: number): string => String(n).padStart(2, '0');

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
  if (periodDays(period) > MAX_RANGE_DAYS) throw new RangeError('A calendar range covers 62 days at most.');
  return { kind: 'events', from: period.from, to: period.to, calendarIds: [...calendarIds].sort() };
}

/** The `plans` window over the same range: the grid's dashed "From mail" outlines. */
export function plansSpec(period: Period): ViewSpecOf<'plans'> {
  return { kind: 'plans', from: period.from, to: period.to };
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
  if (view === 'month') return { label: monthTitle(yearMonthOf(anchor)), range: eventCount(monthEvents) };
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
 * count ("Sunday, November 1, 2026. Nothing scheduled."), "Week of Sunday, October 25, 2026", "October 2026".
 */
export function gridLabel(view: CalendarView, period: Period, anchor: IsoDate, dayCount: number): string {
  if (view === 'day')
    return `${dayTitle(anchor)}. ${dayCount === 0 ? 'Nothing scheduled.' : `${eventCount(dayCount)}.`}`;
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
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
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

// ---------------------------------------------------------------------------
// Calendars: colour (DESIGN 4.2) and Aplos-side visibility
// ---------------------------------------------------------------------------

export const TAG_COLORS: readonly TagColor[] = ['sky', 'hill', 'stamp', 'dusk', 'sand', 'ember'];

export function isTagColor(value: string | undefined): value is TagColor {
  return value !== undefined && (TAG_COLORS as readonly string[]).includes(value);
}

/** DESIGN 4.2's stable hash: FNV-1a over the lower-cased key, one of six pairs. */
export function hashTag(key: string): TagColor {
  let h = 0x811c9dc5;
  for (const ch of key.toLowerCase()) {
    h ^= ch.codePointAt(0) ?? 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return TAG_COLORS[h % TAG_COLORS.length];
}

/** The calendar's colour: the override (`colorTag`), else the hash of its name; two calendars with one name hash with their account too. */
export function tagFor(calendar: Calendar, all: readonly Calendar[]): TagColor {
  if (isTagColor(calendar.colorTag)) return calendar.colorTag;
  const name = calendar.name.trim().toLowerCase();
  const twin = all.some(c => c.id !== calendar.id && c.name.trim().toLowerCase() === name);
  return hashTag(twin ? `${name}\u0000${calendar.accountId}` : name);
}

/** The ids drawn: the solo calendar alone, else every shown one. */
export function visibleCalendarIds(calendars: readonly Calendar[], solo: string | null): string[] {
  if (solo && calendars.some(c => c.id === solo)) return [solo];
  return calendars.filter(c => c.shown).map(c => c.id);
}

/** The sidebar legend's rows. */
export function calendarInfos(calendars: readonly Calendar[], solo: string | null): CalendarInfo[] {
  const visible = new Set(visibleCalendarIds(calendars, solo));
  return calendars.map(c => ({ id: c.id, name: c.name, color: tagFor(c, calendars), visible: visible.has(c.id) }));
}

/** Calendars a new event can go on. An existing event keeps its calendar: `Event/set` updates cannot move it. */
export function writableCalendars(calendars: readonly Calendar[]): Calendar[] {
  return calendars.filter(c => !c.readOnly);
}

/** Where N, a drag and a confirmed plan land: the setting, else the primary writable calendar, else the first writable one. */
export function defaultCalendarId(calendars: readonly Calendar[], setting?: string): string | null {
  const writable = writableCalendars(calendars);
  return (
    writable.find(c => c.id === setting)?.id ??
    writable.find(c => c.primary && c.shown)?.id ??
    writable.find(c => c.primary)?.id ??
    writable.find(c => c.shown)?.id ??
    writable[0]?.id ??
    null
  );
}

// ---------------------------------------------------------------------------
// Events and plans to CalendarEventData
// ---------------------------------------------------------------------------

const GUEST_STATUS: Record<string, EventGuest['status']> = {
  accepted: 'going',
  tentative: 'maybe',
  declined: 'declined',
  needsAction: 'none',
};

const REPLY: Record<string, RsvpAnswer | null> = {
  accepted: 'yes',
  tentative: 'maybe',
  declined: 'no',
  needsAction: null,
};

/** You organise it: your own event with no organizer or guests counts, when you may edit it. */
export function isOrganizer(e: Event): boolean {
  if (e.organizer) return e.organizer.self;
  const listed = e.attendees.find(a => a.organizer);
  if (listed) return listed.self;
  return e.can.edit;
}

/** An invite still waiting for your answer: Y/M/N apply. */
export function isUnanswered(e: Event): boolean {
  return e.can.rsvp && !isOrganizer(e) && (e.myResponse ?? 'needsAction') === 'needsAction';
}

/** The organizer's name as the RSVP toast says it ("Priya"); undefined when unknown. */
export function organizerFirstName(e: Event): string | undefined {
  const who = e.organizer ?? e.attendees.find(a => a.organizer);
  const name = who?.name ?? e.invite?.fromName;
  return name ? firstNameOf(name) || undefined : undefined;
}

function guestsOf(e: Event): EventGuest[] {
  const list = [...e.attendees];
  if (e.organizer && !list.some(a => a.address === e.organizer?.address)) list.unshift(e.organizer);
  const organizerAddress = e.organizer?.address;
  const seen = new Set<string>();
  const guests: Array<EventGuest & { first: boolean }> = [];
  for (const a of list) {
    if (seen.has(a.address)) continue;
    seen.add(a.address);
    const organizer = a.organizer || a.address === organizerAddress;
    guests.push({
      name: a.name?.trim() || a.address,
      status: GUEST_STATUS[a.response] ?? 'none',
      ...(a.self ? { isYou: true } : {}),
      ...(organizer ? { isOrganizer: true } : {}),
      first: organizer,
    });
  }
  // The organizer first, then everyone in the order the invite lists them.
  return [...guests.filter(g => g.first), ...guests.filter(g => !g.first)].map(({ first, ...g }) => {
    void first;
    return g;
  });
}

/** Events of a day or more are drawn in the all-day strip, as Google Calendar draws them; the grid shows a timed entry only on its first day. */
export const STRIP_MINUTES = 24 * 60;

/** One contract event as the grid's entry. */
export function eventData(e: Event, calendar: Pick<CalendarInfo, 'id' | 'name' | 'color'>): CalendarEventData {
  let start = isoOfTime(e.start);
  let end = isoOfTime(e.end);
  if (new Date(end).getTime() < new Date(start).getTime()) end = start;
  let allDay = e.allDay || e.start.type === 'date';
  if (allDay && e.start.type !== 'date') {
    // An all-day event stored as instants: draw it on its local days.
    start = `${toIsoDate(msOf(e.start))}T00:00:00`;
    const lastMs = Math.max(msOf(e.start), msOf(e.end) - MINUTE_MS);
    end = `${addDays(toIsoDate(lastMs), 1)}T00:00:00`;
  }
  if (!allDay && minutesBetween(start, end) >= STRIP_MINUTES) allDay = true;
  const reply = e.myResponse === undefined || isOrganizer(e) ? undefined : (REPLY[e.myResponse] ?? null);
  const guests = guestsOf(e);
  return {
    id: e.id,
    title: e.title.trim() ? e.title : 'No title',
    start,
    end,
    ...(allDay ? { allDay: true } : {}),
    calendar,
    ...(e.location ? { place: e.location } : {}),
    kind: 'event',
    ...(isUnanswered(e) ? { unanswered: true } : {}),
    persisted: e.sync !== 'localOnly',
    ...(e.conference ? { video: displayUrl(e.conference.url) } : {}),
    ...(guests.length > 0 ? { guests } : {}),
    isOrganizer: isOrganizer(e),
    ...(reply !== undefined ? { myReply: reply } : {}),
    ...(e.invite
      ? { invite: { from: e.invite.fromName ?? organizerFirstName(e) ?? '', threadId: e.invite.threadId } }
      : {}),
    ...(e.description ? { description: e.description } : {}),
    ...(e.recurring ? { recurring: true } : {}),
  };
}

/** Plans share the grid with events; their entry ids carry this prefix so the two never collide. */
export const PLAN_PREFIX = 'plan:';

export function planEntryId(planId: string): string {
  return `${PLAN_PREFIX}${planId}`;
}

/** The plan id behind an entry id, or null for an event. */
export function planIdOf(entryId: string): string | null {
  return entryId.startsWith(PLAN_PREFIX) ? entryId.slice(PLAN_PREFIX.length) : null;
}

/** A plan found in mail as a dashed "From mail" entry, drawn in the colour of the calendar it would join. */
export function planData(p: Plan, calendar: Pick<CalendarInfo, 'id' | 'name' | 'color'>): CalendarEventData {
  const allDay = p.allDay || p.start.type === 'date';
  const quote = p.quote?.trim();
  return {
    id: planEntryId(p.id),
    title: p.title.trim() ? p.title : 'No title',
    start: isoOfTime(p.start),
    end: isoOfTime(p.end),
    ...(allDay ? { allDay: true } : {}),
    calendar,
    ...(p.location ? { place: p.location } : {}),
    kind: 'plan',
    persisted: false,
    source: {
      from: p.fromName?.trim() || 'your mail',
      subject: quote ? `“${quote}”` : p.title,
      threadId: p.threadId,
    },
  };
}

/** Optimistic changes the container holds until the window catches up (DESIGN 5 rules 1 and 11). */
export interface Overlay {
  /** Field changes by entry id (a move, a resize, an answer). */
  readonly patch: ReadonlyMap<string, Partial<CalendarEventData>>;
  /** Entries gone at once (deleted, hidden, a confirmed or dismissed plan). */
  readonly removed: ReadonlySet<string>;
  /** Entries made here and not yet in the window (a create before its receipt). */
  readonly added: readonly CalendarEventData[];
}

export const EMPTY_OVERLAY: Overlay = { patch: new Map(), removed: new Set(), added: [] };

export function overlayWith(
  overlay: Overlay,
  change: { id: string; patch?: Partial<CalendarEventData>; remove?: boolean; add?: CalendarEventData },
): Overlay {
  const patch = new Map(overlay.patch);
  const removed = new Set(overlay.removed);
  let added = overlay.added;
  if (change.patch) patch.set(change.id, { ...patch.get(change.id), ...change.patch });
  if (change.remove) removed.add(change.id);
  if (change.add) added = [...added.filter(a => a.id !== change.add?.id), change.add];
  return { patch, removed, added };
}

export function overlayWithout(overlay: Overlay, id: string): Overlay {
  const patch = new Map(overlay.patch);
  const removed = new Set(overlay.removed);
  patch.delete(id);
  removed.delete(id);
  return { patch, removed, added: overlay.added.filter(a => a.id !== id) };
}

export interface EntryInputs {
  events: readonly Event[];
  plans: readonly Plan[];
  calendars: readonly Calendar[];
  solo: string | null;
  period: Pick<Period, 'from' | 'to'>;
  /** The calendar plans would join, for their colour. */
  planCalendarId: string | null;
  overlay?: Overlay;
}

const startMs = (e: CalendarEventData): number => new Date(e.start).getTime();

/** The entries a period draws: visible calendars only, cancelled and Aplos-hidden events left out, open plans, overlay applied, in time order. */
export function entriesFor(input: EntryInputs): CalendarEventData[] {
  const { events, plans, calendars, solo, period, planCalendarId, overlay = EMPTY_OVERLAY } = input;
  const visible = new Set(visibleCalendarIds(calendars, solo));
  const byId = new Map(calendars.map(c => [c.id, c]));
  const ref = (c: Calendar) => ({ id: c.id, name: c.name, color: tagFor(c, calendars) });
  const inRange = (e: CalendarEventData): boolean => {
    const s = startMs(e);
    const end = Math.max(s + 1, new Date(e.end).getTime());
    return end > period.from && s < period.to;
  };
  const out: CalendarEventData[] = [];
  for (const e of events) {
    const calendar = byId.get(e.calendarId);
    if (!calendar || !visible.has(calendar.id) || e.hidden || e.status === 'cancelled') continue;
    out.push(eventData(e, ref(calendar)));
  }
  const planCalendar = planCalendarId ? byId.get(planCalendarId) : undefined;
  const planRef = planCalendar
    ? ref(planCalendar)
    : { id: '', name: 'Not on a calendar yet', color: 'dusk' as TagColor };
  for (const p of plans) if (p.state === 'open') out.push(planData(p, planRef));
  for (const a of overlay.added) if (!out.some(e => e.id === a.id)) out.push(a);
  return out
    .filter(e => !overlay.removed.has(e.id))
    .map(e => {
      const patch = overlay.patch.get(e.id);
      return patch ? { ...e, ...patch } : e;
    })
    .filter(inRange)
    .sort((a, b) => startMs(a) - startMs(b) || Number(!a.allDay) - Number(!b.allDay) || a.id.localeCompare(b.id));
}

/** Entries on one day, in reading order: all-day first, then by start. */
export function entriesOnDay(entries: readonly CalendarEventData[], day: IsoDate): CalendarEventData[] {
  const from = dateOf(day).getTime();
  const to = dateOf(addDays(day, 1)).getTime();
  return entries
    .filter(e => {
      const s = startMs(e);
      const end = Math.max(s + 1, new Date(e.end).getTime());
      return e.allDay ? end > from && s < to : s >= from && s < to;
    })
    .sort((a, b) => Number(!a.allDay) - Number(!b.allDay) || startMs(a) - startMs(b) || a.id.localeCompare(b.id));
}

/** Entries in a calendar month (by start day), for the Month label's count. */
export function monthEventCount(entries: readonly CalendarEventData[], ym: IsoYearMonth): number {
  return entries.filter(e => e.kind === 'event' && dayOf(e.start).startsWith(ym)).length;
}

/** Days with something on them, for MiniMonth's quiet marks. */
export function busyDays(entries: readonly CalendarEventData[]): IsoDate[] {
  return [...new Set(entries.map(e => dayOf(e.start)))].sort();
}

/**
 * ↑/↓ in time order: the next or previous entry from `current`, never wrapping; the first (or last) entry when
 * nothing is selected; null when there is nowhere to go.
 */
export function walk(
  entries: readonly CalendarEventData[],
  current: string | null,
  dir: 1 | -1,
): string | null {
  const order = [...entries].sort((a, b) => startMs(a) - startMs(b) || a.id.localeCompare(b.id));
  if (order.length === 0) return null;
  const at = current ? order.findIndex(e => e.id === current) : -1;
  if (at < 0) return (dir === 1 ? order[0] : order[order.length - 1]).id;
  const next = order[at + dir];
  return next ? next.id : null;
}

// ---------------------------------------------------------------------------
// New events and the editor
// ---------------------------------------------------------------------------

/** Minutes since midnight as "HH:MM". */
export function clockOf(minutes: number): IsoTime {
  const m = Math.max(0, Math.min(24 * 60 - 1, Math.round(minutes)));
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

export function minutesOf(time: IsoTime): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

/** A local day and wall-clock time as an instant. */
export function localMs(date: IsoDate, time: IsoTime): EpochMs {
  const { y, m, d } = parseDate(date);
  const [hh, mm] = time.split(':').map(Number);
  return new Date(y, m - 1, d, hh, mm).getTime();
}

/**
 * Where N puts a new hour: today, the next half hour from now; another day, 9 AM. It steps past timed events
 * (declined ones too, which the window leaves out by default) and keeps the start if the day is full.
 */
export function nextFreeSlot(
  day: IsoDate,
  now: EpochMs,
  entries: readonly CalendarEventData[],
  minutes = 60,
): { start: IsoTime; end: IsoTime } {
  const isToday = toIsoDate(now) === day;
  const nowMinutes = Math.round((now - dateOf(day).getTime()) / MINUTE_MS);
  let start = isToday ? Math.ceil(nowMinutes / 30) * 30 : 9 * 60;
  if (start + minutes > 24 * 60) start = Math.max(0, 24 * 60 - minutes);
  const busy = entries
    .filter(e => e.kind === 'event')
    .map(e => timedOn(e, day))
    .filter((t): t is NonNullable<typeof t> => t !== null)
    .map(t => ({ at: t.at * 60, end: t.end * 60 }));
  const first = start;
  while (busy.some(b => b.at < start + minutes && b.end > start)) {
    start += 30;
    if (start + minutes > 24 * 60) {
      start = first;
      break;
    }
  }
  return { start: clockOf(start), end: clockOf(start + minutes) };
}

/** The editor (N, E, a drag on an empty hour): title, day, start and end, calendar; Delete only on a stored event. */
export interface EditorDraft {
  readonly mode: 'new' | 'edit';
  /** The event being edited. */
  readonly eventId?: string;
  readonly title: string;
  readonly date: IsoDate;
  /** Last day of an all-day event (inclusive). */
  readonly endDate: IsoDate;
  readonly start: IsoTime;
  readonly end: IsoTime;
  readonly allDay: boolean;
  readonly calendarId: string | null;
  /** Stored: Delete shows (DESIGN 7.8 Fixes; acceptance 6). */
  readonly persisted: boolean;
  /** Saving asks "This event" or "All events". */
  readonly recurring: boolean;
  /** The sentence under the title field after a refused save. */
  readonly error?: string;
}

export function newDraft(
  day: IsoDate,
  now: EpochMs,
  entries: readonly CalendarEventData[],
  calendarId: string | null,
): EditorDraft {
  const slot = nextFreeSlot(day, now, entries);
  return {
    mode: 'new',
    title: '',
    date: day,
    endDate: day,
    start: slot.start,
    end: slot.end,
    allDay: false,
    calendarId,
    persisted: false,
    recurring: false,
  };
}

/** A drag on an empty hour: the dragged range, on the default calendar. */
export function draftFromRange(range: { start: IsoDateTime; end: IsoDateTime }, calendarId: string | null): EditorDraft {
  const day = dayOf(range.start);
  const start = Math.round(hoursOf(range.start) * 60);
  const endSameDay = dayOf(range.end) === day;
  const end = endSameDay ? Math.round(hoursOf(range.end) * 60) : 24 * 60 - 1;
  return {
    mode: 'new',
    title: '',
    date: day,
    endDate: day,
    start: clockOf(start),
    end: clockOf(Math.max(end, start + 15)),
    allDay: false,
    calendarId,
    persisted: false,
    recurring: false,
  };
}

/** E on an event. */
export function draftFromEvent(e: Event): EditorDraft {
  const start = isoOfTime(e.start);
  const allDay = e.allDay || e.start.type === 'date';
  const lastDay = allDay ? toIsoDate(Math.max(msOf(e.start), msOf(e.end) - MINUTE_MS)) : dayOf(start);
  const end = isoOfTime(e.end);
  return {
    mode: 'edit',
    eventId: e.id,
    title: e.title,
    date: dayOf(start),
    endDate: lastDay,
    start: clockOf(Math.round(hoursOf(start) * 60)),
    end: dayOf(end) === dayOf(start) ? clockOf(Math.round(hoursOf(end) * 60)) : '23:59',
    allDay,
    calendarId: e.calendarId,
    persisted: e.sync !== 'localOnly',
    recurring: e.recurring,
  };
}

/** Delete appears only on a stored event, never on the unsaved draft (DESIGN 7.8 Fixes; acceptance 6). */
export function editorShowsDelete(d: EditorDraft): boolean {
  return d.mode === 'edit' && d.persisted;
}

/** The contract's sentences for a refused save (`EventFields`), or null when it may be saved. */
export function draftProblem(d: EditorDraft): string | null {
  if (!d.title.trim()) return 'Give the event a title.';
  if (d.allDay ? d.endDate < d.date : minutesOf(d.end) <= minutesOf(d.start))
    return 'An event must end after it starts.';
  if (!d.calendarId) return 'Choose a calendar.';
  return null;
}

/** The draft's times as contract fields: instants for a timed event, dates with an exclusive end for an all-day one. */
export function draftTimes(d: EditorDraft): Pick<EventFields, 'start' | 'end' | 'allDay'> {
  if (d.allDay)
    return {
      start: { type: 'date', date: d.date },
      end: { type: 'date', date: addDays(d.endDate, 1) },
      allDay: true,
    };
  return {
    start: { type: 'utc', utc: localMs(d.date, d.start) },
    end: { type: 'utc', utc: localMs(d.date, d.end) },
    allDay: false,
  };
}

const sameTime = (a: EventTime, b: EventTime): boolean =>
  a.type === b.type && (a.type === 'date' ? a.date === (b as typeof a).date : msOf(a) === msOf(b));

/**
 * The `Event/set` change a save makes: a create with every field, or an update with only what changed. `null` when
 * nothing changed. `scope` matters only for a repeating event.
 */
export function draftChange(d: EditorDraft, original: Event | undefined, scope: EventScope): EventChange | null {
  const times = draftTimes(d);
  if (d.mode === 'new' || !original || !d.eventId) {
    if (!d.calendarId) return null;
    return {
      type: 'create',
      calendarId: d.calendarId,
      fields: { title: d.title.trim(), ...times },
    };
  }
  const fields: Partial<EventFields> = {};
  if (d.title.trim() !== original.title) fields.title = d.title.trim();
  if (!sameTime(times.start, original.start)) fields.start = times.start;
  if (!sameTime(times.end, original.end)) fields.end = times.end;
  if (times.allDay !== original.allDay) fields.allDay = times.allDay;
  if (Object.keys(fields).length === 0) return null;
  return { type: 'update', id: d.eventId, scope, fields };
}

/** Start choices: half hours three hours either side of the current start, plus the current one (a menu that fits a 600 px window). */
export function startChoices(current: IsoTime): IsoTime[] {
  const at = minutesOf(current);
  const base = Math.round(at / 30) * 30;
  const out = new Set<number>([at]);
  for (let m = Math.max(0, base - 180); m <= Math.min(23 * 60 + 30, base + 180); m += 30) out.add(m);
  return [...out].sort((a, b) => a - b).map(clockOf);
}

/** End choices: from 15 minutes after the start to six hours after it, with the length beside each. */
export function endChoices(start: IsoTime, current: IsoTime): Array<{ time: IsoTime; length: string }> {
  const from = minutesOf(start);
  const out = new Set<number>([minutesOf(current)]);
  out.add(from + 15);
  for (let m = from + 30; m <= Math.min(24 * 60 - 1, from + 6 * 60); m += 30) out.add(m);
  return [...out]
    .filter(m => m > from && m < 24 * 60)
    .sort((a, b) => a - b)
    .map(m => ({ time: clockOf(m), length: durationText(m - from) }));
}

// ---------------------------------------------------------------------------
// Locked events, scopes, RSVP and undo
// ---------------------------------------------------------------------------

/** Why an event cannot be changed here, in DESIGN 10's voice; the engine's `lockedReason` wins when given. */
export function lockedMessage(e: Event, calendar: Calendar | undefined): string {
  if (e.lockedReason?.trim()) return e.lockedReason.trim();
  if (calendar?.readOnly) return `${calendar.name} is read-only, so its events can't be changed here.`;
  const organizer = organizerFirstName(e);
  if (!isOrganizer(e)) return organizer ? `Only ${organizer} can change this event.` : "Only the organizer can change this event.";
  return "This event can't be changed here.";
}

/** The answers' contract values (`Event/rsvp.response`). */
export const RESPONSE: Readonly<Record<RsvpAnswer, 'accepted' | 'tentative' | 'declined'>> = {
  yes: 'accepted',
  maybe: 'tentative',
  no: 'declined',
};

const ANSWER_WORD: Readonly<Record<RsvpAnswer, string>> = { yes: 'Yes', maybe: 'Maybe', no: 'No' };

/** The RSVP block while it shows: it starts with nothing chosen (DESIGN 7.8). */
export interface RsvpState {
  readonly eventId: string;
  readonly answer: RsvpAnswer | null;
  /** Opened by "Change your reply" on an answered invite. */
  readonly changing: boolean;
}

/** "Send reply" is enabled only once an answer is chosen, and when changing, a different one. */
export function canSendReply(rsvp: RsvpState | null, entry: CalendarEventData | undefined): boolean {
  if (!rsvp || rsvp.answer === null || !entry) return false;
  return !rsvp.changing || rsvp.answer !== (entry.myReply ?? null);
}

/** The toast while the answer is held and undoable, then once it has gone: "Replying Yes to Priya", "Replied Yes to Priya". */
export function rsvpMessage(answer: RsvpAnswer, organizer: string | undefined, phase: 'held' | 'sent'): string {
  const verb = phase === 'held' ? 'Replying' : 'Replied';
  return organizer ? `${verb} ${ANSWER_WORD[answer]} to ${organizer}` : `${verb} ${ANSWER_WORD[answer]}`;
}

/** What Z does to a write: cancel it while it is held (`undoUntil`), else send its inverse, else nothing. */
export function undoMode(
  receipt: Pick<Receipt, 'undoUntil' | 'undoable'>,
  now: EpochMs,
): 'cancel' | 'inverse' | 'none' {
  if (receipt.undoUntil !== undefined && now < receipt.undoUntil) return 'cancel';
  return receipt.undoable === false ? 'none' : 'inverse';
}

/** A held write reads as pending until `undoUntil`; nothing has reached Google before it. */
export function holdPhase(receipt: Pick<Receipt, 'undoUntil'>, now: EpochMs): 'held' | 'sent' {
  return receipt.undoUntil !== undefined && now < receipt.undoUntil ? 'held' : 'sent';
}

// ---------------------------------------------------------------------------
// The screen's state and its one reducer
// ---------------------------------------------------------------------------

/** A change waiting for "This event" or "All events" (ScopeChooser). */
export type PendingChange =
  | { readonly kind: 'move'; readonly start: IsoDateTime; readonly end: IsoDateTime }
  | { readonly kind: 'edit'; readonly draft: EditorDraft }
  | { readonly kind: 'delete' }
  | { readonly kind: 'reply'; readonly answer: RsvpAnswer };

export interface ScopeAsk {
  readonly action: 'move' | 'change' | 'delete' | 'reply';
  readonly entryId: string;
  readonly pending: PendingChange;
}

export interface CalendarState {
  readonly view: GridView;
  /** The day the period is built around. */
  readonly anchor: IsoDate;
  /** Measured pane width; 0 until measured. */
  readonly paneWidth: number;
  readonly selectedId: string | null;
  /** The detail popover (week, month, agenda); the day view's rail follows the selection instead. */
  readonly detailId: string | null;
  /** The ⋯ menu of the open detail. */
  readonly moreOpen: boolean;
  /** The "+N" stack's menu. */
  readonly stackIds: readonly string[] | null;
  /** Answers chosen but not sent, while the RSVP block shows. */
  readonly rsvp: RsvpState | null;
  readonly scope: ScopeAsk | null;
  readonly editor: EditorDraft | null;
  /** ⌥-click: one calendar alone, for this session. */
  readonly solo: string | null;
  /** The sidebar's month when paged away from the anchor; null follows the anchor. */
  readonly miniMonth: IsoYearMonth | null;
}

export function initialState(today: IsoDate, view: GridView = 'week'): CalendarState {
  return {
    view,
    anchor: today,
    paneWidth: 0,
    selectedId: null,
    detailId: null,
    moreOpen: false,
    stackIds: null,
    rsvp: null,
    scope: null,
    editor: null,
    solo: null,
    miniMonth: null,
  };
}

/** What the reducer reads besides the state. */
export interface CalendarContext {
  readonly now: EpochMs;
  readonly weekStartsOn: 0 | 1;
  /** The period's visible entries, overlay applied (`entriesFor`). */
  readonly entries: readonly CalendarEventData[];
  readonly events: ReadonlyMap<string, Event>;
  readonly plans: ReadonlyMap<string, Plan>;
  readonly calendars: readonly Calendar[];
  /** Where new events and confirmed plans go. */
  readonly defaultCalendarId: string | null;
}

export type CalendarAction =
  | { type: 'width'; px: number }
  | { type: 'today' }
  | { type: 'view'; view: GridView }
  | { type: 'period'; dir: 1 | -1 }
  | { type: 'pick'; date: IsoDate }
  | { type: 'miniMonth'; month: IsoYearMonth }
  | { type: 'select'; id: string }
  | { type: 'walk'; dir: 1 | -1 }
  | { type: 'open'; id?: string }
  | { type: 'return' }
  | { type: 'close' }
  | { type: 'escape' }
  | { type: 'openStack'; ids: readonly string[] }
  | { type: 'closeStack' }
  | { type: 'more'; open: boolean }
  | { type: 'menu'; item: DetailMenuId }
  | { type: 'answer'; answer: RsvpAnswer }
  | { type: 'sendReply' }
  | { type: 'scope'; scope: EventScope }
  | { type: 'scopeCancel' }
  | { type: 'newEvent' }
  | { type: 'createRange'; start: IsoDateTime; end: IsoDateTime }
  | { type: 'edit' }
  | { type: 'editor'; patch: Partial<Pick<EditorDraft, 'title' | 'date' | 'start' | 'end' | 'calendarId'>> }
  | { type: 'editorSave' }
  | { type: 'editorCancel' }
  | { type: 'delete' }
  | { type: 'move'; id: string; start: IsoDateTime; end: IsoDateTime }
  | { type: 'resize'; id: string; end: IsoDateTime }
  | { type: 'confirmPlan' }
  | { type: 'openInvite' }
  | { type: 'openSource' }
  | { type: 'openVideo' }
  | { type: 'toggleCalendar'; id: string }
  | { type: 'soloCalendar'; id: string };

/** A toast to push: one operation, one notice (DESIGN 7.13). */
export interface ToastPlan {
  readonly kind: ToastKind;
  readonly message: string;
  readonly undoable: boolean;
}

/** An optimistic change to apply at once (DESIGN 5 rule 1) and drop when the receipt or a failure comes back. */
export interface OptimisticChange {
  readonly id: string;
  readonly patch?: Partial<CalendarEventData>;
  readonly remove?: boolean;
  readonly add?: CalendarEventData;
}

export type CalendarEffect =
  | {
      kind: 'eventSet';
      change: EventChange;
      optimistic: OptimisticChange;
      /** Toasted with Undo (a delete); else Z still undoes it through the undo stack with `undoLabel`. */
      toast?: ToastPlan;
      undoLabel: string;
      /** The sentence if it is refused: "Couldn't move Q4 review." */
      failure: string;
    }
  | {
      kind: 'rsvp';
      id: string;
      response: 'accepted' | 'tentative' | 'declined';
      scope: EventScope;
      optimistic: OptimisticChange;
      answer: RsvpAnswer;
      organizer?: string;
      failure: string;
    }
  | { kind: 'calendarSet'; id: string; shown: boolean }
  | { kind: 'planConfirm'; planId: string; calendarId: string | null; optimistic: OptimisticChange }
  | { kind: 'planDismiss'; planId: string; optimistic: OptimisticChange }
  | { kind: 'eventHide'; id: string; optimistic: OptimisticChange; toast: ToastPlan }
  | { kind: 'openThread'; threadId: string }
  | { kind: 'openUrl'; url: string }
  | { kind: 'copy'; text: string; toast: ToastPlan }
  | { kind: 'notice'; message: string }
  | { kind: 'focus'; target: 'grid' | 'rail' };

export interface Transition {
  readonly state: CalendarState;
  readonly effects: readonly CalendarEffect[];
  /** False when the action did nothing, so a key falls through (the Esc ladder's next rung). */
  readonly handled: boolean;
}

const done = (state: CalendarState, effects: CalendarEffect[] = [], handled = true): Transition => ({
  state,
  effects,
  handled,
});

/** Close every transient surface (popover, its menu, the stack menu, the RSVP choice, a pending scope). */
function closed(state: CalendarState): CalendarState {
  return { ...state, detailId: null, moreOpen: false, stackIds: null, rsvp: null, scope: null };
}

/** The view the pane draws right now. */
export function shownView(state: CalendarState): CalendarView {
  return shownViewFor(state.view, state.paneWidth);
}

export function entryById(ctx: CalendarContext, id: string | null | undefined): CalendarEventData | undefined {
  return id ? ctx.entries.find(e => e.id === id) : undefined;
}

/** The entry the day view's rail shows: the selection when it is on that day, else the day's first entry. */
export function railEntry(state: CalendarState, ctx: CalendarContext): CalendarEventData | undefined {
  if (shownView(state) !== 'day') return undefined;
  const day = entriesOnDay(ctx.entries, state.anchor);
  return day.find(e => e.id === state.selectedId) ?? day[0];
}

/** The open detail: the popover's entry, or the day rail's. */
export function detailEntry(state: CalendarState, ctx: CalendarContext): CalendarEventData | undefined {
  return entryById(ctx, state.detailId) ?? railEntry(state, ctx);
}

/**
 * The RSVP block of the open detail: shown for an unanswered invite (nothing chosen) or after "Change your reply".
 * Y/M/N answer only while this is not null; otherwise M means Month and N a new event (DESIGN 7.8, 8).
 */
export function liveRsvp(state: CalendarState, ctx: CalendarContext): RsvpState | null {
  const entry = detailEntry(state, ctx);
  if (!entry || entry.kind !== 'event' || state.editor || state.scope) return null;
  if (state.rsvp && state.rsvp.eventId === entry.id) return state.rsvp;
  return entry.unanswered ? { eventId: entry.id, answer: null, changing: false } : null;
}

/** The registry condition `invite`: an unanswered invite (or a reply being changed) is open. */
export function inviteOpen(state: CalendarState, ctx: CalendarContext): boolean {
  return liveRsvp(state, ctx) !== null;
}

/** The ⋯ menu's items for an entry: edit and delete on your own, change your reply on an invite, hide, copy link. */
export type DetailMenuId = 'edit' | 'delete' | 'changeReply' | 'hide' | 'copyLink' | 'notNow';

export function detailMenu(entry: CalendarEventData, ctx: CalendarContext): MenuEntry[] {
  if (entry.kind === 'plan') return [{ kind: 'item', id: 'notNow', label: 'Not now' }];
  const event = ctx.events.get(entry.id);
  const calendar = event ? ctx.calendars.find(c => c.id === event.calendarId) : undefined;
  const items: MenuEntry[] = [];
  const editable = event ? event.can.edit && !calendar?.readOnly : entry.isOrganizer === true;
  if (editable) items.push({ kind: 'item', id: 'edit', label: 'Edit', commandId: 'calendar.edit' });
  else if (event)
    items.push({
      kind: 'item',
      id: 'edit',
      label: 'Edit',
      disabled: true,
      detail: lockedMessage(event, calendar),
    });
  if (entry.myReply !== undefined && (event?.can.rsvp ?? true) && !entry.unanswered)
    items.push({ kind: 'item', id: 'changeReply', label: 'Change your reply' });
  if (event && (event.conference?.url || event.htmlLink))
    items.push({ kind: 'item', id: 'copyLink', label: 'Copy link' });
  if (entry.persisted) items.push({ kind: 'item', id: 'hide', label: 'Hide in Aplos' });
  // Delete only on a stored event you may delete (DESIGN 7.8 Fixes; acceptance 6).
  if (entry.persisted && (event ? event.can.delete && !calendar?.readOnly : editable)) {
    items.push({ kind: 'separator' });
    items.push({ kind: 'item', id: 'delete', label: 'Delete', commandId: 'calendar.delete', danger: true });
  }
  return items;
}

function decideScope(
  state: CalendarState,
  entry: CalendarEventData,
  action: ScopeAsk['action'],
  pending: PendingChange,
): CalendarState {
  return { ...state, moreOpen: false, stackIds: null, scope: { action, entryId: entry.id, pending } };
}

function failureFor(verb: 'move' | 'change' | 'delete', title: string): string {
  return `Couldn't ${verb} ${title}.`;
}

/** The change a move or resize makes, or why it can't, or the scope question first. */
function moveTransition(
  state: CalendarState,
  ctx: CalendarContext,
  id: string,
  start: IsoDateTime,
  end: IsoDateTime,
  scope?: EventScope,
): Transition {
  const entry = entryById(ctx, id);
  const event = ctx.events.get(id);
  if (!entry || entry.kind !== 'event') return done(state, [], false);
  if (!event || !entry.persisted) return done(state, [], false);
  const calendar = ctx.calendars.find(c => c.id === event.calendarId);
  if (!event.can.move || calendar?.readOnly)
    return done(state, [{ kind: 'notice', message: lockedMessage(event, calendar) }]);
  if (event.recurring && !scope)
    return done(decideScope(state, entry, 'move', { kind: 'move', start, end }));
  const fields: Partial<EventFields> = {};
  const startUtc = new Date(start).getTime();
  const endUtc = new Date(end).getTime();
  if (startUtc !== msOf(event.start)) fields.start = { type: 'utc', utc: startUtc };
  if (endUtc !== msOf(event.end)) fields.end = { type: 'utc', utc: endUtc };
  if (Object.keys(fields).length === 0) return done({ ...state, scope: null });
  return done({ ...state, scope: null, selectedId: id }, [
    {
      kind: 'eventSet',
      change: { type: 'update', id, scope: scope ?? 'occurrence', fields },
      optimistic: { id, patch: { start: toIsoDateTime(startUtc), end: toIsoDateTime(endUtc) } },
      undoLabel: `Moved ${entry.title}`,
      failure: failureFor('move', entry.title),
    },
  ]);
}

function deleteTransition(state: CalendarState, ctx: CalendarContext, scope?: EventScope): Transition {
  const id =
    state.scope?.entryId ?? state.editor?.eventId ?? state.detailId ?? state.selectedId ?? railEntry(state, ctx)?.id;
  const entry = entryById(ctx, id);
  const event = id ? ctx.events.get(id) : undefined;
  // Never on an unsaved event or a plan (acceptance 6).
  if (!entry || entry.kind !== 'event' || !entry.persisted || !event) return done(state, [], false);
  const calendar = ctx.calendars.find(c => c.id === event.calendarId);
  if (!event.can.delete || calendar?.readOnly)
    return done(state, [{ kind: 'notice', message: lockedMessage(event, calendar) }]);
  if (event.recurring && !scope) return done(decideScope({ ...state, editor: null }, entry, 'delete', { kind: 'delete' }));
  // Focus never lost: the selection moves on to the next event in time order, else the previous one.
  const rest = ctx.entries.filter(e => e.id !== entry.id);
  const next = walk(ctx.entries, entry.id, 1) ?? walk(ctx.entries, entry.id, -1);
  return done(
    { ...closed(state), editor: null, selectedId: next && rest.some(e => e.id === next) ? next : null },
    [
      {
        kind: 'eventSet',
        change: { type: 'destroy', id: entry.id, scope: scope ?? 'occurrence' },
        optimistic: { id: entry.id, remove: true },
        toast: { kind: 'trash', message: 'Event deleted', undoable: true },
        undoLabel: 'Event deleted',
        failure: failureFor('delete', entry.title),
      },
      { kind: 'focus', target: 'grid' },
    ],
  );
}

function rsvpTransition(state: CalendarState, ctx: CalendarContext, scope?: EventScope): Transition {
  const live = liveRsvp(state, ctx);
  const entry = detailEntry(state, ctx);
  const event = entry ? ctx.events.get(entry.id) : undefined;
  if (!live || !entry || !event || !canSendReply(live, entry) || live.answer === null) return done(state, [], false);
  if (event.recurring && !scope)
    return done(decideScope(state, entry, 'reply', { kind: 'reply', answer: live.answer }));
  return sendReply(state, entry, event, live.answer, scope ?? 'occurrence');
}

function sendReply(
  state: CalendarState,
  entry: CalendarEventData,
  event: Event,
  answer: RsvpAnswer,
  scope: EventScope,
): Transition {
  const guests = entry.guests?.map(g =>
    g.isYou ? { ...g, status: (answer === 'yes' ? 'going' : answer === 'maybe' ? 'maybe' : 'declined') as EventGuest['status'] } : g,
  );
  return done({ ...state, rsvp: null, scope: null }, [
    {
      kind: 'rsvp',
      id: entry.id,
      response: RESPONSE[answer],
      scope,
      answer,
      organizer: organizerFirstName(event),
      optimistic: { id: entry.id, patch: { myReply: answer, unanswered: false, ...(guests ? { guests } : {}) } },
      failure: `Couldn't send your reply to ${entry.title}.`,
    },
  ]);
}

function saveEditor(state: CalendarState, ctx: CalendarContext, scope?: EventScope): Transition {
  const draft = state.scope?.pending.kind === 'edit' ? state.scope.pending.draft : state.editor;
  if (!draft) return done(state, [], false);
  const problem = draftProblem(draft);
  if (problem) return done({ ...state, editor: { ...draft, error: problem } });
  const original = draft.eventId ? ctx.events.get(draft.eventId) : undefined;
  if (draft.mode === 'edit' && original?.recurring && !scope) {
    const entry = entryById(ctx, draft.eventId);
    if (entry) return done(decideScope({ ...state, editor: null }, entry, 'change', { kind: 'edit', draft }));
  }
  const change = draftChange(draft, original, scope ?? 'occurrence');
  const next = { ...closed(state), editor: null };
  if (!change) return done(next);
  if (change.type === 'create') {
    const calendar = ctx.calendars.find(c => c.id === change.calendarId);
    const times = draftTimes(draft);
    const tempId = `new:${draft.date}:${draft.start}:${draft.title.trim()}`;
    const entry: CalendarEventData = {
      id: tempId,
      title: draft.title.trim(),
      start: isoOfTime(times.start),
      end: isoOfTime(times.end),
      ...(draft.allDay ? { allDay: true } : {}),
      calendar: calendar
        ? { id: calendar.id, name: calendar.name, color: tagFor(calendar, ctx.calendars) }
        : { id: '', name: '', color: 'dusk' },
      kind: 'event',
      persisted: false,
      isOrganizer: true,
    };
    return done({ ...next, selectedId: tempId, anchor: draft.date }, [
      {
        kind: 'eventSet',
        change,
        optimistic: { id: tempId, add: entry },
        undoLabel: `Added ${entry.title}`,
        failure: `Couldn't add ${entry.title}.`,
      },
    ]);
  }
  const entry = entryById(ctx, draft.eventId);
  const title = draft.title.trim();
  const times = draftTimes(draft);
  return done({ ...next, selectedId: draft.eventId ?? null }, [
    {
      kind: 'eventSet',
      change,
      optimistic: {
        id: draft.eventId ?? '',
        patch: { title, start: isoOfTime(times.start), end: isoOfTime(times.end) },
      },
      undoLabel: `Changed ${title}`,
      failure: failureFor('change', entry?.title ?? title),
    },
  ]);
}

/** The one reducer: every key, click and drag of the screen goes through here (DESIGN 5 rule 1: state first, then effects). */
export function update(state: CalendarState, action: CalendarAction, ctx: CalendarContext): Transition {
  switch (action.type) {
    case 'width':
      return action.px === state.paneWidth ? done(state, [], false) : done({ ...state, paneWidth: action.px });
    case 'today':
      return done({ ...closed(state), anchor: toIsoDate(ctx.now), miniMonth: null });
    case 'view':
      return done({ ...closed(state), view: action.view });
    case 'period':
      return done({ ...closed(state), anchor: stepAnchor(shownView(state), state.anchor, action.dir), miniMonth: null });
    case 'pick':
      return done({ ...closed(state), anchor: action.date, miniMonth: null });
    case 'miniMonth':
      return done({ ...state, miniMonth: action.month });
    case 'select': {
      const keep = state.rsvp?.eventId === action.id ? state.rsvp : null;
      // A pick inside the stack menu opens that event; a click on the grid only selects.
      return done({ ...state, selectedId: action.id, detailId: null, moreOpen: false, stackIds: null, rsvp: keep, scope: null });
    }
    case 'walk': {
      const next = walk(ctx.entries, state.selectedId, action.dir);
      return next ? done({ ...state, selectedId: next, detailId: null, moreOpen: false, rsvp: null }) : done(state, [], false);
    }
    case 'open': {
      const id = action.id ?? state.selectedId;
      const entry = entryById(ctx, id);
      if (!entry) return done(state, [], false);
      if (shownView(state) === 'day')
        return done({ ...closed(state), selectedId: entry.id }, [{ kind: 'focus', target: 'rail' }]);
      return done({ ...closed(state), selectedId: entry.id, detailId: entry.id });
    }
    case 'return': {
      // Return sends a chosen answer while the RSVP block shows; otherwise it opens the selection.
      const live = liveRsvp(state, ctx);
      if (live && live.answer !== null) return rsvpTransition(state, ctx);
      return update(state, { type: 'open' }, ctx);
    }
    case 'close':
      return done(closed(state), state.detailId ? [{ kind: 'focus', target: 'grid' }] : [], state.detailId !== null);
    case 'escape': {
      // The ladder: scope question, ⋯ menu, stack menu, popover, then the selection; never leaves Calendar.
      if (state.scope) return done({ ...state, scope: null });
      if (state.moreOpen) return done({ ...state, moreOpen: false });
      if (state.stackIds) return done({ ...state, stackIds: null });
      if (state.detailId) return done(closed(state), [{ kind: 'focus', target: 'grid' }]);
      if (state.rsvp) return done({ ...state, rsvp: null });
      if (state.selectedId) return done({ ...state, selectedId: null });
      return done(state, [], false);
    }
    case 'openStack':
      return done({ ...closed(state), stackIds: [...action.ids] });
    case 'closeStack':
      return done({ ...state, stackIds: null });
    case 'more':
      return done({ ...state, moreOpen: action.open });
    case 'menu': {
      const entry = detailEntry(state, ctx);
      if (!entry) return done(state, [], false);
      const s = { ...state, moreOpen: false };
      if (action.item === 'edit') return update(s, { type: 'edit' }, ctx);
      if (action.item === 'delete') return update({ ...s, selectedId: entry.id }, { type: 'delete' }, ctx);
      if (action.item === 'changeReply')
        return done({ ...s, rsvp: { eventId: entry.id, answer: entry.myReply ?? null, changing: true } });
      if (action.item === 'notNow') {
        const planId = planIdOf(entry.id);
        if (!planId) return done(s, [], false);
        return done({ ...closed(s), selectedId: null }, [
          { kind: 'planDismiss', planId, optimistic: { id: entry.id, remove: true } },
        ]);
      }
      if (action.item === 'hide')
        return done({ ...closed(s), selectedId: null }, [
          {
            kind: 'eventHide',
            id: entry.id,
            optimistic: { id: entry.id, remove: true },
            toast: { kind: 'info', message: 'Hidden in Aplos', undoable: true },
          },
        ]);
      const event = ctx.events.get(entry.id);
      const link = event?.conference?.url ?? event?.htmlLink;
      if (!link) return done(s, [], false);
      return done(s, [{ kind: 'copy', text: link, toast: { kind: 'info', message: 'Link copied', undoable: false } }]);
    }
    case 'answer': {
      const live = liveRsvp(state, ctx);
      if (!live) return done(state, [], false);
      return done({ ...state, rsvp: { ...live, answer: action.answer } });
    }
    case 'sendReply':
      return rsvpTransition(state, ctx);
    case 'scope': {
      const ask = state.scope;
      if (!ask) return done(state, [], false);
      const p = ask.pending;
      if (p.kind === 'move') return moveTransition(state, ctx, ask.entryId, p.start, p.end, action.scope);
      if (p.kind === 'delete') return deleteTransition(state, ctx, action.scope);
      if (p.kind === 'edit') return saveEditor(state, ctx, action.scope);
      const entry = entryById(ctx, ask.entryId);
      const event = ctx.events.get(ask.entryId);
      if (!entry || !event) return done({ ...state, scope: null }, [], false);
      return sendReply(state, entry, event, p.answer, action.scope);
    }
    case 'scopeCancel':
      return done({ ...state, scope: null });
    case 'newEvent': {
      // Today when it is in view (the next free half hour), else the anchor day at 9 AM.
      const shown = shownView(state);
      const today = toIsoDate(ctx.now);
      const inView = periodOf(shown, state.anchor, ctx.weekStartsOn).days.includes(today);
      const day = shown !== 'day' && inView ? today : state.anchor;
      return done({ ...closed(state), editor: newDraft(day, ctx.now, ctx.entries, ctx.defaultCalendarId) });
    }
    case 'createRange':
      return done({
        ...closed(state),
        editor: draftFromRange({ start: action.start, end: action.end }, ctx.defaultCalendarId),
      });
    case 'edit': {
      const target = entryById(ctx, state.detailId ?? state.selectedId) ?? railEntry(state, ctx);
      const event = target ? ctx.events.get(target.id) : undefined;
      if (!target || target.kind !== 'event' || !event) return done(state, [], false);
      const calendar = ctx.calendars.find(c => c.id === event.calendarId);
      if (!event.can.edit || calendar?.readOnly)
        return done(state, [{ kind: 'notice', message: lockedMessage(event, calendar) }]);
      return done({ ...closed(state), selectedId: target.id, editor: draftFromEvent(event) });
    }
    case 'editor': {
      if (!state.editor) return done(state, [], false);
      const next = { ...state.editor, ...action.patch, error: undefined };
      // Moving the start keeps the length.
      if (action.patch.start && !action.patch.end) {
        const length = minutesOf(state.editor.end) - minutesOf(state.editor.start);
        const end = Math.min(24 * 60 - 1, minutesOf(action.patch.start) + Math.max(15, length));
        return done({ ...state, editor: { ...next, end: clockOf(end) } });
      }
      if (action.patch.date && !state.editor.allDay) return done({ ...state, editor: { ...next, endDate: action.patch.date } });
      return done({ ...state, editor: next });
    }
    case 'editorSave':
      return saveEditor(state, ctx);
    case 'editorCancel':
      return done({ ...state, editor: null });
    case 'delete':
      return deleteTransition(state, ctx);
    case 'move':
      return moveTransition(state, ctx, action.id, action.start, action.end);
    case 'resize': {
      const entry = entryById(ctx, action.id);
      if (!entry) return done(state, [], false);
      return moveTransition(state, ctx, action.id, entry.start, action.end);
    }
    case 'confirmPlan': {
      const entry = detailEntry(state, ctx);
      const planId = entry ? planIdOf(entry.id) : null;
      if (!entry || !planId) return done(state, [], false);
      return done({ ...closed(state), selectedId: null }, [
        { kind: 'planConfirm', planId, calendarId: ctx.defaultCalendarId, optimistic: { id: entry.id, remove: true } },
      ]);
    }
    case 'openInvite': {
      const entry = detailEntry(state, ctx);
      return entry?.invite ? done(state, [{ kind: 'openThread', threadId: entry.invite.threadId }]) : done(state, [], false);
    }
    case 'openSource': {
      const entry = detailEntry(state, ctx);
      return entry?.source ? done(state, [{ kind: 'openThread', threadId: entry.source.threadId }]) : done(state, [], false);
    }
    case 'openVideo': {
      const entry = detailEntry(state, ctx);
      const url = entry ? ctx.events.get(entry.id)?.conference?.url : undefined;
      return url ? done(state, [{ kind: 'openUrl', url }]) : done(state, [], false);
    }
    case 'toggleCalendar': {
      // A plain click while one calendar is shown alone leaves solo and brings the saved set back.
      if (state.solo) return done({ ...state, solo: null });
      const calendar = ctx.calendars.find(c => c.id === action.id);
      if (!calendar) return done(state, [], false);
      return done(state, [{ kind: 'calendarSet', id: calendar.id, shown: !calendar.shown }]);
    }
    case 'soloCalendar':
      return done({ ...closed(state), solo: state.solo === action.id ? null : action.id });
  }
}

// ---------------------------------------------------------------------------
// Commands (renderer/commands catalog, context `calendar`)
// ---------------------------------------------------------------------------

/** Every calendar command the screen attaches a handler to. */
export const CALENDAR_COMMAND_IDS = [
  'calendar.today',
  'calendar.dayView',
  'calendar.weekView',
  'calendar.monthView',
  'calendar.nextPeriod',
  'calendar.previousPeriod',
  'calendar.newEvent',
  'calendar.open',
  'calendar.edit',
  'calendar.delete',
  'calendar.answerYes',
  'calendar.answerMaybe',
  'calendar.answerNo',
] as const satisfies readonly CommandId[];

export type CalendarCommandId = (typeof CALENDAR_COMMAND_IDS)[number];

/** The action a command runs. Y/M/N reach `answer` only while the `invite` condition holds; the registry routes M and N otherwise. */
export function actionForCommand(id: CalendarCommandId): CalendarAction {
  switch (id) {
    case 'calendar.today':
      return { type: 'today' };
    case 'calendar.dayView':
      return { type: 'view', view: 'day' };
    case 'calendar.weekView':
      return { type: 'view', view: 'week' };
    case 'calendar.monthView':
      return { type: 'view', view: 'month' };
    case 'calendar.nextPeriod':
      return { type: 'period', dir: 1 };
    case 'calendar.previousPeriod':
      return { type: 'period', dir: -1 };
    case 'calendar.newEvent':
      return { type: 'newEvent' };
    case 'calendar.open':
      return { type: 'return' };
    case 'calendar.edit':
      return { type: 'edit' };
    case 'calendar.delete':
      return { type: 'delete' };
    case 'calendar.answerYes':
      return { type: 'answer', answer: 'yes' };
    case 'calendar.answerMaybe':
      return { type: 'answer', answer: 'maybe' };
    case 'calendar.answerNo':
      return { type: 'answer', answer: 'no' };
  }
}

/** A command's `when`: open, edit and delete need a selection; answers need an open invite; the rest always run. */
export function commandEnabled(id: CalendarCommandId, state: CalendarState, ctx: CalendarContext): boolean {
  if (state.editor) return false;
  const selected = entryById(ctx, state.detailId ?? state.selectedId) ?? railEntry(state, ctx);
  switch (id) {
    case 'calendar.open':
      return selected !== undefined || inviteOpen(state, ctx);
    case 'calendar.edit':
      return selected?.kind === 'event';
    case 'calendar.delete':
      return selected?.kind === 'event' && selected.persisted;
    case 'calendar.answerYes':
    case 'calendar.answerMaybe':
    case 'calendar.answerNo':
      return inviteOpen(state, ctx);
    default:
      return true;
  }
}

/** The palette's context line for the open or selected entry: "Q4 review · Fri 11:00 AM". */
export function commandTarget(
  state: CalendarState,
  ctx: CalendarContext,
): { kind: 'event' | 'plan'; id: string; title: string; detail: string } | null {
  const entry = entryById(ctx, state.detailId ?? state.selectedId);
  if (!entry) return null;
  const planId = planIdOf(entry.id);
  const when = entry.allDay ? `${longDay(dayOf(entry.start))} · all day` : `${longDay(dayOf(entry.start))} · ${timeOf(entry.start)}`;
  return { kind: planId ? 'plan' : 'event', id: planId ?? entry.id, title: entry.title, detail: when };
}

// ---------------------------------------------------------------------------
// The view model CalendarScreen draws
// ---------------------------------------------------------------------------

export interface EditorView {
  readonly draft: EditorDraft;
  readonly title: string;
  readonly showDelete: boolean;
  /** "Thursday, October 29, 2026". */
  readonly dateLabel: string;
  readonly startLabel: string;
  readonly endLabel: string;
  readonly startChoices: readonly IsoTime[];
  readonly endChoices: ReadonlyArray<{ time: IsoTime; length: string }>;
  /** Calendars a new event can go on; an existing event shows its own, fixed. */
  readonly calendars: ReadonlyArray<{ id: string; name: string; color: TagColor }>;
  readonly calendar: { id: string; name: string; color: TagColor } | null;
  readonly calendarFixed: boolean;
  /** For the day picker's today badge and first weekday. */
  readonly today: IsoDate;
  readonly weekStartsOn: 0 | 1;
}

export interface CalendarViewModel {
  readonly view: GridView;
  readonly shown: CalendarView;
  readonly period: Period;
  readonly head: { label: string; range: string };
  readonly gridLabel: string;
  readonly periodWord: 'day' | 'week' | 'month';
  readonly entries: readonly CalendarEventData[];
  readonly now: IsoDateTime;
  readonly weekStartsOn: 0 | 1;
  readonly selectedId: string | undefined;
  /** The day view's rail (hidden when the day is empty or the pane is narrow). */
  readonly rail: CalendarEventData | null;
  /** The popover's entry. */
  readonly popover: CalendarEventData | null;
  /** The RSVP block of the rail or popover, with "Send reply" enabled only after a choice. */
  readonly reply: { answer: RsvpAnswer | null; canSend: boolean } | null;
  readonly more: readonly MenuEntry[];
  readonly moreOpen: boolean;
  readonly stack: { ids: readonly string[]; label: string; entries: readonly MenuEntry[] } | null;
  readonly scope: { action: ScopeAsk['action']; title: string; entryId: string } | null;
  readonly editor: EditorView | null;
  /** DESIGN 7.14: "Nothing scheduled." with New event · N, on an empty day. */
  readonly emptyAction: boolean;
}

export function viewModel(state: CalendarState, ctx: CalendarContext): CalendarViewModel {
  const shown = shownView(state);
  const period = periodOf(shown, state.anchor, ctx.weekStartsOn);
  const entries = ctx.entries;
  const dayCount = entriesOnDay(entries, state.anchor).length;
  const rail = shown === 'day' ? (railEntry(state, ctx) ?? null) : null;
  const popover = shown === 'day' ? null : (entryById(ctx, state.detailId) ?? null);
  const detail = popover ?? rail;
  const live = liveRsvp(state, ctx);
  const stackEntries = state.stackIds
    ? state.stackIds.map(id => entryById(ctx, id)).filter((e): e is CalendarEventData => e !== undefined)
    : [];
  const scopeEntry = state.scope ? entryById(ctx, state.scope.entryId) : undefined;
  return {
    view: state.view,
    shown,
    period,
    head: topLabel(shown, period, state.anchor, monthEventCount(entries, yearMonthOf(state.anchor))),
    gridLabel: gridLabel(shown, period, state.anchor, dayCount),
    periodWord: periodWord(shown),
    entries,
    now: toIsoDateTime(ctx.now),
    weekStartsOn: ctx.weekStartsOn,
    selectedId: entryById(ctx, state.selectedId)?.id,
    rail,
    popover,
    reply: live && detail && live.eventId === detail.id ? { answer: live.answer, canSend: canSendReply(live, detail) } : null,
    more: detail ? detailMenu(detail, ctx) : [],
    moreOpen: state.moreOpen && detail !== null,
    stack:
      stackEntries.length > 0
        ? {
            ids: stackEntries.map(e => e.id),
            label: `${stackEntries.length} more at ${timeOf(stackEntries[0].start)}`,
            entries: [
              { kind: 'label', label: `${stackEntries.length} more at ${timeOf(stackEntries[0].start)}` },
              ...stackEntries.map(
                (e): MenuEntry => ({
                  kind: 'item',
                  id: e.id,
                  label: e.title,
                  swatch: e.calendar.color,
                  aside: e.allDay ? 'All day' : rangeOf(e.start, e.end),
                }),
              ),
            ],
          }
        : null,
    scope: state.scope && scopeEntry ? { action: state.scope.action, title: scopeEntry.title, entryId: scopeEntry.id } : null,
    editor: state.editor ? editorView(state.editor, ctx) : null,
    emptyAction: shown === 'day' || shown === 'agenda',
  };
}

function editorView(draft: EditorDraft, ctx: CalendarContext): EditorView {
  const ref = (c: Calendar) => ({ id: c.id, name: c.name, color: tagFor(c, ctx.calendars) });
  const own = ctx.calendars.find(c => c.id === draft.calendarId);
  return {
    draft,
    title: draft.mode === 'new' ? 'New event' : 'Edit event',
    showDelete: editorShowsDelete(draft),
    dateLabel: dayTitle(draft.date),
    startLabel: formatClock(draft.start),
    endLabel: formatClock(draft.end),
    startChoices: startChoices(draft.start),
    endChoices: endChoices(draft.start, draft.end),
    calendars: writableCalendars(ctx.calendars).map(ref),
    calendar: own ? ref(own) : null,
    calendarFixed: draft.mode === 'edit',
    today: toIsoDate(ctx.now),
    weekStartsOn: ctx.weekStartsOn,
  };
}
