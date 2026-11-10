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
  return {
    email: a.address,
    ...(a.name ? { displayName: a.name } : {}),
    ...(a.optional ? { optional: true } : {}),
    ...(current?.responseStatus ? { responseStatus: current.responseStatus } : {}),
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

const path = (calendarRemoteId: string, eventId?: string) =>
  `/calendars/${encodeURIComponent(calendarRemoteId)}/events${eventId ? `/${encodeURIComponent(eventId)}` : ''}`;

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
      ...(req.eventId ? { item: req.eventId } : {}),
    });
  }

  const read = (ctx: AdapterContext, calendar: string, eventId: string) =>
    call(ctx, { method: 'gcal.events.get', calendar, eventId, kind: 'read' });

  const saved = (calendar: string, event: ApiEvent): CalendarWriteResult => {
    const facts = map.facts(calendar, event);
    return { kind: 'saved', upserts: facts ? [facts] : [], removals: [] };
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
    } catch {
      return { kind: 'conflict' };
    }
  }

  async function create(change: EventChange, ctx: AdapterContext): Promise<CalendarWriteResult> {
    const f = change.fields;
    if (f.summary === undefined || f.start === undefined || f.end === undefined)
      throw invalid('Give the event a title, a start and an end.', 'event.fieldsRequired');
    const eventId = newId();
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
      return saved(calendar, made);
    } catch (error) {
      // 409: an earlier send of this same create landed after all — answer with what is there.
      if (statusOf(error) !== 409) throw error;
      return saved(calendar, await read(ctx, calendar, eventId));
    }
  }

  async function edit(change: EventChange, ctx: AdapterContext): Promise<CalendarWriteResult> {
    const calendar = change.calendarRemoteId;
    const eventId = targetId({
      remoteId: change.remoteId!,
      ...(change.recurrenceId ? { recurrenceId: change.recurrenceId } : {}),
      scope: change.scope,
    });
    // New guests need the current list to keep the existing guests' answers.
    const before =
      change.fields.attendees !== undefined ? await read(ctx, calendar, eventId) : undefined;
    const body = eventBody(change.fields, true, before?.attendees);
    try {
      const made = await call(ctx, {
        method: 'gcal.events.patch',
        http: 'PATCH',
        calendar,
        eventId,
        body,
        ifMatch: change.etag,
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
      try {
        await call(ctx, {
          method: 'gcal.events.delete',
          http: 'DELETE',
          calendar,
          eventId,
          ifMatch: ref.etag,
          notify: ref.notify,
          kind: 'idempotentWrite',
        });
      } catch (error) {
        const status = statusOf(error);
        if (status === 412) return conflict(ctx, calendar, eventId);
        // Already gone (404/410) is the state the caller wanted.
        if (status !== 404 && status !== 410) throw error;
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
      if (ref.etag !== undefined && current.etag !== undefined && current.etag !== ref.etag)
        return conflict(ctx, calendar, eventId);
      const guests = current.attendees ?? [];
      const me = guests.find(a => a.self === true);
      if (!me) throw invalid('You are not on this event’s guest list.', 'event.notAGuest');
      if (me.responseStatus === response) return saved(calendar, current);
      const attendees = guests.map(a => (a === me ? { ...a, responseStatus: response } : a));
      try {
        const made = await call(ctx, {
          method: 'gcal.events.patch',
          http: 'PATCH',
          calendar,
          eventId,
          body: { attendees },
          ifMatch: current.etag,
          notify: opts.notify,
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
