import { NotImplementedError } from '@aplos/contract/contract-error';
import { ProviderError } from '@aplos/engine/ports';
import type {
  AdapterContext,
  Attendee,
  CalendarAdapter,
  CalendarFacts,
  CalendarStepResult,
  CalendarWriteResult,
  EventChange,
  EventFacts,
  EventRef,
  EventTime,
  PlanInput,
  PlannedStep,
  ScopeId,
  SyncLane,
  SyncState,
} from '@aplos/engine/ports';
import { GcalClient, type GcalDeps } from './gcal-client';

/**
 * The `calendar` of the Google adapter (prov-cal, ports.walk.md "Google Calendar (round 1)"): `calendarList` for the
 * list, `events.list` `singleEvents=false` with per-calendar sync tokens on the `gcal` budget. Masters and overrides
 * are returned as facts (`recurrenceId` canonical, `masterRemoteId` the `recurringEventId`, `raw` the provider JSON);
 * expansion is client-side. Writes (`put`, `remove`, `rsvp`) are round 2 — every one rejects `notImplemented`.
 *
 * Which calendars to sync reaches `plan` over `provider_memory['cal.sync']`, written by the engine's calendar-list
 * commit (sync/calendar-facts.ts): the remote ids of the calendars the last list returned as selected and not hidden.
 */

const LIST_MS = 30 * 60_000;
/** Primary every 2-5 min, every other calendar every 15-30 min, each jittered by its remote id (ARCH 5.5). */
const PRIMARY_MIN_MS = 2 * 60_000;
const PRIMARY_SPAN_MS = 3 * 60_000;
const OTHER_MIN_MS = 15 * 60_000;
const OTHER_SPAN_MS = 15 * 60_000;
const PAGE = 250;

/** Deterministic jitter in [0,1) from the scope's remote id (keeps calendars off one beat). */
function jitter(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return (h >>> 0) / 0x1_0000_0000;
}

const LIST_FIELDS =
  'kind,etag,nextPageToken,nextSyncToken,' +
  'items(id,etag,summary,summaryOverride,timeZone,colorId,accessRole,selected,hidden,primary,deleted)';
const EVENT_FIELDS =
  'kind,etag,nextPageToken,nextSyncToken,' +
  'items(id,etag,iCalUID,status,htmlLink,summary,description,location,colorId,' +
  'creator,organizer,start,end,recurrence,recurringEventId,originalStartTime,transparency,visibility,' +
  'attendees,guestsCanModify,conferenceData,hangoutLink,updated)';

// ---------- API JSON shapes (the fields the masks ask for) ----------

interface ApiDateTime {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

interface ApiAttendee {
  email?: string;
  displayName?: string;
  responseStatus?: string;
  organizer?: boolean;
  self?: boolean;
  optional?: boolean;
}

interface ApiEvent {
  id?: string;
  etag?: string;
  iCalUID?: string;
  status?: string;
  htmlLink?: string;
  summary?: string;
  description?: string;
  location?: string;
  creator?: { email?: string; self?: boolean };
  organizer?: { email?: string; self?: boolean };
  start?: ApiDateTime;
  end?: ApiDateTime;
  recurrence?: string[];
  recurringEventId?: string;
  originalStartTime?: ApiDateTime;
  transparency?: string;
  attendees?: ApiAttendee[];
  guestsCanModify?: boolean;
  conferenceData?: { entryPoints?: { uri?: string; label?: string }[] };
  hangoutLink?: string;
}

interface ApiListResponse<T> {
  items?: T[];
  nextPageToken?: string;
  nextSyncToken?: string;
}

interface ApiCalendarEntry {
  id?: string;
  etag?: string;
  summary?: string;
  summaryOverride?: string;
  timeZone?: string;
  colorId?: string;
  accessRole?: string;
  selected?: boolean;
  hidden?: boolean;
  primary?: boolean;
  deleted?: boolean;
}

interface ApiCalendarListEntry extends ApiCalendarEntry {
  kind?: string;
}

/** The `cal.sync` provider_memory entry: the calendars the last list said to sync. */
interface SyncCalendar {
  id: string;
  primary?: boolean;
}

// ---------- mapping ----------

const HAS_OFFSET = /(Z|[+-]\d{2}:\d{2})$/;
const pad = (n: number) => String(n).padStart(2, '0');

/** `start`/`end`/`originalStartTime` as an F1 `EventTime`. */
function eventTime(v: ApiDateTime | undefined): EventTime | undefined {
  if (!v) return undefined;
  if (v.date) return { type: 'date', date: v.date.slice(0, 10) };
  const at = v.dateTime;
  if (!at) return undefined;
  if (HAS_OFFSET.test(at)) return { type: 'utc', utc: Date.parse(at) };
  return v.timeZone
    ? { type: 'floating', local: at.slice(0, 19), timeZone: v.timeZone }
    : { type: 'floating', local: at.slice(0, 19) };
}

/**
 * The canonical `recurrenceId` (ports/calendar.ts RECURRENCE_ID_FORMAT): a timed original start to UTC
 * `YYYYMMDDTHHMMSSZ`, an all-day one `YYYYMMDD`, a floating one the wall clock `YYYYMMDDTHHMMSS`.
 */
function canonicalRecurrenceId(v: ApiDateTime | undefined): string | undefined {
  if (!v) return undefined;
  if (v.date) return v.date.slice(0, 10).replace(/-/g, '');
  const at = v.dateTime;
  if (!at) return undefined;
  if (HAS_OFFSET.test(at)) {
    const d = new Date(Date.parse(at));
    return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
  }
  return at.slice(0, 19).replace(/[-:]/g, '');
}

/** Google `responseStatus` to the F1 response. */
const response = (s: string | undefined): Attendee['response'] =>
  s === 'accepted' || s === 'declined' || s === 'tentative' ? s : 'needsAction';

function attendee(a: ApiAttendee): Attendee {
  return {
    address: a.email ?? '',
    ...(a.displayName ? { name: a.displayName } : {}),
    response: response(a.responseStatus),
    organizer: a.organizer === true,
    self: a.self === true,
    ...(a.optional === true ? { optional: true } : {}),
  };
}

/** `recurrence` lines split by property name; the full lines are kept (`RDATE;TZID=…:…`). */
function recurrenceOf(lines: string[] | undefined): Pick<EventFacts, 'rrule' | 'rdate' | 'exdate'> {
  const rrule: string[] = [];
  const rdate: string[] = [];
  const exdate: string[] = [];
  for (const line of lines ?? []) {
    if (line.startsWith('RRULE')) rrule.push(line);
    else if (line.startsWith('RDATE')) rdate.push(line);
    else if (line.startsWith('EXDATE')) exdate.push(line);
  }
  return {
    ...(rrule.length ? { rrule } : {}),
    ...(rdate.length ? { rdate } : {}),
    ...(exdate.length ? { exdate } : {}),
  };
}

function conference(e: ApiEvent): EventFacts['conference'] {
  const uri = e.conferenceData?.entryPoints?.find(p => typeof p.uri === 'string');
  if (uri?.uri) return { url: uri.uri, ...(uri.label ? { provider: uri.label } : {}) };
  return e.hangoutLink ? { url: e.hangoutLink, provider: 'meet' } : undefined;
}

function eventFacts(calendarRemoteId: string, e: ApiEvent): EventFacts | undefined {
  if (typeof e.id !== 'string' || e.id === '') return undefined;
  const override = e.recurringEventId !== undefined;
  const recurrenceId = canonicalRecurrenceId(e.originalStartTime);
  const status =
    e.status === 'cancelled' ? 'cancelled' : e.status === 'tentative' ? 'tentative' : 'confirmed';
  const epoch = { type: 'date', date: '1970-01-01' } as const;
  // A cancelled row can arrive with nothing but id/status/recurring ids; its times never show.
  const start = eventTime(e.start) ?? epoch;
  const end = eventTime(e.end) ?? start;
  return {
    calendarRemoteId,
    remoteId: e.id,
    ...(e.etag ? { etag: e.etag } : {}),
    summary: e.summary ?? '',
    location: e.location ?? '',
    description: e.description ?? '',
    start,
    end,
    allDay: e.start?.date !== undefined,
    attendees: (e.attendees ?? []).map(attendee),
    ...(override ? { masterRemoteId: e.recurringEventId } : {}),
    ...(override && recurrenceId ? { recurrenceId, instance: 'exception' as const } : {}),
    ...(e.iCalUID ? { uid: e.iCalUID } : {}),
    ...(!override ? recurrenceOf(e.recurrence) : {}),
    status,
    organizerIsSelf: e.organizer?.self === true || e.creator?.self === true,
    canEditShared: e.guestsCanModify === true,
    ...(conference(e) ? { conference: conference(e) } : {}),
    raw: JSON.stringify(e),
  };
}

function calendarFacts(e: ApiCalendarListEntry): CalendarFacts | undefined {
  if (typeof e.id !== 'string' || e.id === '') return undefined;
  const role = e.accessRole ?? 'reader';
  return {
    remoteId: e.id,
    name: e.summaryOverride ?? e.summary ?? '',
    ...(e.colorId ? { color: e.colorId } : {}),
    ...(e.primary === true ? { primary: true } : {}),
    hidden: e.hidden === true,
    selected: e.selected !== false,
    readOnly: role !== 'owner' && role !== 'writer',
    ...(e.timeZone ? { timeZone: e.timeZone } : {}),
    ...(e.etag ? { changeTag: e.etag } : {}),
  };
}

// ---------- the adapter ----------

export function createGoogleCalendar(deps: GcalDeps): CalendarAdapter {
  const client = (ctx: AdapterContext) => new GcalClient(deps, ctx);

  /** The calendars the last list marked for sync (`cal.sync` provider_memory). */
  const syncCalendars = (input: PlanInput): SyncCalendar[] => {
    try {
      const parsed: unknown = JSON.parse(input.memory.get('cal.sync') ?? '[]');
      return Array.isArray(parsed)
        ? parsed.filter(
            (c): c is SyncCalendar =>
              typeof c === 'object' && c !== null && typeof (c as SyncCalendar).id === 'string',
          )
        : [];
    } catch {
      return [];
    }
  };

  return {
    budget: 'gcal',

    plan(input: PlanInput): PlannedStep[] {
      // No calendar scopes on the grant: nothing planned at all (the account shows missingPermissions instead).
      if (input.account.capabilities.calendar !== true) return [];
      const steps: PlannedStep[] = [];
      const list = input.states.find(s => s.scope === 'calendars');
      steps.push({
        scope: 'calendars',
        lane: 'incremental',
        origin: 'incremental',
        trigger: input.trigger,
        notBefore: list ? list.updatedAt + LIST_MS : input.env.now,
      });
      for (const cal of syncCalendars(input)) {
        const scope = `cal:${cal.id}` as ScopeId;
        const state = input.states.find(s => s.scope === scope);
        // No cursor yet: the first full events.list is a backfill (secondary devices skip it, ARCH 6.5).
        const lane: SyncLane = state?.cursor ? 'incremental' : 'backfill';
        const wait = cal.primary
          ? PRIMARY_MIN_MS + jitter(cal.id) * PRIMARY_SPAN_MS
          : OTHER_MIN_MS + jitter(cal.id) * OTHER_SPAN_MS;
        steps.push({
          scope,
          lane,
          origin: lane === 'backfill' ? 'backfill' : 'incremental',
          trigger: input.trigger,
          notBefore: state ? state.updatedAt + wait : input.env.now,
        });
      }
      return steps;
    },

    async listCalendars(state: SyncState | undefined, ctx: AdapterContext) {
      const c = client(ctx);
      const syncToken = state?.cursor;
      let pageToken = state?.pageToken;
      const calendars: CalendarFacts[] = [];
      const removed: string[] = [];
      let nextSyncToken: string | undefined;
      for (;;) {
        const res = await c.call<ApiListResponse<ApiCalendarListEntry>>({
          method: 'gcal.calendarList.list',
          path: '/users/me/calendarList',
          query: {
            maxResults: PAGE,
            showHidden: true,
            ...(syncToken ? { syncToken, showDeleted: true } : {}),
            ...(pageToken ? { pageToken } : {}),
          },
          fields: LIST_FIELDS,
          lane: 'incremental',
        });
        for (const entry of res.items ?? []) {
          if (entry.deleted === true) {
            if (entry.id) removed.push(entry.id);
            continue;
          }
          const facts = calendarFacts(entry);
          if (facts) calendars.push(facts);
        }
        pageToken = res.nextPageToken;
        if (!pageToken) {
          nextSyncToken = res.nextSyncToken;
          break;
        }
      }
      return {
        calendars,
        removed,
        nextState: {
          scope: 'calendars',
          ...(nextSyncToken ? { cursor: nextSyncToken } : {}),
          generation: state?.generation ?? ctx.generation,
          updatedAt: ctx.clock.now(),
        },
        costUnits: c.spent,
      };
    },

    async syncStep(
      calendarRemoteId: string,
      state: SyncState,
      lane: SyncLane,
      ctx: AdapterContext,
    ): Promise<CalendarStepResult> {
      const c = client(ctx);
      const scope = `cal:${calendarRemoteId}` as const;
      let syncToken = state.cursor;
      let pageToken = state.pageToken;
      const upserts: EventFacts[] = [];
      let nextSyncToken: string | undefined;
      let reset: CalendarStepResult['reset'];

      const page = (query: Record<string, string | number | boolean | undefined>) =>
        c.call<ApiListResponse<ApiEvent>>({
          method: 'gcal.events.list',
          path: `/calendars/${encodeURIComponent(calendarRemoteId)}/events`,
          query: { maxResults: PAGE, singleEvents: false, ...query },
          fields: EVENT_FIELDS,
          lane,
        });

      for (;;) {
        let res: ApiListResponse<ApiEvent>;
        try {
          res = await page({
            showDeleted: true,
            ...(pageToken ? { pageToken } : syncToken ? { syncToken } : {}),
          });
        } catch (error) {
          // A 410 is a resync of this calendar alone: drop the token and list everything (ports.walk.md).
          const fullSync =
            !pageToken &&
            syncToken !== undefined &&
            error instanceof ProviderError &&
            error.error.status === 410;
          if (!fullSync) throw error;
          // The token is dead: the resync asks for everything without one (ports.walk.md).
          pageToken = undefined;
          syncToken = undefined;
          reset = 'syncTokenInvalid';
          continue;
        }
        for (const e of res.items ?? []) {
          const facts = eventFacts(calendarRemoteId, e);
          if (facts) upserts.push(facts);
        }
        pageToken = res.nextPageToken;
        if (!pageToken) {
          nextSyncToken = res.nextSyncToken;
          break;
        }
      }

      // A round that starts now (first sync or a 410 resync) stamps the current fence; incremental steps keep the
      // generation their round opened with, so a later resync sweep can tell them from rows of the new round.
      const generation = state.generation === 0 || reset ? ctx.generation : state.generation;
      return {
        upserts,
        removals: [],
        nextState: {
          scope,
          ...(nextSyncToken ? { cursor: nextSyncToken } : {}),
          generation,
          updatedAt: ctx.clock.now(),
        },
        done: true,
        // A resync listed every event: rows stamped by an earlier round and not re-listed are ghosts.
        ...(reset
          ? {
              reset,
              scopeCovered: { scope, generation },
            }
          : {}),
        costUnits: c.spent,
      };
    },

    put(_change: EventChange): Promise<CalendarWriteResult> {
      return Promise.reject(new NotImplementedError('calendar.put'));
    },

    remove(
      _ref: EventRef & { scope: 'occurrence' | 'series' | 'following'; notify?: boolean },
    ): Promise<CalendarWriteResult> {
      return Promise.reject(new NotImplementedError('calendar.remove'));
    },

    rsvp(): Promise<CalendarWriteResult> {
      return Promise.reject(new NotImplementedError('calendar.rsvp'));
    },
  };
}
