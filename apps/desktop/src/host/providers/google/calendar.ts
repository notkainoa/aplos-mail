import { ProviderError } from '@aplos/engine/ports';
import type {
  AdapterContext,
  Attendee,
  CalendarAdapter,
  CalendarFacts,
  CalendarStepResult,
  EventFacts,
  EventTime,
  PlanInput,
  PlannedStep,
  ScopeId,
  SyncLane,
  SyncState,
} from '@aplos/engine/ports';
import { RECURRENCE_ID_FORMAT } from '@aplos/engine/ports';
import { createCalendarWrites, type CalendarWriteDeps } from './calendar-write';
import { GcalClient } from './gcal-client';

/**
 * The `calendar` of the Google adapter (prov-cal, ports.walk.md "Google Calendar (round 1)"): `calendarList` for the
 * list, `events.list` `singleEvents=false` with per-calendar sync tokens on the `gcal` budget. Masters and overrides
 * are returned as facts (`recurrenceId` canonical, `masterRemoteId` the `recurringEventId`, `raw` the provider JSON);
 * expansion is client-side. Writes (`put`, `remove`, `rsvp`) live in `calendar-write.ts`.
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
/** Mid-round pages wait a beat so a due mail step interleaves instead of queueing behind a backfill. */
const RESUME_MS = 1_500;

/** Deterministic jitter in [0,1) from the scope's remote id (keeps calendars off one beat). */
function jitter(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return (h >>> 0) / 0x1_0000_0000;
}

const LIST_FIELDS =
  'kind,etag,nextPageToken,nextSyncToken,' +
  'items(id,etag,summary,summaryOverride,timeZone,colorId,accessRole,selected,hidden,primary,deleted)';
/** One event's fields: the mask of a single-event read or write, and what a list nests under `items(...)`. */
const EVENT_ITEM_FIELDS =
  'id,etag,iCalUID,status,htmlLink,summary,description,location,colorId,' +
  'creator,organizer,start,end,recurrence,recurringEventId,originalStartTime,transparency,visibility,' +
  'attendees,guestsCanModify,conferenceData,hangoutLink,updated';
const EVENT_FIELDS = `kind,etag,nextPageToken,nextSyncToken,items(${EVENT_ITEM_FIELDS})`;

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

/**
 * A `cal.sync` provider_memory entry: every calendar the last full-or-delta list saw, with `sync` set on the
 * ones to sync (selected and not hidden). Remembering all ids is how a resync can tell "no longer listed"
 * from "never was": `removed` comes from the difference.
 */
interface SyncCalendar {
  id: string;
  primary?: boolean;
  sync?: boolean;
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

/** The instant a zone's wall clock reads `local` (single-pass; transition edges are a round-2 care). */
function zonedToUtc(local: string, tz: string): number | undefined {
  try {
    const wall = Date.parse(`${local}Z`);
    if (Number.isNaN(wall)) return undefined;
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const parts = Object.fromEntries(dtf.formatToParts(new Date(wall)).map(p => [p.type, p.value]));
    const shown = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    );
    return wall - (shown - wall);
  } catch {
    return undefined;
  }
}

const utcKey = (utc: number): string => {
  const d = new Date(utc);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
};

/**
 * The canonical `recurrenceId` (ports/calendar.ts RECURRENCE_ID_FORMAT): a timed original start to UTC
 * `YYYYMMDDTHHMMSSZ`, an all-day one `YYYYMMDD`, a floating one the wall clock `YYYYMMDDTHHMMSS`.
 * An offset-less `dateTime` carrying `timeZone` is a zoned instant — the same `…Z` key Google embeds.
 */
function canonicalRecurrenceId(v: ApiDateTime | undefined): string | undefined {
  if (!v) return undefined;
  if (v.date) return v.date.slice(0, 10).replace(/-/g, '');
  const at = v.dateTime;
  if (!at) return undefined;
  if (HAS_OFFSET.test(at)) {
    const utc = Date.parse(at);
    return Number.isNaN(utc) ? undefined : utcKey(utc);
  }
  if (v.timeZone) {
    const utc = zonedToUtc(at.slice(0, 19), v.timeZone);
    if (utc !== undefined) return utcKey(utc);
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

/**
 * A canonical id only counts when its date is real too — `2026-02-30`, `2026-1-5` and year +275760 all
 * leave Google's hands occasionally and any one of them would fail the store's FR-20 check and wedge the
 * whole calendar's commit. Dropping the one bad event keeps the rest of the page.
 */
function validRecurrenceId(id: string | undefined): id is string {
  if (id === undefined || !RECURRENCE_ID_FORMAT.test(id)) return false;
  const y = Number(id.slice(0, 4));
  const mo = Number(id.slice(4, 6));
  const d = Number(id.slice(6, 8));
  const u = new Date(Date.UTC(y, mo - 1, d));
  if (u.getUTCFullYear() !== y || u.getUTCMonth() !== mo - 1 || u.getUTCDate() !== d) return false;
  if (id.length === 8) return true;
  return (
    Number(id.slice(9, 11)) < 24 && Number(id.slice(11, 13)) < 60 && Number(id.slice(13, 15)) < 60
  );
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
  // An override's id IS its original start: if it cannot be canonicalised to a real date, emitting it
  // would throw on commit and retry the same poisoned page forever — drop the event instead.
  if (override && !validRecurrenceId(recurrenceId)) return undefined;
  const status =
    e.status === 'cancelled' ? 'cancelled' : e.status === 'tentative' ? 'tentative' : 'confirmed';
  const epoch = { type: 'utc', utc: 0 } as const;
  // A cancelled row can arrive with nothing but id/status/recurring ids; an override's tombstone still
  // names its original start, which is the occurrence it cancels — use it before the epoch fallback.
  const start = eventTime(e.start) ?? eventTime(e.originalStartTime) ?? epoch;
  const end = eventTime(e.end) ?? start;
  const conf = conference(e);
  return {
    calendarRemoteId,
    remoteId: e.id,
    ...(e.etag ? { etag: e.etag } : {}),
    summary: e.summary ?? '',
    location: e.location ?? '',
    description: e.description ?? '',
    start,
    end,
    allDay: start.type === 'date',
    attendees: (e.attendees ?? []).map(attendee),
    ...(override ? { masterRemoteId: e.recurringEventId } : {}),
    ...(override && recurrenceId ? { recurrenceId, instance: 'exception' as const } : {}),
    ...(e.iCalUID ? { uid: e.iCalUID } : {}),
    ...(!override ? recurrenceOf(e.recurrence) : {}),
    status,
    organizerIsSelf: e.organizer?.self === true || e.creator?.self === true,
    canEditShared: e.guestsCanModify === true,
    ...(conf ? { conference: conf } : {}),
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
    // Google omits `selected` when it is false (default False): only an explicit true counts.
    selected: e.selected === true,
    readOnly: role !== 'owner' && role !== 'writer',
    ...(e.timeZone ? { timeZone: e.timeZone } : {}),
    ...(e.etag ? { changeTag: e.etag } : {}),
  };
}

// ---------- the adapter ----------

export function createGoogleCalendar(deps: CalendarWriteDeps): CalendarAdapter {
  const client = (ctx: AdapterContext) => new GcalClient(deps, ctx);

  /** Parse the `cal.sync` memory: every remembered calendar entry (syncable or not). */
  const syncCalendarsFrom = (memory: ReadonlyMap<string, string>): SyncCalendar[] => {
    try {
      const parsed: unknown = JSON.parse(memory.get('cal.sync') ?? '[]');
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

  /** The calendars the last list marked for sync (`sync === true`). */
  const syncCalendars = (input: PlanInput): SyncCalendar[] =>
    syncCalendarsFrom(input.memory).filter(c => c.sync === true);

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
        const wait = cal.primary
          ? PRIMARY_MIN_MS + jitter(cal.id) * PRIMARY_SPAN_MS
          : OTHER_MIN_MS + jitter(cal.id) * OTHER_SPAN_MS;
        steps.push({
          scope,
          // Always incremental: the first sync is page-limited, and 'backfill' would mean secondary
          // devices (a second Mac) never fetch any events.
          lane: 'incremental',
          origin: 'incremental',
          trigger: input.trigger,
          // A saved pageToken resumes after a short gap so mail work due now runs first; a quiet
          // calendar polls on its cadence.
          notBefore:
            state?.pageToken !== undefined
              ? input.env.now + RESUME_MS
              : state
                ? state.updatedAt + wait
                : input.env.now,
        });
      }
      return steps;
    },

    async listCalendars(state: SyncState | undefined, ctx: AdapterContext) {
      const c = client(ctx);
      let syncToken = state?.cursor;
      let pageToken = state?.pageToken;
      const calendars: CalendarFacts[] = [];
      const removed: string[] = [];
      // `full` once the listing has asked for everything: the first list and a 410 resync both return
      // every calendar, so the ones absent afterwards are gone — an incremental delta says nothing.
      let full = syncToken === undefined;
      let nextSyncToken: string | undefined;
      for (;;) {
        let res: ApiListResponse<ApiCalendarListEntry>;
        try {
          res = await c.call<ApiListResponse<ApiCalendarListEntry>>({
            method: 'gcal.calendarList.list',
            path: '/users/me/calendarList',
            query: {
              maxResults: PAGE,
              showHidden: true,
              showDeleted: true,
              ...(syncToken ? { syncToken } : {}),
              ...(pageToken ? { pageToken } : {}),
            },
            fields: LIST_FIELDS,
            lane: 'incremental',
          });
        } catch (error) {
          // A 410 is a resync: drop the dead token and list everything, same rule as events (ports.walk.md).
          const fullSync =
            !pageToken &&
            syncToken !== undefined &&
            error instanceof ProviderError &&
            error.error.status === 410;
          if (!fullSync) throw error;
          pageToken = undefined;
          syncToken = undefined;
          full = true;
          continue;
        }
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
      if (full) {
        // The `cal.sync` memory remembers every listed id: anything absent from this full list is gone.
        const listed = new Set(calendars.map(e => e.remoteId));
        for (const prev of syncCalendarsFrom(ctx.memory)) {
          if (!listed.has(prev.id) && !removed.includes(prev.id)) removed.push(prev.id);
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

      // One request per step: a 20k-event backfill spans many turns instead of holding the account
      // loop, committed pages survive a later failure, and a quit mid-round resumes from pageToken.
      // A 410 clears the round, at most once per step — a 410 on a token-less resync request fails.
      let res: ApiListResponse<ApiEvent>;
      for (;;) {
        try {
          res = await page({
            showDeleted: true,
            // A continuation page carries both: the syncToken keeps the delta's context on real
            // Google (the pageToken alone has none).
            ...(syncToken ? { syncToken } : {}),
            ...(pageToken ? { pageToken } : {}),
          });
          break;
        } catch (error) {
          // A 410 is a resync of this calendar alone, whenever it lands: drop both tokens and the
          // pages fetched so far (stale pages would double rows), and list everything (ports.walk.md).
          // Google also answers a saved-but-dead pageToken with 400, not 410 — same recovery, or the
          // calendar would stall on the token forever.
          const dead =
            error instanceof ProviderError &&
            (error.error.status === 410 || (error.error.status === 400 && pageToken !== undefined));
          if (!dead || reset !== undefined) throw error;
          upserts.length = 0;
          pageToken = undefined;
          syncToken = undefined;
          reset = 'syncTokenInvalid';
        }
      }
      const dropped: string[] = [];
      for (const e of res.items ?? []) {
        const facts = eventFacts(calendarRemoteId, e);
        if (facts) upserts.push(facts);
        else if (typeof e.id === 'string') dropped.push(e.id);
      }
      if (dropped.length > 0)
        ctx.log.event('sync.gcal.items_dropped', {
          count: dropped.length,
          ids: dropped.join(' '),
        });
      const last = res.nextPageToken === undefined;
      if (last) nextSyncToken = res.nextSyncToken;

      // A round with no sync token (the first sync, or a 410 resync) listed every event, so only its
      // last page covers the scope: rows stamped by an earlier round and not re-listed are ghosts.
      const full = syncToken === undefined;
      // A round that starts now (first sync or a 410 resync) stamps the current fence; mid-round
      // steps keep the generation their round opened with, so the sweep compares like with like.
      const generation = state.generation === 0 || reset ? ctx.generation : state.generation;
      const nextState: SyncState = {
        scope,
        generation,
        updatedAt: ctx.clock.now(),
        ...(last
          ? nextSyncToken
            ? { cursor: nextSyncToken }
            : {}
          : { ...(syncToken ? { cursor: syncToken } : {}), pageToken: res.nextPageToken }),
      };
      return {
        upserts,
        removals: [],
        nextState,
        done: last,
        ...(reset ? { reset } : {}),
        ...(last && full ? { scopeCovered: { scope, generation } } : {}),
        costUnits: c.spent,
      };
    },

    ...createCalendarWrites(deps, { fields: EVENT_ITEM_FIELDS, facts: eventFacts }),
  };
}
