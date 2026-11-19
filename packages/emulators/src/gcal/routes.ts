import { SCOPE } from '../gmail/oauth';
import { emptyReply, jsonReply, type Reply } from '../gmail/reply';
import type { Shape } from '../gmail/schema';
import { calForbidden, calInvalid } from './errors';
import {
  deleteEvent,
  getEvent,
  insertEvent,
  patchEvent,
  replaceEvent,
  type WriteOptions,
} from './events';
import { listCalendarList, listEvents, listInstances } from './lists';
import { CALENDAR_RESPONSE } from './schema';
import type { CalendarStore } from './store';
import type { SendUpdates } from './types';

/**
 * The Calendar v3 REST surface the Aplos client uses: calendarList list and get, and events list,
 * get, insert, update, patch, delete and instances. Each route names its API method (for the log),
 * the kind of scope it needs and whether anti-abuse blocks it.
 */
export type CalScope = 'listRead' | 'eventsRead' | 'eventsWrite';

/** Any one of these scopes is enough for a route of that class. */
export const CAL_SCOPES_FOR: Record<CalScope, string[]> = {
  listRead: [
    SCOPE.calendarList,
    SCOPE.calendarListFull,
    SCOPE.calendarReadonly,
    SCOPE.calendarFull,
  ],
  eventsRead: [
    SCOPE.calendarEvents,
    SCOPE.calendarEventsReadonly,
    SCOPE.calendarReadonly,
    SCOPE.calendarFull,
  ],
  eventsWrite: [SCOPE.calendarEvents, SCOPE.calendarFull],
};

export interface CalContext {
  store: CalendarStore;
  query: URLSearchParams;
  params: Record<string, string>;
  headers: Headers;
  json(): Record<string, unknown>;
}

export interface CalRoute {
  method: string;
  /** Path below /calendar/v3/, with :name placeholders. */
  pattern: string;
  apiMethod: string;
  scope: CalScope;
  /** Writes are what the anti-abuse switch refuses. */
  write?: boolean;
  handler(ctx: CalContext): Reply;
}

function writeOptions(ctx: CalContext): WriteOptions {
  const raw = ctx.query.get('sendUpdates');
  if (raw !== null && !['all', 'externalOnly', 'none'].includes(raw))
    throw calInvalid('Invalid value for: sendUpdates');
  // The older boolean still works when sendUpdates is absent.
  const sendUpdates: SendUpdates =
    (raw as SendUpdates | null) ?? (ctx.query.get('sendNotifications') === 'true' ? 'all' : 'none');
  const versionText = ctx.query.get('conferenceDataVersion');
  const conferenceDataVersion =
    versionText === null || versionText === '' ? 0 : Number(versionText);
  if (
    !Number.isInteger(conferenceDataVersion) ||
    conferenceDataVersion < 0 ||
    conferenceDataVersion > 1
  )
    throw calInvalid('Invalid conference data version.');
  return { sendUpdates, conferenceDataVersion, ifMatch: ctx.headers.get('if-match') ?? undefined };
}

/** The calendar named in the path; 404 when the user has no such calendar. */
function calendarFor(ctx: CalContext) {
  return ctx.store.calendar(ctx.params.calendarId);
}

/** Events can be read from any calendar but a free/busy-only one. */
function readableCalendar(ctx: CalContext) {
  const cal = calendarFor(ctx);
  if (cal.accessRole === 'freeBusyReader') throw calForbidden();
  return cal;
}

export const CALENDAR_ROUTES: CalRoute[] = [
  {
    method: 'GET',
    pattern: 'users/me/calendarList',
    apiMethod: 'calendar.calendarList.list',
    scope: 'listRead',
    handler: ctx => jsonReply(listCalendarList(ctx.store, ctx.query)),
  },
  {
    method: 'GET',
    pattern: 'users/me/calendarList/:calendarId',
    apiMethod: 'calendar.calendarList.get',
    scope: 'listRead',
    handler: ctx => jsonReply(ctx.store.entryView(calendarFor(ctx))),
  },
  {
    method: 'GET',
    pattern: 'calendars/:calendarId/events',
    apiMethod: 'calendar.events.list',
    scope: 'eventsRead',
    handler: ctx => jsonReply(listEvents(ctx.store, readableCalendar(ctx), ctx.query)),
  },
  {
    method: 'POST',
    pattern: 'calendars/:calendarId/events',
    apiMethod: 'calendar.events.insert',
    scope: 'eventsWrite',
    write: true,
    handler: ctx =>
      jsonReply(insertEvent(ctx.store, calendarFor(ctx), ctx.json(), writeOptions(ctx))),
  },
  {
    method: 'GET',
    pattern: 'calendars/:calendarId/events/:eventId/instances',
    apiMethod: 'calendar.events.instances',
    scope: 'eventsRead',
    handler: ctx =>
      jsonReply(listInstances(ctx.store, readableCalendar(ctx), ctx.params.eventId, ctx.query)),
  },
  {
    method: 'GET',
    pattern: 'calendars/:calendarId/events/:eventId',
    apiMethod: 'calendar.events.get',
    scope: 'eventsRead',
    handler: ctx => {
      const event = getEvent(readableCalendar(ctx), ctx.params.eventId);
      const none = ctx.headers.get('if-none-match');
      return none !== null && none === event.etag
        ? emptyReply(304)
        : jsonReply(event, 200, { etag: event.etag });
    },
  },
  {
    method: 'PUT',
    pattern: 'calendars/:calendarId/events/:eventId',
    apiMethod: 'calendar.events.update',
    scope: 'eventsWrite',
    write: true,
    handler: ctx =>
      jsonReply(
        replaceEvent(
          ctx.store,
          calendarFor(ctx),
          ctx.params.eventId,
          ctx.json(),
          writeOptions(ctx),
        ),
      ),
  },
  {
    method: 'PATCH',
    pattern: 'calendars/:calendarId/events/:eventId',
    apiMethod: 'calendar.events.patch',
    scope: 'eventsWrite',
    write: true,
    handler: ctx =>
      jsonReply(
        patchEvent(ctx.store, calendarFor(ctx), ctx.params.eventId, ctx.json(), writeOptions(ctx)),
      ),
  },
  {
    method: 'DELETE',
    pattern: 'calendars/:calendarId/events/:eventId',
    apiMethod: 'calendar.events.delete',
    scope: 'eventsWrite',
    write: true,
    handler: ctx => {
      deleteEvent(ctx.store, calendarFor(ctx), ctx.params.eventId, writeOptions(ctx));
      return emptyReply(204);
    },
  },
];

export interface CalRouteMatch {
  route: CalRoute;
  params: Record<string, string>;
}

/** Matches a path below /calendar/v3/. Unknown paths and methods give undefined (a 404 upstream). */
export function matchCalendarRoute(method: string, path: string): CalRouteMatch | undefined {
  const prefix = '/calendar/v3/';
  if (!path.startsWith(prefix)) return undefined;
  const parts = path.slice(prefix.length).split('/');
  for (const route of CALENDAR_ROUTES) {
    if (route.method !== method) continue;
    const pattern = route.pattern.split('/');
    if (pattern.length !== parts.length) continue;
    const params: Record<string, string> = {};
    const ok = pattern.every((segment, i) => {
      if (!segment.startsWith(':')) return segment === parts[i];
      if (!parts[i]) return false;
      try {
        params[segment.slice(1)] = decodeURIComponent(parts[i]);
      } catch {
        return false;
      }
      return true;
    });
    if (ok) return { route, params };
  }
  return undefined;
}

const RESPONSE_SHAPES: Record<string, Shape> = {
  'calendar.calendarList.list': CALENDAR_RESPONSE.list,
  'calendar.calendarList.get': CALENDAR_RESPONSE.entry,
  'calendar.events.list': CALENDAR_RESPONSE.events,
  'calendar.events.instances': CALENDAR_RESPONSE.events,
  'calendar.events.get': CALENDAR_RESPONSE.event,
  'calendar.events.insert': CALENDAR_RESPONSE.event,
  'calendar.events.update': CALENDAR_RESPONSE.event,
  'calendar.events.patch': CALENDAR_RESPONSE.event,
};

export const calendarShapeOf = (apiMethod: string): Shape | undefined => RESPONSE_SHAPES[apiMethod];
