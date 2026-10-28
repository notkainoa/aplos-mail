import {
  calForbidden,
  calInvalid,
  calNotFound,
  conditionNotMet,
  duplicateId,
  forbiddenForNonOrganizer,
  resourceDeleted,
} from './errors';
import {
  EMAIL,
  RESPONSES,
  finalizeFields,
  isObject,
  normalizeTimes,
  resolveConference,
} from './fields';
import {
  RecurrenceError,
  occurrences,
  validateRecurrence,
  type Occurrence,
  type Series,
} from './rrule';
import type { CalendarRecord, CalendarStore, EventRecord } from './store';
import { dateOfDay, dayOf, dayOfCivil, isoInZone, localParts, parseDateTime } from './tz';
import type {
  Attendee,
  ConferenceData,
  EventTime,
  Fields,
  GcalEvent,
  ResponseStatus,
  SendUpdates,
  SentUpdate,
} from './types';

/**
 * How Calendar v3 reads and writes events, without HTTP. `insertEvent`, `replaceEvent` (PUT, full
 * replacement), `patchEvent` and `deleteEvent` are the same code for API calls and for test helpers.
 *
 * Instances of a series are not stored until somebody edits or deletes one: `<masterId>_<key>` is
 * answered by expanding the master, and the first write stores an exception ("override").
 */

export interface WriteOptions {
  sendUpdates: SendUpdates;
  conferenceDataVersion: number;
  ifMatch?: string;
  /** Skips access and organizer checks: another client or the organizer's own edit made by a test helper. */
  trusted?: boolean;
}

export const INSTANCE_ID = /^(.+)_(\d{8}(?:T\d{6}Z)?)$/;
const CLIENT_ID = /^[a-v0-9]{5,1024}$/;
const STATUSES = ['confirmed', 'tentative', 'cancelled'];

/** Fields a client may write. Everything else is either read-only (accepted and ignored) or unknown (400). */
const WRITABLE = [
  'summary',
  'description',
  'location',
  'colorId',
  'start',
  'end',
  'endTimeUnspecified',
  'recurrence',
  'transparency',
  'visibility',
  'attendees',
  'guestsCanModify',
  'guestsCanInviteOthers',
  'guestsCanSeeOtherGuests',
  'reminders',
  'extendedProperties',
  'attachments',
  'source',
  'status',
  'anyoneCanAddSelf',
  'gadget',
];
const READ_ONLY = [
  'kind',
  'etag',
  'id',
  'htmlLink',
  'created',
  'updated',
  'creator',
  'organizer',
  'iCalUID',
  'sequence',
  'hangoutLink',
  'recurringEventId',
  'originalStartTime',
  'locked',
  'privateCopy',
  'attendeesOmitted',
  'eventType',
  'conferenceData',
];
/** What only the organizer (or a guest when guestsCanModify is on) may change. The rest is personal. */
const SHARED = [
  'summary',
  'description',
  'location',
  'start',
  'end',
  'endTimeUnspecified',
  'recurrence',
  'status',
  'conferenceData',
  'attachments',
  'guestsCanModify',
  'guestsCanInviteOthers',
  'guestsCanSeeOtherGuests',
  'anyoneCanAddSelf',
  'source',
  'gadget',
];
/** A change to any of these is worth telling the guests about. */
const SIGNIFICANT = ['summary', 'description', 'location', 'start', 'end', 'recurrence'];

export const iso = (ms: number): string => new Date(ms).toISOString();

/** Key-sorted JSON, for comparing values regardless of property order. */
export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

const clone = <T>(value: T): T => structuredClone(value);

// ---------- views ----------

/** What the API returns: cancelled events keep only their identity, as Google's tombstones do. */
export function viewOf(event: GcalEvent): GcalEvent {
  if (event.status !== 'cancelled') return clone(event);
  return {
    kind: 'calendar#event',
    etag: event.etag,
    id: event.id,
    status: 'cancelled',
    ...(event.recurringEventId
      ? {
          recurringEventId: event.recurringEventId,
          originalStartTime: clone(event.originalStartTime),
        }
      : {}),
  } as GcalEvent;
}

export const isMaster = (event: GcalEvent): boolean =>
  Array.isArray(event.recurrence) && event.recurrence.length > 0;

// ---------- times ----------

export { rangeOf, type EventRange } from './fields';

export function seriesOf(master: GcalEvent, calTz: string): Series {
  if (master.start.date) {
    return {
      allDay: true,
      tz: 'UTC',
      startDay: dayOf(master.start.date),
      h: 0,
      mi: 0,
      s: 0,
      recurrence: master.recurrence ?? [],
    };
  }
  const tz = master.start.timeZone ?? calTz;
  const p = localParts(parseDateTime(master.start.dateTime, tz) ?? 0, tz);
  return {
    allDay: false,
    tz,
    startDay: dayOfCivil(p.y, p.mo, p.d),
    h: p.h,
    mi: p.mi,
    s: p.s,
    recurrence: master.recurrence ?? [],
  };
}

/** One occurrence of a series as an event, before anybody has edited it. */
export function instanceOf(master: GcalEvent, occ: Occurrence, calTz: string): GcalEvent {
  const instance = clone(master);
  delete instance.recurrence;
  delete instance.conferenceData?.createRequest;
  instance.id = `${master.id}_${occ.key}`;
  instance.recurringEventId = master.id;
  if (master.start.date) {
    const days = dayOf(master.end.date!) - dayOf(master.start.date);
    instance.start = { date: dateOfDay(occ.day) };
    instance.end = { date: dateOfDay(occ.day + days) };
  } else {
    const tz = master.start.timeZone ?? calTz;
    const duration =
      (parseDateTime(master.end.dateTime, master.end.timeZone ?? tz) ?? 0) -
      (parseDateTime(master.start.dateTime, tz) ?? 0);
    instance.start = { dateTime: isoInZone(occ.startMs, tz), timeZone: tz };
    instance.end = {
      dateTime: isoInZone(occ.startMs + duration, master.end.timeZone ?? tz),
      timeZone: master.end.timeZone ?? tz,
    };
  }
  instance.originalStartTime = clone(instance.start);
  instance.etag = `${master.etag.slice(0, -1)}_${occ.key}"`;
  return instance;
}

// ---------- lookup ----------

export interface Located {
  record?: EventRecord;
  /** Set when the id names an occurrence nobody has edited: the master and the occurrence. */
  virtual?: { master: EventRecord; occ: Occurrence };
}

/** Finds an occurrence of a master by its id suffix. */
export function findOccurrence(
  master: GcalEvent,
  calTz: string,
  key: string,
): Occurrence | undefined {
  const wantAllDay = key.length === 8;
  if (wantAllDay !== !!master.start.date) return undefined;
  for (const occ of occurrences(seriesOf(master, calTz))) {
    if (occ.key === key) return occ;
    if (occ.key > key) return undefined; // keys sort as their instants do
  }
  return undefined;
}

export function locate(cal: CalendarRecord, eventId: string): Located {
  const record = cal.events.get(eventId);
  if (record && !record.stale) return { record };
  const m = INSTANCE_ID.exec(eventId);
  if (m) {
    const master = cal.events.get(m[1]);
    if (master && isMaster(master.event) && master.event.status !== 'cancelled') {
      const occ = findOccurrence(master.event, cal.timeZone, m[2]);
      if (occ) return { virtual: { master, occ } };
    }
  }
  return {};
}

function currentOf(located: Located, cal: CalendarRecord): GcalEvent | undefined {
  if (located.record) return located.record.event;
  if (located.virtual)
    return instanceOf(located.virtual.master.event, located.virtual.occ, cal.timeZone);
  return undefined;
}

export function getEvent(cal: CalendarRecord, eventId: string): GcalEvent {
  const event = currentOf(locate(cal, eventId), cal);
  if (!event) throw calNotFound();
  return viewOf(event);
}

// ---------- validation and normalisation ----------

function pickWritable(body: Record<string, unknown>): Fields {
  const out: Fields = {};
  for (const [key, value] of Object.entries(body)) {
    if (READ_ONLY.includes(key)) continue;
    if (!WRITABLE.includes(key))
      throw calInvalid(`Invalid JSON payload received. Unknown name "${key}": Cannot find field.`);
    out[key] = value;
  }
  return out;
}

function writableOf(event: GcalEvent): Fields {
  const out: Fields = {};
  for (const key of WRITABLE) if (event[key] !== undefined) out[key] = clone(event[key]);
  return out;
}

/** RFC 7396 merge: objects merge, null removes, anything else (arrays included) replaces. */
function mergePatch(target: Fields, patch: Fields): Fields {
  const out: Fields = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key];
    else if (isObject(value) && isObject(out[key]) && key !== 'start' && key !== 'end')
      out[key] = mergePatch(out[key], value);
    else if ((key === 'start' || key === 'end') && isObject(value) && isObject(out[key])) {
      // A new date replaces a dateTime and vice versa; a bare timeZone change merges.
      const base: Fields = { ...out[key] };
      if ('date' in value) {
        delete base.dateTime;
        delete base.timeZone;
      }
      if ('dateTime' in value) delete base.date;
      out[key] = mergePatch(base, value) as EventTime;
    } else out[key] = value;
  }
  return out;
}

// ---------- assembling an event ----------

interface Identity {
  id: string;
  created: string;
  creator: GcalEvent['creator'];
  organizer: GcalEvent['organizer'];
  iCalUID: string;
  sequence: number;
  recurringEventId?: string;
  originalStartTime?: EventTime;
  eventType?: string;
}

function htmlLink(id: string, calendarId: string): string {
  return `https://www.google.com/calendar/event?eid=${Buffer.from(`${id} ${calendarId}`).toString('base64').replace(/=+$/, '')}`;
}

const etagOf = (updatedMs: number, rev: number): string =>
  `"${updatedMs}${String(rev).padStart(6, '0')}"`;

function assemble(
  store: CalendarStore,
  cal: CalendarRecord,
  who: Identity,
  fields: Fields,
  conference: ConferenceData | undefined,
): GcalEvent {
  if (fields.status !== undefined && !STATUSES.includes(fields.status as string))
    throw calInvalid('Invalid value for: status');
  for (const key of ['summary', 'description', 'location', 'colorId']) {
    if (fields[key] !== undefined && typeof fields[key] !== 'string')
      throw calInvalid(`Invalid value for: ${key}`);
  }
  if (
    fields.transparency !== undefined &&
    !['opaque', 'transparent'].includes(fields.transparency as string)
  )
    throw calInvalid('Invalid value for: transparency');
  if (
    fields.visibility !== undefined &&
    !['default', 'public', 'private', 'confidential'].includes(fields.visibility as string)
  )
    throw calInvalid('Invalid value for: visibility');
  if (Array.isArray(fields.recurrence) && fields.recurrence.length === 0) delete fields.recurrence;
  if (fields.recurrence !== undefined) {
    try {
      validateRecurrence(fields.recurrence);
    } catch (error) {
      if (error instanceof RecurrenceError) throw calInvalid('Invalid recurrence rule.');
      throw error;
    }
    if (who.recurringEventId)
      throw calInvalid('An exception of a series cannot have its own recurrence.');
  }
  normalizeTimes(fields, cal.timeZone);
  finalizeFields(store, fields, who.organizer);
  const hangout = conference?.entryPoints?.find(e => e.entryPointType === 'video')?.uri;
  return {
    kind: 'calendar#event',
    etag: '',
    id: who.id,
    status: 'confirmed',
    htmlLink: htmlLink(who.id, cal.id),
    created: who.created,
    updated: '',
    creator: who.creator,
    organizer: who.organizer,
    iCalUID: who.iCalUID,
    sequence: who.sequence,
    ...(who.recurringEventId
      ? { recurringEventId: who.recurringEventId, originalStartTime: who.originalStartTime }
      : {}),
    eventType: who.eventType ?? 'default',
    ...fields,
    ...(conference ? { conferenceData: conference } : {}),
    ...(hangout ? { hangoutLink: hangout } : {}),
  } as GcalEvent;
}

function identityOf(event: GcalEvent): Identity {
  return {
    id: event.id,
    created: event.created,
    creator: event.creator,
    organizer: event.organizer,
    iCalUID: event.iCalUID,
    sequence: event.sequence,
    recurringEventId: event.recurringEventId,
    originalStartTime: event.originalStartTime,
    eventType: event.eventType,
  };
}

function organizerFor(store: CalendarStore, cal: CalendarRecord): GcalEvent['organizer'] {
  const self =
    cal.id.toLowerCase() === store.owner.email.toLowerCase() || cal.accessRole === 'owner';
  return {
    email: cal.id,
    ...(cal.primary ? {} : { displayName: cal.summary }),
    ...(self ? { self: true } : {}),
  };
}

function assertCanWrite(cal: CalendarRecord, opts: WriteOptions): void {
  if (!opts.trusted && cal.accessRole !== 'owner' && cal.accessRole !== 'writer')
    throw calForbidden();
}

/** The organizer, a guest when guestsCanModify is on, or anybody on a calendar-organised event of a shared calendar. */
export function canEditShared(event: GcalEvent, cal: CalendarRecord): boolean {
  return (
    event.organizer.self === true ||
    event.guestsCanModify === true ||
    event.organizer.email.toLowerCase() === cal.id.toLowerCase()
  );
}

// ---------- committing ----------

function commit(
  store: CalendarStore,
  cal: CalendarRecord,
  event: GcalEvent,
  previous?: EventRecord,
): EventRecord {
  const rev = store.nextRev();
  const nowMs = store.now();
  event.updated = iso(nowMs);
  event.etag = etagOf(nowMs, rev);
  const record: EventRecord = previous ?? { event, rev, seq: store.nextSeq() };
  record.event = event;
  record.rev = rev;
  delete record.stale;
  cal.events.set(event.id, record);
  return record;
}

const guestEmails = (event: GcalEvent, store: CalendarStore): string[] =>
  (event.attendees ?? [])
    .filter(
      a => !a.self && !a.resource && a.email.toLowerCase() !== store.owner.email.toLowerCase(),
    )
    .map(a => a.email);

function recordNotification(
  store: CalendarStore,
  cal: CalendarRecord,
  event: GcalEvent,
  action: SentUpdate['action'],
  opts: WriteOptions,
  to: string[],
): void {
  if (!to.length) return;
  const recipients =
    opts.sendUpdates === 'all'
      ? to
      : opts.sendUpdates === 'externalOnly'
        ? to.filter(e => !store.deps.isGoogleAccount(e))
        : [];
  store.deps.sentUpdates.push({
    at: store.now(),
    calendarId: cal.id,
    eventId: event.id,
    action,
    sendUpdates: opts.sendUpdates,
    recipients,
  });
}

/** Exceptions of a series are dropped (kept as cancelled tombstones) when the series itself is cut or moved. */
function retireExceptions(
  store: CalendarStore,
  cal: CalendarRecord,
  masterId: string,
  stale: boolean,
): void {
  for (const record of cal.events.values()) {
    if (record.event.recurringEventId !== masterId) continue;
    if (record.event.status === 'cancelled') {
      if (stale) record.stale = true;
      continue;
    }
    record.event.status = 'cancelled';
    commit(store, cal, record.event, record);
    if (stale) record.stale = true;
  }
}

// ---------- the four writes ----------

function checkIfMatch(opts: WriteOptions, current: GcalEvent): void {
  if (opts.ifMatch !== undefined && opts.ifMatch !== '*' && opts.ifMatch !== current.etag)
    throw conditionNotMet();
}

function existingOrFail(
  cal: CalendarRecord,
  eventId: string,
): { located: Located; current: GcalEvent } {
  const located = locate(cal, eventId);
  const current = currentOf(located, cal);
  if (!current) throw calNotFound();
  return { located, current };
}

export function insertEvent(
  store: CalendarStore,
  cal: CalendarRecord,
  body: Record<string, unknown>,
  opts: WriteOptions,
): GcalEvent {
  assertCanWrite(cal, opts);
  const fields = pickWritable(body);
  let id: string;
  if (body.id !== undefined) {
    if (typeof body.id !== 'string' || !CLIENT_ID.test(body.id))
      throw calInvalid('Invalid resource id value.');
    id = body.id;
    if (cal.events.has(id)) throw duplicateId();
  } else {
    id = store.newId();
  }
  const organizer = organizerFor(store, cal);
  const who: Identity = {
    id,
    created: iso(store.now()),
    creator: { email: store.owner.email, self: true },
    organizer,
    iCalUID: `${id}@google.com`,
    sequence: 0,
  };
  const event = assemble(
    store,
    cal,
    who,
    fields,
    resolveConference(store, 'insert', undefined, body.conferenceData, opts.conferenceDataVersion),
  );
  commit(store, cal, event);
  recordNotification(store, cal, event, 'created', opts, guestEmails(event, store));
  return viewOf(event);
}

export function replaceEvent(
  store: CalendarStore,
  cal: CalendarRecord,
  eventId: string,
  body: Record<string, unknown>,
  opts: WriteOptions,
): GcalEvent {
  return updateEvent(store, cal, eventId, body, opts, 'put');
}

export function patchEvent(
  store: CalendarStore,
  cal: CalendarRecord,
  eventId: string,
  body: Record<string, unknown>,
  opts: WriteOptions,
): GcalEvent {
  return updateEvent(store, cal, eventId, body, opts, 'patch');
}

/** Non-organizers may answer for themselves and nothing else about the guests. */
function guestEdit(
  prev: GcalEvent,
  incoming: unknown,
  store: CalendarStore,
  mode: 'put' | 'patch',
): Attendee[] | undefined {
  if (incoming === undefined) return undefined;
  if (!Array.isArray(incoming)) throw calInvalid('Invalid value for: attendees');
  const before = prev.attendees ?? [];
  const me = store.owner.email.toLowerCase();
  const next = before.map(a => ({ ...a }));
  const seen = new Set<string>();
  for (const item of incoming) {
    const email = isObject(item) && typeof item.email === 'string' ? item.email.toLowerCase() : '';
    const existing = next.find(a => a.email.toLowerCase() === email);
    if (!existing) throw forbiddenForNonOrganizer();
    seen.add(email);
    const asked = item.responseStatus as ResponseStatus;
    const wanted: ResponseStatus = RESPONSES.includes(asked) ? asked : 'needsAction';
    if (email === me) {
      existing.responseStatus = wanted;
      if (typeof item.comment === 'string') existing.comment = item.comment;
    } else if (existing.responseStatus !== wanted || !!existing.optional !== !!item.optional) {
      throw forbiddenForNonOrganizer();
    }
  }
  if (
    mode === 'put' &&
    before.some(a => !seen.has(a.email.toLowerCase()) && a.email.toLowerCase() !== me)
  )
    throw forbiddenForNonOrganizer();
  return next;
}

function updateEvent(
  store: CalendarStore,
  cal: CalendarRecord,
  eventId: string,
  body: Record<string, unknown>,
  opts: WriteOptions,
  mode: 'put' | 'patch',
): GcalEvent {
  assertCanWrite(cal, opts);
  const { located, current } = existingOrFail(cal, eventId);
  checkIfMatch(opts, current);
  const shared = opts.trusted || canEditShared(current, cal);
  const sent = pickWritable(body);
  const guests = shared ? undefined : guestEdit(current, sent.attendees, store, mode);
  const fields = mode === 'put' ? sent : mergePatch(writableOf(current), sent);
  if (guests) fields.attendees = guests;
  if (mode === 'patch' && current.status === 'cancelled' && sent.status === undefined)
    fields.status = 'cancelled';
  const conference = resolveConference(
    store,
    mode,
    current,
    body.conferenceData,
    opts.conferenceDataVersion,
  );
  const next = assemble(store, cal, identityOf(current), fields, conference);

  let rsvp = false;
  if (!shared) {
    for (const key of SHARED)
      if (stable(current[key]) !== stable(next[key])) throw forbiddenForNonOrganizer();
    // Private extended properties are the guest's own; the shared ones belong to everybody.
    if (stable(current.extendedProperties?.shared) !== stable(next.extendedProperties?.shared))
      throw forbiddenForNonOrganizer();
    const mine = (e: GcalEvent) => (e.attendees ?? []).find(a => a.self)?.responseStatus;
    rsvp = mine(current) !== mine(next);
    // The others' entries are exactly as they were; only the user's own may differ.
    const others = (e: GcalEvent) => stable((e.attendees ?? []).filter(a => !a.self));
    if (others(current) !== others(next)) throw forbiddenForNonOrganizer();
  }

  const significant =
    SIGNIFICANT.some(key => stable(current[key]) !== stable(next[key])) ||
    stable(guestEmails(current, store)) !== stable(guestEmails(next, store));
  if (significant) next.sequence = current.sequence + 1;

  // An exception is stored from its first edit on.
  commit(store, cal, next, located.record);
  const reshaped =
    stable(current.start) !== stable(next.start) ||
    stable(current.recurrence) !== stable(next.recurrence);
  if (isMaster(current) && reshaped) retireExceptions(store, cal, current.id, true);

  if (rsvp) {
    const organizerEmail = next.organizer.email;
    recordNotification(
      store,
      cal,
      next,
      'rsvp',
      opts,
      EMAIL.test(organizerEmail) ? [organizerEmail] : [],
    );
  } else if (significant && next.status !== 'cancelled') {
    recordNotification(store, cal, next, 'updated', opts, guestEmails(next, store));
  }
  return viewOf(next);
}

export function deleteEvent(
  store: CalendarStore,
  cal: CalendarRecord,
  eventId: string,
  opts: WriteOptions,
): void {
  assertCanWrite(cal, opts);
  const { located, current } = existingOrFail(cal, eventId);
  if (current.status === 'cancelled') throw resourceDeleted();
  checkIfMatch(opts, current);
  const next = clone(current);
  next.status = 'cancelled';
  commit(store, cal, next, located.record);
  if (isMaster(current)) retireExceptions(store, cal, current.id, false);
  recordNotification(store, cal, next, 'cancelled', opts, guestEmails(next, store));
}

/** Invitations come from other organizers, so they are assembled with that organizer and the user as a guest. */
export function insertInvitation(
  store: CalendarStore,
  cal: CalendarRecord,
  spec: {
    id?: string;
    organizer: { email: string; displayName?: string };
    fields: Fields;
  },
): GcalEvent {
  const id = spec.id ?? store.newId();
  if (cal.events.has(id)) throw duplicateId();
  const who: Identity = {
    id,
    created: iso(store.now()),
    creator: { ...spec.organizer },
    organizer: { ...spec.organizer },
    iCalUID: `${id}@google.com`,
    sequence: 0,
  };
  const event = assemble(store, cal, who, spec.fields, undefined);
  commit(store, cal, event);
  return viewOf(event);
}
