import { calInvalid } from './errors';
import type { CalendarStore } from './store';
import {
  civilOfDay,
  dayOf,
  isDateText,
  isValidZone,
  isoInZone,
  localToUtc,
  parseDateTime,
} from './tz';
import type { Attendee, ConferenceData, EventTime, GcalEvent, ResponseStatus } from './types';
import type { Fields } from './types';

/**
 * Normalisation of client-supplied event bodies: times, attendees, reminders and Google Meet
 * conference data. Everything here is the same code for API calls and for test helpers.
 */

export const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
export const RESPONSES: ResponseStatus[] = ['needsAction', 'declined', 'tentative', 'accepted'];

export const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

// ---------- times ----------

export interface EventRange {
  startMs: number;
  endMs: number;
  allDay: boolean;
}

/** The span an event covers. All-day dates are read in the calendar's zone, as Google does for timeMin/timeMax. */
export function rangeOf(event: GcalEvent, calTz: string): EventRange {
  const at = (t: EventTime): number => {
    if (t.date) {
      const c = civilOfDay(dayOf(t.date));
      return localToUtc({ y: c.y, mo: c.mo, d: c.d, h: 0, mi: 0, s: 0 }, calTz);
    }
    return parseDateTime(t.dateTime, t.timeZone ?? calTz) ?? 0;
  };
  return { startMs: at(event.start), endMs: at(event.end), allDay: !!event.start.date };
}

export function normalizeTime(which: 'start' | 'end', t: unknown): EventTime {
  if (!isObject(t)) throw calInvalid(`Missing ${which} time.`, 'required');
  const hasDate = t.date !== undefined && t.date !== null;
  const hasDateTime = t.dateTime !== undefined && t.dateTime !== null;
  if (!hasDate && !hasDateTime) throw calInvalid(`Missing ${which} time.`, 'required');
  if (hasDate && hasDateTime) throw calInvalid(`Invalid ${which} time.`);
  const tz: unknown = t.timeZone;
  if (tz !== undefined && (typeof tz !== 'string' || !isValidZone(tz)))
    throw calInvalid(`Invalid time zone definition for ${which} time.`);
  if (hasDate) {
    if (!isDateText(t.date)) throw calInvalid(`Invalid ${which} time.`);
    return { date: t.date, ...(tz ? { timeZone: tz as string } : {}) };
  }
  const ms = parseDateTime(t.dateTime, tz as string | undefined);
  if (ms === undefined) {
    const missing =
      typeof t.dateTime === 'string' &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(t.dateTime) &&
      !tz;
    throw missing
      ? calInvalid(`Missing time zone definition for ${which} time.`, 'required')
      : calInvalid(`Invalid ${which} time.`);
  }
  // With a zone, Google answers in that zone's wall time and offset whatever offset the client sent.
  return tz
    ? { dateTime: isoInZone(ms, tz as string), timeZone: tz as string }
    : { dateTime: t.dateTime as string };
}

/** Both times, validated together: they must agree on all-day and cover a non-empty range. */
export function normalizeTimes(fields: Fields, calTz: string): void {
  const start = (fields.start = normalizeTime('start', fields.start));
  const end = (fields.end = normalizeTime('end', fields.end));
  if (!!start.date !== !!end.date)
    throw calInvalid('The start and end times must either both be dates or both be date-times.');
  const range = rangeOf({ start, end } as GcalEvent, calTz);
  if (range.endMs < range.startMs || (range.allDay && range.endMs === range.startMs)) {
    throw calInvalid('The specified time range is empty.', 'timeRangeEmpty');
  }
  if (fields.recurrence && start.dateTime && !start.timeZone)
    throw calInvalid('Missing time zone definition for start time.', 'required');
}

export function normalizeAttendees(
  store: CalendarStore,
  list: unknown,
  organizer: GcalEvent['organizer'],
): Attendee[] {
  if (!Array.isArray(list)) throw calInvalid('Invalid value for: attendees');
  const out: Attendee[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (!isObject(item) || typeof item.email !== 'string' || !EMAIL.test(item.email))
      throw calInvalid('Invalid attendee email.');
    const key = item.email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const isOrganizer = key === organizer.email.toLowerCase();
    const wanted = item.responseStatus as ResponseStatus;
    const response: ResponseStatus = RESPONSES.includes(wanted)
      ? wanted
      : isOrganizer
        ? 'accepted'
        : 'needsAction';
    const guests = item.additionalGuests as number;
    out.push({
      email: item.email,
      ...(typeof item.displayName === 'string' ? { displayName: item.displayName } : {}),
      ...(isOrganizer ? { organizer: true } : {}),
      ...(key === store.owner.email.toLowerCase() ? { self: true } : {}),
      ...(item.resource === true ? { resource: true } : {}),
      ...(item.optional === true ? { optional: true } : {}),
      responseStatus: response,
      ...(typeof item.comment === 'string' ? { comment: item.comment } : {}),
      ...(Number.isInteger(guests) ? { additionalGuests: guests } : {}),
    });
  }
  // Inviting people makes the organizer a guest too, already accepted.
  if (out.length && organizer.self && !seen.has(organizer.email.toLowerCase())) {
    out.unshift({
      email: organizer.email,
      organizer: true,
      self: true,
      responseStatus: 'accepted',
    });
  }
  return out;
}

export function checkReminders(reminders: unknown): void {
  if (!isObject(reminders)) throw calInvalid('Invalid value for: reminders');
  const overrides = reminders.overrides;
  if (overrides === undefined) return;
  if (
    !Array.isArray(overrides) ||
    overrides.length > 5 ||
    overrides.some(
      o =>
        !isObject(o) ||
        !['email', 'popup'].includes(o.method as string) ||
        !Number.isInteger(o.minutes as number) ||
        (o.minutes as number) < 0,
    )
  ) {
    throw calInvalid(
      'Invalid reminders: at most five overrides, each with method email or popup and non-negative minutes.',
    );
  }
}

// ---------- Google Meet ----------

/** Google Meet details as Calendar creates them for a `createRequest`. */
function makeConference(store: CalendarStore, request: Record<string, unknown>): ConferenceData {
  const letters = (n: number): string =>
    Array.from({ length: n }, () => String.fromCharCode(97 + store.deps.random.int(0, 25))).join(
      '',
    );
  const conferenceId = `${letters(3)}-${letters(4)}-${letters(3)}`;
  return {
    createRequest: {
      requestId: String(request.requestId ?? store.newId(12)),
      conferenceSolutionKey: { type: 'hangoutsMeet' },
      status: { statusCode: 'success' },
    },
    entryPoints: [
      {
        entryPointType: 'video',
        uri: `https://meet.google.com/${conferenceId}`,
        label: `meet.google.com/${conferenceId}`,
      },
    ],
    conferenceSolution: {
      key: { type: 'hangoutsMeet' },
      name: 'Google Meet',
      iconUri: 'https://example.test/icons/meet.png',
    },
    conferenceId,
  };
}

/**
 * conferenceDataVersion decides everything: below 1 the body's conferenceData is ignored; at 1 a
 * `createRequest` makes a Meet room. A PUT keeps an existing room only when the client resends it
 * (this is the D11 trap); a PATCH keeps it unless the body says otherwise.
 */
export function resolveConference(
  store: CalendarStore,
  mode: 'insert' | 'put' | 'patch',
  prev: GcalEvent | undefined,
  sent: unknown,
  version: number,
): ConferenceData | undefined {
  const existing = prev?.conferenceData;
  if (version < 1) return mode === 'patch' ? existing : undefined;
  if (sent === null) return undefined;
  if (mode === 'patch' && sent === undefined) return existing;
  if (!isObject(sent)) return undefined;
  if (
    existing &&
    (sent.conferenceId === existing.conferenceId || (mode === 'patch' && sent.createRequest))
  )
    return existing;
  if (isObject(sent.createRequest) && !existing) return makeConference(store, sent.createRequest);
  // Version 1 also copies an existing conference sent in full ("copying of ConferenceData", events.insert docs).
  if (typeof sent.conferenceId === 'string' && Array.isArray(sent.entryPoints))
    return structuredClone(sent);
  return undefined;
}

// ---------- assembling an event ----------

/** The parts of a client body that Google fills in after checking the rest: reminders and guests. */
export function finalizeFields(
  store: CalendarStore,
  fields: Fields,
  organizer: GcalEvent['organizer'],
): void {
  if (fields.reminders !== undefined) checkReminders(fields.reminders);
  else fields.reminders = { useDefault: true };
  if (fields.attendees !== undefined) {
    fields.attendees = normalizeAttendees(store, fields.attendees, organizer);
    if (!fields.attendees.length) delete fields.attendees;
  }
}
