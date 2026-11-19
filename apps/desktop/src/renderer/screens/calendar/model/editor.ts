/** New events and the editor: the next free slot, drafts, the refusal sentences, and the `Event/set` change a save makes. */
import type { EventChange, EventFields } from '@aplos/contract';
import { toIsoDate, type EpochMs, type Event } from '../../../data';
import type {
  CalendarEventData,
  EventScope,
  IsoDate,
  IsoDateTime,
  IsoTime,
} from '../../../ui/props';
import {
  addDays,
  dateOf,
  dayOf,
  durationText,
  hoursOf,
  parseDate,
} from '../../../ui/calendar/dates';
import { isoOfTime, msOf } from './period';
import { timeChange, wallOf } from './times';
import { DAY_MS, MINUTE_MS, pad } from './units';

const DAY_MINUTES = 24 * 60;

/** Minutes since midnight as "HH:MM". */
export function clockOf(minutes: number): IsoTime {
  const m = Math.max(0, Math.min(DAY_MINUTES - 1, Math.round(minutes)));
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

/** Calendar days from `a` to `b` (a DST day still counts one). */
export function daysBetween(a: IsoDate, b: IsoDate): number {
  const p = parseDate(a);
  const q = parseDate(b);
  return Math.round((Date.UTC(q.y, q.m - 1, q.d) - Date.UTC(p.y, p.m - 1, p.d)) / DAY_MS);
}

/** Minutes on the wall clock since local midnight (not time elapsed: a DST day's 10:00 is 600). */
function wallMinutes(ms: EpochMs): number {
  const d = new Date(ms);
  return d.getHours() * 60 + d.getMinutes();
}

const atMidnight = (iso: IsoDateTime): boolean => hoursOf(iso) === 0;

/**
 * The wall-clock minutes of `day` that events take, from the events themselves: an event that started the day before
 * holds the morning until it ends. All-day entries (dates) leave the day free; a timed event the strip draws (24 hours
 * or more) still holds its hours.
 */
export function busyOn(
  day: IsoDate,
  entries: readonly CalendarEventData[],
): Array<{ at: number; end: number }> {
  const from = dateOf(day).getTime();
  const to = dateOf(addDays(day, 1)).getTime();
  const out: Array<{ at: number; end: number }> = [];
  for (const e of entries) {
    if (e.kind !== 'event') continue;
    if (e.allDay && atMidnight(e.start) && atMidnight(e.end)) continue;
    const s = new Date(e.start).getTime();
    const en = Math.max(s, new Date(e.end).getTime());
    if (en <= from || s >= to) continue;
    out.push({ at: s <= from ? 0 : wallMinutes(s), end: en >= to ? DAY_MINUTES : wallMinutes(en) });
  }
  return out;
}

/** From this wall-clock minute (9 PM) a new event starts tomorrow morning, not at 10:30 PM tonight. */
const LATE_MINUTES = 21 * 60;

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
  let start = isToday ? Math.ceil(wallMinutes(now) / 30) * 30 : 9 * 60;
  if (start + minutes > DAY_MINUTES) start = Math.max(0, DAY_MINUTES - minutes);
  const busy = busyOn(day, entries);
  const first = start;
  while (busy.some(b => b.at < start + minutes && b.end > start)) {
    start += 30;
    if (start + minutes > DAY_MINUTES) {
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
  /** An all-day event's last day (inclusive); a timed event's end day, later than `date` when it runs past midnight. */
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

/** A timed draft's end as minutes after its start day's midnight (each later end day adds 24 hours). */
export function endMinutes(d: Pick<EditorDraft, 'date' | 'endDate' | 'end'>): number {
  return daysBetween(d.date, d.endDate) * DAY_MINUTES + minutesOf(d.end);
}

/** Minutes after `date`'s midnight as an end day and time. */
function endAt(date: IsoDate, minutes: number): { endDate: IsoDate; end: IsoTime } {
  const days = Math.floor(minutes / DAY_MINUTES);
  return { endDate: addDays(date, days), end: clockOf(minutes - days * DAY_MINUTES) };
}

export function newDraft(
  day: IsoDate,
  now: EpochMs,
  entries: readonly CalendarEventData[],
  calendarId: string | null,
): EditorDraft {
  // Late in the evening there is no honest next hour today: the next working-hours slot, tomorrow 9:00–10:00.
  const late = toIsoDate(now) === day && wallMinutes(now) >= LATE_MINUTES;
  const date = late ? addDays(day, 1) : day;
  const slot = nextFreeSlot(date, now, entries);
  return {
    mode: 'new',
    title: '',
    date,
    endDate: date,
    start: slot.start,
    end: slot.end,
    allDay: false,
    calendarId,
    persisted: false,
    recurring: false,
  };
}

/** A drag on an empty hour: the dragged range, on the default calendar. */
export function draftFromRange(
  range: { start: IsoDateTime; end: IsoDateTime },
  calendarId: string | null,
): EditorDraft {
  const day = dayOf(range.start);
  const start = Math.round(hoursOf(range.start) * 60);
  const endSameDay = dayOf(range.end) === day;
  const end = endSameDay ? Math.round(hoursOf(range.end) * 60) : DAY_MINUTES - 1;
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

/** E on an event: a timed event keeps its own end day, so a save of the title alone leaves its times as they are. */
export function draftFromEvent(e: Event): EditorDraft {
  const start = isoOfTime(e.start);
  const allDay = e.allDay || e.start.type === 'date';
  const endMs = Math.max(msOf(e.start), msOf(e.end));
  const end = isoOfTime(e.end.type === 'date' ? e.end : { type: 'utc', utc: endMs });
  const lastDay = allDay ? toIsoDate(Math.max(msOf(e.start), msOf(e.end) - MINUTE_MS)) : dayOf(end);
  const sameDay = dayOf(end) === dayOf(start);
  return {
    mode: 'edit',
    eventId: e.id,
    title: e.title,
    date: dayOf(start),
    endDate: lastDay,
    start: clockOf(Math.round(hoursOf(start) * 60)),
    end: allDay && !sameDay ? '23:59' : clockOf(Math.round(hoursOf(end) * 60)),
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
  if (d.allDay ? d.endDate < d.date : endMinutes(d) <= minutesOf(d.start))
    return 'An event must end after it starts.';
  if (!d.calendarId) return 'Choose a calendar.';
  return null;
}

/**
 * The draft's times as contract fields. All-day: `date` times with the end EXCLUSIVE, as Google stores
 * them — `endDate` is the draft's inclusive last day, so the write adds one. Timed: `utc` instants, or
 * `floating` in `zone` when the target calendar (or the event) carries one — a floating write always
 * names its zone, or the engine refuses `event.timeZoneRequired` (shapes 4–5).
 */
export function draftTimes(
  d: EditorDraft,
  zone?: string,
): Pick<EventFields, 'start' | 'end' | 'allDay'> {
  if (d.allDay)
    return {
      start: { type: 'date', date: d.date },
      end: { type: 'date', date: addDays(d.endDate, 1) },
      allDay: true,
    };
  if (zone)
    return {
      start: {
        type: 'floating',
        local: wallOf(localMs(d.date, d.start), zone),
        timeZone: zone,
      },
      end: { type: 'floating', local: wallOf(localMs(d.endDate, d.end), zone), timeZone: zone },
      allDay: false,
    };
  return {
    start: { type: 'utc', utc: localMs(d.date, d.start) },
    end: { type: 'utc', utc: localMs(d.endDate, d.end) },
    allDay: false,
  };
}

/** The day, times or all-day flag differ from the draft the event opened as: only then does a save write times. */
export function timesTouched(d: EditorDraft, original: Event): boolean {
  const before = draftFromEvent(original);
  return (
    d.date !== before.date ||
    d.endDate !== before.endDate ||
    d.start !== before.start ||
    d.end !== before.end ||
    d.allDay !== before.allDay
  );
}

/**
 * The `Event/set` change a save makes: a create with every field, or an update with only what changed. `null` when
 * nothing changed. `scope` matters only for a repeating event; under `series` the fields stay this occurrence's
 * own — the engine maps them to a wall-clock shift of the master (DECISIONS 2026-11-04, model/times.ts).
 */
export function draftChange(
  d: EditorDraft,
  original: Event | undefined,
  scope: EventScope,
  zone?: string,
): EventChange | null {
  const times = draftTimes(d, zone);
  if (d.mode === 'new') {
    if (!d.calendarId) return null;
    return {
      type: 'create',
      calendarId: d.calendarId,
      fields: { title: d.title.trim(), ...times, ...(zone ? { timeZone: zone } : {}) },
    };
  }
  // An edit whose event left the window writes nothing; saveEditor says why (review2 2).
  if (!original || !d.eventId) return null;
  const fields: Partial<EventFields> = {};
  if (d.title.trim() !== original.title) fields.title = d.title.trim();
  const target = timeChange(original, times, zone);
  if (timesTouched(d, original)) {
    Object.assign(fields, target.fields);
    if (times.allDay !== original.allDay) fields.allDay = times.allDay;
  }
  if (Object.keys(fields).length === 0) return null;
  return { type: 'update', id: target.id, scope, fields };
}

/** An editor field changed: a new day carries the end day with it; a new start keeps the length; a new end is on the start day. */
export function patchDraft(
  draft: EditorDraft,
  patch: Partial<Pick<EditorDraft, 'title' | 'date' | 'start' | 'end' | 'calendarId'>>,
): EditorDraft {
  const next: EditorDraft = { ...draft, ...patch, error: undefined };
  if (patch.date && patch.date !== draft.date)
    return { ...next, endDate: addDays(draft.endDate, daysBetween(draft.date, patch.date)) };
  if (patch.start && !patch.end) {
    const length = endMinutes(draft) - minutesOf(draft.start);
    return { ...next, ...endAt(next.date, minutesOf(patch.start) + Math.max(15, length)) };
  }
  // The end menu lists times on the start day, plus the current end (which may be on a later day).
  if (patch.end && !patch.start && patch.end !== draft.end) return { ...next, endDate: next.date };
  return next;
}

/** Start choices: half hours three hours either side of the current start, plus the current one (a menu that fits a 600 px window). */
export function startChoices(current: IsoTime): IsoTime[] {
  const at = minutesOf(current);
  const base = Math.round(at / 30) * 30;
  const out = new Set<number>([at]);
  for (let m = Math.max(0, base - 180); m <= Math.min(23 * 60 + 30, base + 180); m += 30)
    out.add(m);
  return [...out].sort((a, b) => a - b).map(clockOf);
}

/**
 * End choices: from 15 minutes after the start to six hours after it on the start day, with the length beside each,
 * plus the current end, which may be `endDays` later (a timed event past midnight).
 */
export function endChoices(
  start: IsoTime,
  current: IsoTime,
  endDays = 0,
): Array<{ time: IsoTime; length: string }> {
  const from = minutesOf(start);
  const now = minutesOf(current) + endDays * DAY_MINUTES;
  const out = new Set<number>([now]);
  out.add(from + 15);
  for (let m = from + 30; m <= Math.min(DAY_MINUTES - 1, from + 6 * 60); m += 30) out.add(m);
  return [...out]
    .filter(m => m > from && (m < DAY_MINUTES || m === now))
    .sort((a, b) => a - b)
    .map(m => ({ time: clockOf(m % DAY_MINUTES), length: durationText(m - from) }));
}
