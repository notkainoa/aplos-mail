import type { Calendar, Event, EventTime } from '@aplos/contract';
import { ContractError } from '@aplos/contract/contract-error';
import type { EventTime as EngineTime } from './recurrence/types';
import { RECURRENCE_ID_FORMAT } from '../ports/calendar';
import { fromWall, isKnownZone } from './recurrence/zone';

/** Engine (`recurrence`) time to the wire's discriminated union. */
export const toWire = (t: EngineTime): EventTime =>
  'utc' in t
    ? { type: 'utc', utc: t.utc }
    : 'date' in t
      ? { type: 'date', date: t.date }
      : { type: 'floating', local: t.local, ...(t.tzid ? { timeZone: t.tzid } : {}) };

/** The wire's discriminated union to engine time. */
export const fromWire = (t: EventTime): EngineTime =>
  t.type === 'utc'
    ? { utc: t.utc }
    : t.type === 'date'
      ? { date: t.date }
      : { local: t.local, ...(t.timeZone ? { tzid: t.timeZone } : {}) };

/**
 * Contract ids and stored-row projections for the calendar tables (prov-cal). A stored resource's id is
 * `${accountId}:${calendarRemoteId}:${remoteId}`; a calendar's is `${accountId}:${calendarRemoteId}`; an occurrence's
 * is `<seriesId>@<recurrenceId>` with `recurrenceId` the canonical form (`RECURRENCE_ID_FORMAT`, FR-20).
 * `events.data` is provider-original JSON — today the Google event resource.
 */

export const calendarContractId = (accountId: string, remoteId: string): string =>
  `${accountId}:${remoteId}`;
export const eventContractId = (accountId: string, calRemote: string, remote: string): string =>
  `${accountId}:${calRemote}/${remote}`;

export function parseCalendarId(id: string): { accountId: string; remoteId: string } {
  const i = id.indexOf(':');
  if (i <= 0 || i === id.length - 1)
    throw new ContractError({ type: 'notFound', message: 'This calendar is no longer available.' });
  return { accountId: id.slice(0, i), remoteId: id.slice(i + 1) };
}

/** The `accountId:` prefix of a contract id, longest-match against the stored accounts — ids like
 * `google:me@example.com` hold colons, so a plain first-colon split mis-reads them. */
export function accountPrefix(id: string, accountIds: string[]): string {
  const match = accountIds
    .filter(a => id.startsWith(`${a}:`))
    .sort((a, b) => b.length - a.length)[0];
  if (!match)
    throw new ContractError({ type: 'notFound', message: 'This item is no longer available.' });
  return match;
}

/** `parseEventId` with account ids resolved against the store (colon-safe). */
export function parseEventIdIn(
  id: string,
  accountIds: string[],
): { accountId: string; calRemote: string; remote: string; recurrenceId?: string } {
  const accountId = accountPrefix(id, accountIds);
  const rest = id.slice(accountId.length + 1);
  const at = rest.lastIndexOf('@');
  const tail = at < 0 ? '' : rest.slice(at + 1);
  const hasRec = at > 0 && RECURRENCE_ID_FORMAT.test(tail);
  const head = hasRec ? rest.slice(0, at) : rest;
  const slash = head.lastIndexOf('/');
  if (slash <= 0 || slash === head.length - 1)
    throw new ContractError({ type: 'notFound', message: 'This event is no longer available.' });
  return {
    accountId,
    calRemote: head.slice(0, slash),
    remote: head.slice(slash + 1),
    ...(hasRec ? { recurrenceId: tail } : {}),
  };
}

/** `parseCalendarId` with account ids resolved against the store (colon-safe). */
export function parseCalendarIdIn(
  id: string,
  accountIds: string[],
): { accountId: string; remoteId: string } {
  const accountId = accountPrefix(id, accountIds);
  const remoteId = id.slice(accountId.length + 1);
  if (!remoteId || remoteId.includes('/'))
    throw new ContractError({ type: 'notFound', message: 'This calendar is no longer available.' });
  return { accountId, remoteId };
}

export function parseEventId(id: string): {
  accountId: string;
  calRemote: string;
  remote: string;
  recurrenceId?: string;
} {
  // The `@` is a recurrence separator only when the tail is a canonical key — Google calendar ids are
  // emails (`…@gmail.com`, `…@group.calendar.google.com`) and stay inside `head`.
  const at = id.lastIndexOf('@');
  const tail = at < 0 ? '' : id.slice(at + 1);
  const hasRec = at > 0 && RECURRENCE_ID_FORMAT.test(tail);
  const head = hasRec ? id.slice(0, at) : id;
  const recId = hasRec ? tail : undefined;
  const colon = head.indexOf(':');
  const slash = head.lastIndexOf('/');
  if (colon <= 0 || slash <= colon + 1 || slash === head.length - 1)
    throw new ContractError({ type: 'notFound', message: 'This event is no longer available.' });
  return {
    accountId: head.slice(0, colon),
    calRemote: head.slice(colon + 1, slash),
    remote: head.slice(slash + 1),
    ...(recId ? { recurrenceId: recId } : {}),
  };
}

/** An `EventTime` as an instant; day and floating readings sit in `zone` (the engine's). */
export function instant(t: EventTime, zone: string): number {
  if (t.type === 'utc') return t.utc;
  if (t.type === 'date') {
    const [y = 1970, m = 1, d = 1] = t.date.split('-').map(Number);
    return fromWall(Date.UTC(y, m - 1, d), zone);
  }
  const tz = t.timeZone && isKnownZone(t.timeZone) ? t.timeZone : zone;
  return fromWall(Date.parse(`${t.local}Z`), tz);
}

/** The canonical `recurrence_id` back to an `EventTime` (the occurrence's original start). */
export function recurrenceIdToTime(recurrenceId: string): EventTime {
  if (recurrenceId.length === 8)
    return {
      type: 'date',
      date: `${recurrenceId.slice(0, 4)}-${recurrenceId.slice(4, 6)}-${recurrenceId.slice(6, 8)}`,
    };
  const local = `${recurrenceId.slice(0, 4)}-${recurrenceId.slice(4, 6)}-${recurrenceId.slice(6, 8)}T${recurrenceId.slice(9, 11)}:${recurrenceId.slice(11, 13)}:${recurrenceId.slice(13, 15)}`;
  return recurrenceId.endsWith('Z')
    ? { type: 'utc', utc: Date.parse(`${local}Z`) }
    : { type: 'floating', local };
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === 'object' ? (v as Rec) : {});
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** A Google event resource's `data` column, or an empty record for another provider's shape. */
function gdata(raw: string): Rec {
  try {
    return rec(JSON.parse(raw));
  } catch {
    return {};
  }
}

type Response = Event['attendees'][number]['response'];

const rsvp = (s: unknown): Response =>
  s === 'accepted' || s === 'declined' || s === 'tentative' ? s : 'needsAction';

function attendee(a: Rec): Event['attendees'][number] {
  const name = str(a.displayName);
  return {
    address: str(a.email) ?? '',
    ...(name ? { name } : {}),
    response: rsvp(a.responseStatus),
    organizer: a.organizer === true,
    self: a.self === true,
    ...(a.optional === true ? { optional: true } : {}),
  };
}

function eventTime(v: Rec, allDay: boolean): EventTime {
  const date = str(v.date);
  if (date) return { type: 'date', date: date.slice(0, 10) };
  const at = str(v.dateTime);
  if (at) {
    const tz = str(v.timeZone);
    return tz
      ? { type: 'floating', local: at.slice(0, 19), timeZone: tz }
      : { type: 'utc', utc: Date.parse(at) };
  }
  return allDay ? { type: 'date', date: '1970-01-01' } : { type: 'utc', utc: 0 };
}

export interface CalRow {
  [k: string]: string | number | null;
  id: number;
  account_id: string;
  remote_id: string;
  name: string | null;
  color: string | null;
  is_primary: number | null;
  hidden: number | null;
  read_only: number | null;
  selected: number;
  time_zone: string | null;
  change_tag: string | null;
}
export interface EvtRow {
  [k: string]: string | number | null;
  id: number;
  calendar_id: number;
  remote_id: string;
  recurrence_id: string;
  master_remote_id: string | null;
  status: string;
  recurrence: string | null;
  start_utc: number | null;
  end_utc: number | null;
  all_day: number | null;
  data: string;
}

export function calendarFromRow(row: CalRow): Calendar {
  return {
    id: calendarContractId(row.account_id, row.remote_id),
    accountId: row.account_id,
    name: row.name ?? '',
    ...(row.color ? { colorTag: row.color } : {}),
    primary: row.is_primary === 1,
    readOnly: row.read_only === 1,
    shown: row.selected === 1,
    providerHidden: row.hidden === 1,
    ...(row.time_zone ? { timeZone: row.time_zone } : {}),
  };
}

const conferenceOf = (g: Rec) => {
  const points = rec(g.conferenceData).entryPoints;
  const link = Array.isArray(points)
    ? points.map(rec).find(e => typeof e.uri === 'string')
    : g.hangoutLink !== undefined
      ? { uri: g.hangoutLink }
      : undefined;
  const uri = link && str(rec(link).uri);
  const label = link && str(rec(link).label);
  return uri ? { url: uri, ...(label ? { label } : {}) } : undefined;
};

const canFor = (readOnly: boolean, organizerIsSelf: boolean, selfAttendee: boolean) => ({
  edit: !readOnly && organizerIsSelf,
  move: !readOnly && organizerIsSelf,
  delete: !readOnly && organizerIsSelf,
  rsvp: selfAttendee,
  editGuests: !readOnly && organizerIsSelf,
});

/**
 * One stored events row (master, single or override) as a contract Event; `cal` is its calendar row,
 * `hiddenSet` the (calendar_id, remote_id, recurrence_id) triples the owner hid.
 */
export function eventFromRow(cal: CalRow, row: EvtRow, hiddenSet: Set<string>): Event {
  const g = gdata(row.data);
  const attendees = Array.isArray(g.attendees)
    ? (g.attendees as unknown[]).map(a => attendee(rec(a)))
    : [];
  const self = attendees.find(a => a.self);
  const gOrg = rec(g.organizer);
  const organizerIsSelf = gOrg.self === true || rec(g.creator).self === true;
  const orgName = str(gOrg.displayName);
  const organizer =
    gOrg.email !== undefined
      ? {
          address: str(gOrg.email) ?? '',
          ...(orgName ? { name: orgName } : {}),
          response: 'accepted' as const,
          organizer: true,
          self: organizerIsSelf,
        }
      : undefined;
  const isOverride = row.recurrence_id !== '';
  // Contract ids and hidden keys name the RESOURCE's remote id — a Google override's own remote_id is its
  // instance id, so `master_remote_id ?? remote_id` everywhere an id is built or a hidden key is checked.
  const resourceRemote = row.master_remote_id ?? row.remote_id;
  const baseId = eventContractId(cal.account_id, cal.remote_id, resourceRemote);
  const hidden =
    hiddenSet.has(`${row.calendar_id}|${resourceRemote}|${row.recurrence_id}`) ||
    hiddenSet.has(`${row.calendar_id}|${resourceRemote}|`);
  const conference = conferenceOf(g);
  const tz = str(rec(g.start).timeZone);
  const transparency = str(g.transparency);
  return {
    id: isOverride ? `${baseId}@${row.recurrence_id}` : baseId,
    rev: 0,
    accountId: cal.account_id,
    calendarId: calendarContractId(cal.account_id, cal.remote_id),
    ...(isOverride
      ? {
          seriesId: baseId,
          originalStart: recurrenceIdToTime(row.recurrence_id),
        }
      : {}),
    recurring: !isOverride && !!row.recurrence,
    exception: isOverride,
    title: str(g.summary) ?? '',
    start: eventTime(rec(g.start), row.all_day === 1),
    end: eventTime(rec(g.end), row.all_day === 1),
    allDay: row.all_day === 1,
    ...(tz ? { timeZone: tz } : {}),
    ...(str(g.location) ? { location: str(g.location) } : {}),
    ...(str(g.description) ? { description: str(g.description) } : {}),
    ...(conference ? { conference } : {}),
    ...(organizer ? { organizer } : {}),
    attendees,
    ...(self ? { myResponse: self.response } : {}),
    status:
      row.status === 'cancelled'
        ? 'cancelled'
        : row.status === 'tentative'
          ? 'tentative'
          : 'confirmed',
    ...(transparency === 'transparent' || transparency === 'opaque' ? { transparency } : {}),
    ...(str(g.htmlLink) ? { htmlLink: str(g.htmlLink) } : {}),
    can: canFor(cal.read_only === 1, organizerIsSelf, !!self),
    ...(hidden ? { hidden: true } : {}),
    sync: 'synced',
  };
}

/** The expanded (not stored) occurrence of a master, carrying the master's fields with occurrence times. */
export function occurrenceEvent(
  master: Event,
  occ: { recurrenceId: string; start: EngineTime; end: EngineTime },
  exception: boolean,
  hidden: boolean,
): Event {
  return {
    ...master,
    id: `${master.id}@${occ.recurrenceId}`,
    seriesId: master.id,
    originalStart: recurrenceIdToTime(occ.recurrenceId),
    start: toWire(occ.start),
    end: toWire(occ.end),
    exception,
    ...(hidden ? { hidden: true } : {}),
  };
}
