import { ContractError } from '@aplos/contract/contract-error';
import { ProviderError } from '@aplos/engine/ports';
import type {
  AdapterContext,
  Attendee,
  CalendarAdapter,
  CalendarWriteResult,
  EditScope,
  EventChange,
  EventFacts,
  EventFields,
  EventRef,
  EventTime,
} from '@aplos/engine/ports';
import { GcalClient, type GcalDeps } from './gcal-client';
import type { GcalMethod } from './costs';

/**
 * Event writes of the Google `calendar` (prov-cal): create, edit, delete and RSVP on the `gcal` budget.
 *
 * - Only changed fields are sent (D11); an edit carries `If-Match` with the etag the caller last saw, and a 412 is a
 *   result (`conflict`, with the event as it is now), never an error.
 * - A create picks its own event id, so a request whose answer was lost and is sent again meets 409 instead of making a
 *   second event; the 409 is answered by reading the event back.
 * - `occurrence` on a recurring event addresses Google's instance id (`<series>_<recurrenceId>`), which creates or
 *   updates that one override; `series` addresses the master. `following` is not offered yet.
 * - Guests are told only when the caller asked (`sendUpdates=all`); the default is `none`.
 * - A change never reads or writes another calendar than the one named: the calendar id is path-encoded and the
 *   token is the account's own.
 */

interface ApiDateTime {
  date?: string | null;
  dateTime?: string | null;
  timeZone?: string;
}

interface ApiAttendee {
  email?: string;
  displayName?: string;
  responseStatus?: string;
  self?: boolean;
  optional?: boolean;
}

/** The slice of Google's event JSON the writes read back; the whole object is kept for `raw` by the mapper. */
interface ApiEvent {
  id?: string;
  status?: string;
  organizer?: { email?: string; self?: boolean };
  etag?: string;
  attendees?: ApiAttendee[];
}

/** What the writes need from `calendar.ts`: its field mask and its event mapper (one mapping for reads and writes). */
export interface EventMapping {
  fields: string;
  facts(calendarRemoteId: string, event: ApiEvent): EventFacts | undefined;
}

export interface CalendarWriteDeps extends GcalDeps {
  /** A fresh event id for a create. Tests inject a fixed one; the default is 128 random bits. */
  newId?: () => string;
  /** Every write's deadline in ms (default 20 s); tests shorten it. */
  writeTimeoutMs?: number;
}

const invalid = (message: string, reasonCode: string) =>
  new ContractError({ type: 'validation', message, reasonCode });

/** Base32hex (a-v, 0-9), the alphabet Google allows for a client-chosen event id; 26 characters of randomness. */
function randomEventId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(26));
  return Array.from(bytes, b => '0123456789abcdefghijklmnopqrstuv'[b % 32]).join('');
}

/** `EventTime` to Google's start/end object. */
function apiTime(t: EventTime, patch: boolean): ApiDateTime {
  if (t.type === 'date') return { date: t.date, ...(patch ? { dateTime: null } : {}) };
  if (t.type === 'utc')
    return { dateTime: new Date(t.utc).toISOString(), ...(patch ? { date: null } : {}) };
  if (!t.timeZone) throw invalid('Pick a time zone for this event.', 'event.timeZoneRequired');
  return {
    dateTime: t.local.slice(0, 19),
    timeZone: t.timeZone,
    ...(patch ? { date: null } : {}),
  };
}

function apiAttendee(a: Attendee, current: ApiAttendee | undefined): ApiAttendee {
  // A guest already on the event keeps their answer (and the self flag); only new guests start unanswered.
  // Start from the guest Google already has (resource, comment, additionalGuests, answer…) and overlay only what
  // the caller edits: the name and the optional flag.
  return {
    ...current,
    email: a.address,
    ...(a.name ? { displayName: a.name } : {}),
    optional: a.optional === true,
  };
}

/** The body of a create or an edit: only the fields the caller sent. */
function eventBody(
  f: Partial<EventFields>,
  patch: boolean,
  current?: ApiAttendee[],
): Record<string, unknown> {
  if (f.allDay !== undefined && (f.start === undefined || f.end === undefined))
    throw invalid(
      'Set the start and end when changing between all-day and timed.',
      'event.timesRequired',
    );
  // The all-day flag and the shape of the times must agree, or Google would store something the caller did not mean.
  for (const t of [f.start, f.end])
    if (t && f.allDay !== undefined && (t.type === 'date') !== f.allDay)
      throw invalid('The times do not match the all-day setting.', 'event.allDayMismatch');
  const byEmail = new Map((current ?? []).map(a => [a.email?.toLowerCase(), a]));
  return {
    ...(f.summary !== undefined ? { summary: f.summary } : {}),
    ...(f.location !== undefined ? { location: f.location } : {}),
    ...(f.description !== undefined ? { description: f.description } : {}),
    ...(f.start !== undefined ? { start: apiTime(f.start, patch) } : {}),
    ...(f.end !== undefined ? { end: apiTime(f.end, patch) } : {}),
    ...(f.attendees !== undefined
      ? { attendees: f.attendees.map(a => apiAttendee(a, byEmail.get(a.address.toLowerCase()))) }
      : {}),
  };
}

/** The Google event id a change addresses: the instance for one occurrence, else the series (or single event). */
export function targetId(ref: {
  remoteId: string;
  recurrenceId?: string;
  scope: EditScope;
}): string {
  if (ref.scope === 'following')
    throw new ContractError({
      type: 'unsupported',
      message: 'Changing this and the following events is not available yet.',
      reasonCode: 'event.followingUnsupported',
    });
  return ref.scope === 'occurrence' && ref.recurrenceId
    ? `${ref.remoteId}_${ref.recurrenceId}`
    : ref.remoteId;
}

const sendUpdates = (notify: boolean | undefined) => (notify === true ? 'all' : 'none');

/** Every write call's deadline (30 s); reads stay unbounded (they already fail on governor/abort). */
const WRITE_TIMEOUT_MS = 30_000;

const path = (calendarRemoteId: string, eventId?: string) =>
  `/calendars/${encodeURIComponent(calendarRemoteId)}/events${eventId ? `/${encodeURIComponent(eventId)}` : ''}`;

/**
 * An idempotent write the governor may have sent more than once and never saw an answer for: the event may exist, so the
 * caller is told it is uncertain instead of "nothing was changed".
 */
function uncertain(error: unknown): unknown {
  if (error instanceof ProviderError && error.error.class === 'transient')
    return new ProviderError({ ...error.error, uncertain: true }, error.scope);
  return error;
}

const statusOf = (error: unknown): number | undefined =>
  error instanceof ProviderError ? error.error.status : undefined;

export function createCalendarWrites(
  deps: CalendarWriteDeps,
  map: EventMapping,
): Pick<CalendarAdapter, 'put' | 'remove' | 'rsvp'> {
  const newId = deps.newId ?? randomEventId;

  async function call(
    ctx: AdapterContext,
    req: {
      method: GcalMethod;
      http?: 'POST' | 'PATCH' | 'DELETE';
      calendar: string;
      eventId?: string;
      body?: unknown;
      ifMatch?: string;
      notify?: boolean;
      kind: 'read' | 'idempotentWrite' | 'write';
    },
  ): Promise<ApiEvent> {
    const client = new GcalClient(deps, ctx);
    return client.call<ApiEvent>({
      method: req.method,
      ...(req.http ? { http: req.http } : {}),
      path: path(req.calendar, req.eventId),
      query: req.http ? { sendUpdates: sendUpdates(req.notify) } : {},
      // A DELETE answers 204 with no body, so there is nothing to mask.
      ...(req.http === 'DELETE' ? {} : { fields: map.fields }),
      ...(req.body !== undefined ? { body: req.body } : {}),
      ...(req.ifMatch ? { ifMatch: req.ifMatch } : {}),
      lane: 'interactive',
      kind: req.kind,
      // Writes get a bound: a hung request fails instead of holding the op forever (MED, #394).
      ...(req.http ? { timeoutMs: deps.writeTimeoutMs ?? WRITE_TIMEOUT_MS } : {}),
      ...(req.eventId ? { item: req.eventId } : {}),
    });
  }

  const read = (ctx: AdapterContext, calendar: string, eventId: string) =>
    call(ctx, { method: 'gcal.events.get', calendar, eventId, kind: 'read' });

  /** `read` that answers undefined for a missing event (404/410), every other failure thrown. */
  const tryRead = async (ctx: AdapterContext, calendar: string, eventId: string) => {
    try {
      return await read(ctx, calendar, eventId);
    } catch (error) {
      const status = statusOf(error);
      if (status === 404 || status === 410) return undefined;
      throw error;
    }
  };

  const saved = (calendar: string, event: ApiEvent, inserted?: boolean): CalendarWriteResult => {
    const facts = map.facts(calendar, event);
    return {
      kind: 'saved',
      upserts: facts ? [{ ...facts, ...(inserted === undefined ? {} : { inserted }) }] : [],
      removals: [],
    };
  };

  /** The event as it is now, for the "changed elsewhere" answer; a failed read-back still answers conflict. */
  async function conflict(
    ctx: AdapterContext,
    calendar: string,
    eventId: string,
  ): Promise<CalendarWriteResult> {
    try {
      const current = map.facts(calendar, await read(ctx, calendar, eventId));
      return { kind: 'conflict', ...(current ? { current } : {}) };
    } catch (error) {
      // Gone since: say so (the caller sees "no longer on the calendar"), not "changed elsewhere".
      const status = statusOf(error);
      if (status === 404 || status === 410) throw error;
      return { kind: 'conflict' };
    }
  }

  async function create(change: EventChange, ctx: AdapterContext): Promise<CalendarWriteResult> {
    const f = change.fields;
    if (f.summary === undefined || f.start === undefined || f.end === undefined)
      throw invalid('Give the event a title, a start and an end.', 'event.fieldsRequired');
    // An op-derived id makes a re-sent create idempotent (409 → read back); without one the id is random.
    const eventId = change.newRemoteId ?? newId();
    const body = { id: eventId, ...eventBody(f, false) };
    const calendar = change.calendarRemoteId;
    try {
      const made = await call(ctx, {
        method: 'gcal.events.insert',
        http: 'POST',
        calendar,
        body,
        notify: change.notify,
        kind: 'idempotentWrite',
      });
      return saved(calendar, made, true);
    } catch (error) {
      // 409: an earlier send of this same create landed after all — answer with what is there.
      if (statusOf(error) !== 409) throw uncertain(error);
      const there = await read(ctx, calendar, eventId);
      // The same op id met an event that was deleted since: that is not "your create landed", and nothing exists.
      if (there.status === 'cancelled')
        throw new ContractError({
          type: 'conflict',
          message: 'That event was deleted. Create it again as a new event.',
          reasonCode: 'calendar.opReused',
        });
      // Not inserted by this call: the read-back is an event that was already there (flagged so a
      // caller that deletes on its own behalf never touches it).
      return saved(calendar, there, false);
    }
  }

  async function edit(change: EventChange, ctx: AdapterContext): Promise<CalendarWriteResult> {
    const calendar = change.calendarRemoteId;
    const eventId = targetId({
      remoteId: change.remoteId!,
      ...(change.recurrenceId ? { recurrenceId: change.recurrenceId } : {}),
      scope: change.scope,
    });
    // New guests need the current list to keep the existing guests' answers. An occurrence with no stored
    // etag (no exception row seen yet) also reads first: an instance Google already holds gets ITS etag as
    // the base, so the patch is still guarded; a 404 means the override is created (nothing to clobber).
    const isOccurrence = eventId !== change.remoteId;
    const before =
      change.fields.attendees !== undefined || (isOccurrence && change.etag === undefined)
        ? await tryRead(ctx, calendar, eventId)
        : undefined;
    const body = eventBody(change.fields, true, before?.attendees);
    try {
      const made = await call(ctx, {
        method: 'gcal.events.patch',
        http: 'PATCH',
        calendar,
        eventId,
        body,
        ifMatch: change.etag ?? before?.etag,
        notify: change.notify,
        kind: 'write',
      });
      return saved(calendar, made);
    } catch (error) {
      if (statusOf(error) !== 412) throw error;
      return conflict(ctx, calendar, eventId);
    }
  }

  return {
    async put(change, ctx) {
      return change.remoteId === undefined ? create(change, ctx) : edit(change, ctx);
    },

    async remove(ref: EventRef & { scope: EditScope; notify?: boolean }, ctx) {
      const calendar = ref.calendarRemoteId;
      const eventId = targetId(ref);
      const instance = eventId !== ref.remoteId;
      // One occurrence with no stored version of its own is deleted against the version just read (a change made
      // elsewhere since is a conflict, not a blind delete); an instance Google no longer has is already gone.
      let base = ref.etag;
      if (instance && base === undefined) {
        const now = await tryRead(ctx, calendar, eventId);
        if (now === undefined) return { kind: 'saved', upserts: [], removals: [] };
        base = now.etag;
      }
      try {
        await call(ctx, {
          method: 'gcal.events.delete',
          http: 'DELETE',
          calendar,
          eventId,
          ifMatch: base,
          notify: ref.notify,
          kind: 'idempotentWrite',
        });
      } catch (error) {
        const status = statusOf(error);
        if (status === 412) {
          // The first DELETE may have landed and only its answer been lost: if the event is gone, that is saved.
          const now = await tryRead(ctx, calendar, eventId);
          if (now !== undefined && now.status !== 'cancelled')
            return conflict(ctx, calendar, eventId);
        } else if (status !== 404 && status !== 410) throw uncertain(error);
        // Already gone (404/410, or 412 on a cancelled event) is the state the caller wanted.
      }
      if (!instance) return { kind: 'saved', upserts: [], removals: [ref.remoteId] };
      // One occurrence of a series: Google keeps a cancelled override, which hides it; read it back.
      try {
        return saved(calendar, await read(ctx, calendar, eventId));
      } catch {
        return { kind: 'saved', upserts: [], removals: [] };
      }
    },

    async rsvp(ref, response, opts, ctx) {
      const calendar = ref.calendarRemoteId;
      const eventId = targetId(ref);
      const current = await read(ctx, calendar, eventId);
      const guests = current.attendees ?? [];
      const me = guests.find(a => a.self === true);
      if (!me) throw invalid('You are not on this event’s guest list.', 'event.notAGuest');
      // No staleness pre-check: on a busy meeting another guest's answer bumps the etag all the time. The PATCH
      // carries If-Match on the copy just read and changes only my answer in it; nothing to write when it is already
      // the target (MED, #394).
      if (me.responseStatus === response) return saved(calendar, current);
      // A guest answers for themself only: `attendeesOmitted` + their own entry changes just that answer, so
      // another guest's answer can neither be raced nor re-sent. The organizer answering their own event keeps the
      // whole list (Google only lets the organizer edit it) and tells no one: nobody needs to hear that the
      // organizer accepts their own meeting.
      const organizer = current.organizer?.self === true;
      const body = organizer
        ? { attendees: guests.map(a => (a === me ? { ...a, responseStatus: response } : a)) }
        : {
            attendeesOmitted: true,
            attendees: [{ email: me.email ?? ctx.account.address, responseStatus: response }],
          };
      try {
        const made = await call(ctx, {
          method: 'gcal.events.patch',
          http: 'PATCH',
          calendar,
          eventId,
          body,
          ifMatch: current.etag,
          notify: organizer ? false : opts.notify,
          kind: 'write',
        });
        return saved(calendar, made);
      } catch (error) {
        if (statusOf(error) !== 412) throw error;
        return conflict(ctx, calendar, eventId);
      }
    },
  };
}
