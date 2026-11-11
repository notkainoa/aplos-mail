/** Calendars (colour, visibility), contract events and plans as grid entries, the optimistic overlay, and the walk. */
import { toIsoDate, type Calendar, type Event, type Plan, type State } from '../../../data';
import type {
  CalendarEventData,
  CalendarInfo,
  EventGuest,
  IsoDate,
  IsoYearMonth,
  RsvpAnswer,
  TagColor,
} from '../../../ui/props';
import { addDays, dateOf, dayOf, minutesBetween } from '../../../ui/calendar/dates';
import { firstNameOf } from '../../../ui/calendar/EventDetail';
import type { Period } from './period';
import { displayUrl, isoOfTime, msOf } from './period';
import { MINUTE_MS } from './units';

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
  return calendars.map(c => ({
    id: c.id,
    name: c.name,
    color: tagFor(c, calendars),
    visible: visible.has(c.id),
  }));
}

/** Calendars a new event can go on. An existing event keeps its calendar: `Event/set` updates cannot move it. */
export function writableCalendars(calendars: readonly Calendar[]): Calendar[] {
  return calendars.filter(c => !c.readOnly);
}

/**
 * Where N, a drag and a confirmed plan land: the solo calendar; else the saved default, the primary, then the
 * first — each only while it is shown and writable, so a new event never lands on a calendar it would vanish
 * from the moment it was added (review2 3).
 */
export function defaultCalendarId(
  calendars: readonly Calendar[],
  setting?: string,
  solo?: string | null,
): string | null {
  const writable = writableCalendars(calendars);
  // Solo draws that one calendar alone; anywhere else is invisible.
  if (solo && calendars.some(c => c.id === solo))
    return writable.find(c => c.id === solo)?.id ?? null;
  return (
    writable.find(c => c.id === setting && c.shown)?.id ??
    writable.find(c => c.primary && c.shown)?.id ??
    writable.find(c => c.shown)?.id ??
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
  return [...guests.filter(g => g.first), ...guests.filter(g => !g.first)].map(
    ({ first, ...g }) => {
      void first;
      return g;
    },
  );
}

/** Events of a day or more are drawn in the all-day strip, as Google Calendar draws them; the grid shows a timed entry only on its first day. */
export const STRIP_MINUTES = 24 * 60;

/** One contract event as the grid's entry. `locked` lifts the move cursor and the resize handles (TimeGrid/EventBlock). */
export function eventData(
  e: Event,
  calendar: Pick<CalendarInfo, 'id' | 'name' | 'color'>,
  locked = false,
): CalendarEventData {
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
  const reply =
    e.myResponse === undefined || isOrganizer(e) ? undefined : (REPLY[e.myResponse] ?? null);
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
      ? {
          invite: {
            from: e.invite.fromName ?? organizerFirstName(e) ?? '',
            threadId: e.invite.threadId,
          },
        }
      : {}),
    ...(e.description ? { description: e.description } : {}),
    ...(e.recurring ? { recurring: true } : {}),
    ...(locked ? { locked: true } : {}),
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
export function planData(
  p: Plan,
  calendar: Pick<CalendarInfo, 'id' | 'name' | 'color'>,
): CalendarEventData {
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

/** One write's share of the optimistic overlay: a patch, a removal or an addition on one entry. */
export interface OverlayContribution {
  readonly id: string;
  readonly patch?: Partial<CalendarEventData>;
  readonly remove?: boolean;
  readonly add?: CalendarEventData;
}

/** Optimistic changes the container holds until the window catches up (DESIGN 5 rules 1 and 11). */
export interface Overlay {
  /** Field changes by entry id (a move, a resize, an answer), merged across pending writes. */
  readonly patch: ReadonlyMap<string, Partial<CalendarEventData>>;
  /** Entries gone at once (deleted, hidden, a confirmed or dismissed plan). */
  readonly removed: ReadonlySet<string>;
  /** Entries made here and not yet in the window (a create before its receipt). */
  readonly added: readonly CalendarEventData[];
  /**
   * Each pending write's contributions by write id (the op id), in the order the writes landed.
   * Two writes can touch one entry: a rollback or a settle drops one write's share and the merged
   * patch is rebuilt from what remains, so a still-pending write's change is never clobbered.
   */
  readonly writes: ReadonlyMap<string, readonly OverlayContribution[]>;
}

export const EMPTY_OVERLAY: Overlay = {
  patch: new Map(),
  removed: new Set(),
  added: [],
  writes: new Map(),
};

/** Rebuilds the merged view from every pending write's contributions, in landing order. */
function merged(writes: ReadonlyMap<string, readonly OverlayContribution[]>): {
  patch: Map<string, Partial<CalendarEventData>>;
  removed: Set<string>;
  added: CalendarEventData[];
} {
  const patch = new Map<string, Partial<CalendarEventData>>();
  const removed = new Set<string>();
  const added: CalendarEventData[] = [];
  for (const list of writes.values())
    for (const c of list) {
      if (c.patch) patch.set(c.id, { ...patch.get(c.id), ...c.patch });
      if (c.remove) removed.add(c.id);
      if (c.add) {
        const at = added.findIndex(a => a.id === c.add?.id);
        if (at >= 0) added[at] = c.add;
        else added.push(c.add);
      }
    }
  return { patch, removed, added };
}

export function overlayWith(
  overlay: Overlay,
  writeId: string,
  change: OverlayContribution & {
    /** Sibling changes of the same write (a series time shift moves every loaded occurrence). */
    more?: readonly OverlayContribution[];
  },
): Overlay {
  const writes = new Map(overlay.writes);
  writes.set(writeId, [...(writes.get(writeId) ?? []), change, ...(change.more ?? [])]);
  return { writes, ...merged(writes) };
}

/** Drops one write's contribution on one entry (that write's settle or refusal); the rest stay. */
export function overlayDrop(overlay: Overlay, writeId: string, entryId: string): Overlay {
  const list = overlay.writes.get(writeId);
  if (list === undefined) return overlay;
  const writes = new Map(overlay.writes);
  const rest = list.filter(c => c.id !== entryId);
  if (rest.length === 0) writes.delete(writeId);
  else writes.set(writeId, rest);
  return { writes, ...merged(writes) };
}

/**
 * An overlay entry settles once a window frame reaches the write's applied state — or once the db epoch changed:
 * an engine reset means every row is re-read anyway, so holding the overlay would hide the fresh data (review1 8).
 */
export function reached(window: State | null, at: State | null): boolean {
  return window !== null && at !== null && (window.dbEpoch !== at.dbEpoch || window.seq >= at.seq);
}

/** A calendar's local `shown` while `Calendar/set` and the `Calendar/get` re-read are in flight (review1 5). */
export interface ShownOverride {
  readonly shown: boolean;
  /** The write returned; the next get is authoritative whatever it says (engine-side changes come through). */
  readonly settled: boolean;
}

/**
 * The overrides a resolved `Calendar/get` leaves standing: kept while the write is in flight and the get still
 * shows the old value; cleared once the get reflects them, the write has settled, or (by the caller) it failed.
 */
export function reconcileShown(
  overrides: ReadonlyMap<string, ShownOverride>,
  calendars: readonly Calendar[],
): ReadonlyMap<string, ShownOverride> {
  if (overrides.size === 0) return overrides;
  let next: Map<string, ShownOverride> | null = null;
  for (const [id, o] of overrides) {
    if (o.settled || calendars.find(c => c.id === id)?.shown === o.shown) {
      if (next === null) next = new Map(overrides);
      next.delete(id);
    }
  }
  return next ?? overrides;
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
    // No drag and no handles when the event can't move or the calendar is read-only (review1 3).
    out.push(eventData(e, ref(calendar), !e.can.move || calendar.readOnly));
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
    .sort(
      (a, b) =>
        startMs(a) - startMs(b) ||
        Number(!a.allDay) - Number(!b.allDay) ||
        a.id.localeCompare(b.id),
    );
}

/** Entries on one day, in reading order: all-day first, then by start. */
export function entriesOnDay(
  entries: readonly CalendarEventData[],
  day: IsoDate,
): CalendarEventData[] {
  const from = dateOf(day).getTime();
  const to = dateOf(addDays(day, 1)).getTime();
  return entries
    .filter(e => {
      const s = startMs(e);
      const end = Math.max(s + 1, new Date(e.end).getTime());
      return e.allDay ? end > from && s < to : s >= from && s < to;
    })
    .sort(
      (a, b) =>
        Number(!a.allDay) - Number(!b.allDay) ||
        startMs(a) - startMs(b) ||
        a.id.localeCompare(b.id),
    );
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
