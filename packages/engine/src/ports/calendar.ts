import type { BudgetId, SyncLane } from './base';
import type { AdapterContext, PlannedStep, PlanInput, Quarantine, SyncState } from './provider';

// The calendar half of an adapter (plan 20 PV8, PV9; ARCH 5.5). Google Calendar is the `calendar` of the google
// adapter; CalDAV is the `calendar` of an imap or jmap adapter; Graph's is the microsoft adapter's. Masters and
// overrides are stored; expansion is client-side in `packages/engine/src/calendar/recurrence` (ADR-20).

/** F1 `Event/set` scope; `following` splits the series (behind plan 20 Decision 6). */
export type EditScope = 'occurrence' | 'series' | 'following';

/** An instant, an all-day date, or a floating or zoned local time. */
export type EventTime =
  | { kind: 'instant'; utc: number }
  | { kind: 'date'; date: string }
  | { kind: 'local'; local: string; tzid?: string };

export interface Attendee {
  email: string;
  name?: string;
  response: 'needsAction' | 'accepted' | 'declined' | 'tentative';
  organizer: boolean;
  self: boolean;
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

export interface EventRef {
  calendarRemoteId: string;
  remoteId: string;
  /** The ORIGINAL start of an overridden or cancelled occurrence (`events.recurrence_id`); absent for masters and single events. */
  recurrenceId?: string;
  etag?: string;
}

/** Only changed fields are sent (D11), with `If-Match`. No `remoteId` creates the event. */
export interface EventChange {
  calendarRemoteId: string;
  remoteId?: string;
  recurrenceId?: string;
  etag?: string;
  scope: EditScope;
  fields: Partial<EventFields>;
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
  /** Set on an override; resolved to `events.master_id` lazily, since an override can arrive before its master. */
  masterRemoteId?: string;
  recurrenceId?: string;
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
  upserts: EventFacts[];
  /** Remote ids of events gone from this calendar. */
  removals: string[];
  nextState: SyncState;
  done: boolean;
  scopeCovered?: { scope: `cal:${string}`; generation: number };
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
 * actor (sync) and, for writes, by `methods/event.ts` through the actor host. Its budget is separate from mail (D12), so
 * a calendar pause shows per calendar, never as the account's mail status.
 */
export interface CalendarAdapter {
  readonly budget: BudgetId;
  /** Pure: cadence for `calendars` and each `cal:<id>` scope (primary 2-5 min, others 15-30, list 30, jittered). */
  plan(input: PlanInput): PlannedStep[];
  listCalendars(state: SyncState | undefined, ctx: AdapterContext): Promise<{ calendars: CalendarFacts[]; removed: string[]; nextState: SyncState; costUnits: number }>;
  syncStep(calendarRemoteId: string, state: SyncState, lane: SyncLane, ctx: AdapterContext): Promise<CalendarStepResult>;
  /** An occurrence edit creates an override; `following` splits the series. */
  put(change: EventChange, ctx: AdapterContext): Promise<CalendarWriteResult>;
  remove(ref: EventRef & { scope: EditScope }, ctx: AdapterContext): Promise<CalendarWriteResult>;
  /** Edits only the self attendee (Google sends the whole list; CalDAV the own PARTSTAT). */
  rsvp(ref: EventRef & { scope: EditScope }, response: 'accepted' | 'declined' | 'tentative', opts: { notify: boolean }, ctx: AdapterContext): Promise<CalendarWriteResult>;
}
