import type { EventTime } from '@aplos/contract';
import type { BudgetId, SyncLane } from './base';
import type { AdapterContext, PlannedStep, PlanInput, Quarantine, SyncState } from './provider';

// The calendar half of an adapter (plan 20 PV8, PV9; ARCH 5.5). Google Calendar is the `calendar` of the google
// adapter; CalDAV is the `calendar` of an imap or jmap adapter; Graph's is the microsoft adapter's. Masters and
// overrides are stored; expansion is client-side in `packages/engine/src/calendar/recurrence` (ADR-20).

/** F1 `Event/set` scope; `following` splits the series (behind plan 20 Decision 6). */
export type EditScope = 'occurrence' | 'series' | 'following';

/**
 * The F1 wire `EventTime` itself (`utc`, `date`, or `floating` with an optional `timeZone`), so facts reach the store
 * and `Event/get` with no mapping. A zoned local time is `floating` with `timeZone`.
 */
export type { EventTime };

/** Field names as F1 `Attendee`, so `Event/get` copies it; the response stays closed on the adapter side. */
export interface Attendee {
  address: string;
  name?: string;
  response: 'needsAction' | 'accepted' | 'declined' | 'tentative';
  organizer: boolean;
  self: boolean;
  optional?: boolean;
}

export interface EventFields {
  summary: string;
  location: string;
  description: string;
  start: EventTime;
  end: EventTime;
  allDay: boolean;
  attendees: Attendee[];
}

/**
 * The canonical `recurrenceId` (`events.recurrence_id`, part of its unique key): an occurrence's ORIGINAL start, written
 * one way whatever the provider sent, so one occurrence can never get two rows.
 * - Timed, with a zone or offset (Google `originalStartTime.dateTime`, CalDAV `RECURRENCE-ID;TZID=...`, Graph
 *   `originalStart`): converted to UTC, `YYYYMMDDTHHMMSSZ`.
 * - All-day (Google `originalStartTime.date`, `RECURRENCE-ID;VALUE=DATE`): `YYYYMMDD`.
 * - Floating (no zone at all, CalDAV only): the wall-clock time, `YYYYMMDDTHHMMSS`, no `Z`.
 * Masters and single events have none (stored as ''). Google's instance id is `<recurringEventId>_<recurrenceId>`, so
 * an RSVP to one occurrence needs no extra lookup. F1's occurrence id `<seriesId>@<originalStart>` uses this same form.
 */
export const RECURRENCE_ID_FORMAT = /^\d{8}(T\d{6}Z?)?$/;

/**
 * Identity per provider: Google `remoteId` is the event id and an override's `masterRemoteId` its `recurringEventId`.
 * CalDAV `remoteId` is the resource href (the unit of ETag, `sync-collection` and delete), shared by the master and its
 * overrides, so `masterRemoteId` is absent there and the master is the row with the same href and no `recurrenceId`;
 * the iCalendar UID is `EventFacts.uid`, never `remoteId`. Graph `remoteId` is the event id and `masterRemoteId` its
 * `seriesMasterId`.
 */
export interface EventRef {
  calendarRemoteId: string;
  remoteId: string;
  /** Canonical (`RECURRENCE_ID_FORMAT`) original start of one occurrence; absent for masters and single events. */
  recurrenceId?: string;
  etag?: string;
}

/**
 * Only changed fields are sent (D11), with `If-Match`. No `remoteId` creates the event. `notify` is `Event/set`'s
 * resolved choice; absent or false never emails guests (Google `sendUpdates=none`, CalDAV `SCHEDULE-AGENT=CLIENT`,
 * Graph PATCH without a cancel or forward). `remove` carries it on its ref the same way (Graph cancel versus delete).
 */
export interface EventChange {
  calendarRemoteId: string;
  remoteId?: string;
  recurrenceId?: string;
  etag?: string;
  scope: EditScope;
  fields: Partial<EventFields>;
  notify?: boolean;
  /**
   * A create only: the exact remote id to give the new event (`calendar/event-id.ts`, derived from the op id), so a
   * re-sent create names the same event and meets "already exists" instead of duplicating. Absent: the adapter picks one.
   */
  newRemoteId?: string;
}

/** D24; `changeTag` is CalDAV's ctag, to skip unchanged collections. */
export interface CalendarFacts {
  remoteId: string;
  name: string;
  color?: string;
  primary?: boolean;
  hidden: boolean;
  selected: boolean;
  readOnly: boolean;
  timeZone?: string;
  changeTag?: string;
}

export interface EventFacts extends EventFields {
  calendarRemoteId: string;
  remoteId: string;
  etag?: string;
  /**
   * On a `put` result only: `true` when this call inserted the event, `false` when the answer is a
   * read-back of an event that already existed (a create that met the provider's "already exists").
   * Absent when the adapter cannot say. Callers that delete on the caller's behalf must never touch
   * a row flagged `false`.
   */
  inserted?: boolean;
  /**
   * Set on a Google or Graph override; stored as `events.master_remote_id` and joined on it, since an override can
   * arrive before its master. Absent on CalDAV, whose overrides share the master's `remoteId` (see `EventRef`).
   */
  masterRemoteId?: string;
  recurrenceId?: string;
  /**
   * Rows with a `recurrenceId` only. `exception`: edited or cancelled apart from its series (Google and CalDAV
   * overrides, Graph `type: exception`). `occurrence`: an unedited instance a provider returned expanded (Graph
   * `calendarView/delta` `type: occurrence`), stored only while its master is not.
   */
  instance?: 'exception' | 'occurrence';
  /** The iCalendar UID (Google `iCalUID`, CalDAV `UID`, Graph `iCalUId`), to match an invitation email to its event. */
  uid?: string;
  /** Masters only. */
  rrule?: string[];
  rdate?: string[];
  exdate?: string[];
  status: 'confirmed' | 'tentative' | 'cancelled';
  organizerIsSelf: boolean;
  canEditShared: boolean;
  /** Never rewritten by Aplos (D11). */
  conference?: { url?: string; provider?: string };
  /** Provider-original JSON or ICS text, round-tripped on write (`events.data` / `events.ics`). */
  raw: string;
}

export interface CalendarStepResult {
  /**
   * The upserts of one `remoteId` are that resource's full row set (master and overrides; a CalDAV resource shares one
   * UID): stored rows of that `remoteId` not among them are deleted.
   */
  upserts: EventFacts[];
  /** Remote ids of events gone from this calendar; removes every row of that id (master and overrides). */
  removals: string[];
  nextState: SyncState;
  done: boolean;
  /**
   * The calendar's round listed every event (a 410 resync): events with `seen_gen IS NOT NULL AND seen_gen < generation`
   * are removed, inside `bound` when set (Graph `calendarView` covers a window, epoch ms `start_utc` from inclusive, to
   * exclusive), so a deletion missed while the sync token was invalid does not stay as a ghost. Generation as `SyncState`.
   */
  scopeCovered?: {
    scope: `cal:${string}`;
    generation: number;
    bound?: { from: number; to: number };
  };
  reset?: 'syncTokenInvalid' | 'windowRolled';
  quarantine?: Quarantine[];
  costUnits: number;
}

/**
 * A write's outcome. A conflict (Google 412 `conditionNotMet`, CalDAV 412, Graph 412) is a result, not an error class:
 * the engine shows "keep mine or take theirs" with `current` when the adapter could read it, and never quarantines.
 */
export type CalendarWriteResult =
  | { kind: 'saved'; upserts: EventFacts[]; removals: string[] }
  | { kind: 'conflict'; current?: EventFacts };

/**
 * Implemented by `prov-cal` (Google Calendar in round 1; CalDAV and Graph calendar in round 2). Called by the account
 * actor (sync) and, for writes, by `methods/event.ts` through `CalendarPort` (`ports/engine.ts`). Its budget is separate from mail (D12), so
 * a calendar pause shows per calendar, never as the account's mail status.
 */
export interface CalendarAdapter {
  readonly budget: BudgetId;
  /** Pure: cadence for `calendars` and each `cal:<id>` scope (primary 2-5 min, others 15-30, list 30, jittered). */
  plan(input: PlanInput): PlannedStep[];
  listCalendars(
    state: SyncState | undefined,
    ctx: AdapterContext,
  ): Promise<{
    calendars: CalendarFacts[];
    removed: string[];
    nextState: SyncState;
    costUnits: number;
  }>;
  syncStep(
    calendarRemoteId: string,
    state: SyncState,
    lane: SyncLane,
    ctx: AdapterContext,
  ): Promise<CalendarStepResult>;
  /** An occurrence edit creates an override; `following` splits the series. Guests are emailed only when `change.notify`. */
  put(change: EventChange, ctx: AdapterContext): Promise<CalendarWriteResult>;
  remove(
    ref: EventRef & { scope: EditScope; notify?: boolean },
    ctx: AdapterContext,
  ): Promise<CalendarWriteResult>;
  /** Edits only the self attendee (Google sends the whole list; CalDAV the own PARTSTAT). */
  rsvp(
    ref: EventRef & { scope: EditScope },
    response: 'accepted' | 'declined' | 'tentative',
    opts: { notify: boolean },
    ctx: AdapterContext,
  ): Promise<CalendarWriteResult>;
}
