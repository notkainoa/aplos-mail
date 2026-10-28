import type { ThrottleShape } from '../gmail/errors';
import type { MeterHelpers, RetryAfterMode } from '../gmail/types';

export type AccessRole = 'freeBusyReader' | 'reader' | 'writer' | 'owner';
export type SendUpdates = 'all' | 'externalOnly' | 'none';
export type ResponseStatus = 'needsAction' | 'declined' | 'tentative' | 'accepted';

export interface EventTime {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

export interface Attendee {
  email: string;
  displayName?: string;
  organizer?: boolean;
  self?: boolean;
  resource?: boolean;
  optional?: boolean;
  responseStatus?: ResponseStatus;
  comment?: string;
  additionalGuests?: number;
}

/** Conference data attached to an event (Google Meet), as the API returns it. */
export interface ConferenceEntryPoint {
  [field: string]: unknown;
  entryPointType?: string;
  uri?: string;
  label?: string;
}

export interface ConferenceData {
  [field: string]: unknown;
  createRequest?: Record<string, unknown>;
  entryPoints?: ConferenceEntryPoint[];
  conferenceSolution?: { key?: { type?: string }; name?: string; iconUri?: string };
  conferenceId?: string;
}

/** An Events resource as the API returns it. Fields Google adds later pass through untouched. */
export interface GcalEvent {
  kind: 'calendar#event';
  etag: string;
  id: string;
  status: 'confirmed' | 'tentative' | 'cancelled';
  htmlLink: string;
  created: string;
  updated: string;
  summary?: string;
  description?: string;
  location?: string;
  colorId?: string;
  creator: { email: string; displayName?: string; self?: boolean };
  organizer: { email: string; displayName?: string; self?: boolean };
  start: EventTime;
  end: EventTime;
  endTimeUnspecified?: boolean;
  recurrence?: string[];
  recurringEventId?: string;
  originalStartTime?: EventTime;
  transparency?: 'opaque' | 'transparent';
  visibility?: 'default' | 'public' | 'private' | 'confidential';
  iCalUID: string;
  sequence: number;
  attendees?: Attendee[];
  guestsCanModify?: boolean;
  guestsCanInviteOthers?: boolean;
  guestsCanSeeOtherGuests?: boolean;
  reminders?: { useDefault: boolean; overrides?: { method: string; minutes: number }[] };
  conferenceData?: ConferenceData;
  hangoutLink?: string;
  extendedProperties?: { private?: Record<string, string>; shared?: Record<string, string> };
  eventType?: string;
  [field: string]: unknown;
}

/** A client-supplied event body: known fields keep their types, everything else passes through. */
export type Fields = Record<string, unknown> & Partial<GcalEvent>;

export interface CalendarListEntry {
  kind: 'calendar#calendarListEntry';
  etag: string;
  id: string;
  summary: string;
  summaryOverride?: string;
  description?: string;
  timeZone: string;
  colorId?: string;
  backgroundColor: string;
  foregroundColor: string;
  accessRole: AccessRole;
  selected?: boolean;
  hidden?: boolean;
  primary?: boolean;
  deleted?: boolean;
  defaultReminders: { method: string; minutes: number }[];
  conferenceProperties: { allowedConferenceSolutionTypes: string[] };
}

/** One notification the emulator would have sent. Nothing is ever delivered. */
export interface SentUpdate {
  at: number;
  calendarId: string;
  eventId: string;
  action: 'created' | 'updated' | 'cancelled' | 'rsvp';
  /** The `sendUpdates` the request carried (or 'none' when it carried none). */
  sendUpdates: SendUpdates;
  /** Who would have been notified; empty for 'none' and for edits that do not notify. */
  recipients: string[];
}

/** Live settings for the Calendar side; assigning takes effect on the next request. */
export interface GcalSettings {
  /** Requests per user in any sliding 60 s window. Default 600 (projects created from 1 May 2026). */
  requestsPerMinute: number;
  /** Whether a refused request still counts against the window. Default false. */
  chargeRefused: boolean;
  /** Which JSON error a per-minute refusal carries. Default 'rateLimitExceeded403'. */
  throttleShape: ThrottleShape;
  /** Whether per-minute refusals carry Retry-After, and in which format. Default 'none'. */
  retryAfter: RetryAfterMode;
  /** A sync token older than this is refused with 410. Default 30 days; Google does not document it. */
  syncTokenHorizonMs: number;
  /** How far past "now" an open recurring series is expanded when the request has no timeMax. Default 2 years. */
  expansionHorizonMs: number;
  /** How long anti-abuse lasts when switched on without a duration; null means until switched off. */
  abuseDurationMs: number | null;
}

export type GcalOptions = Partial<GcalSettings>;

export interface AbuseState {
  /** Clock time at which writes work again; Infinity when it only ends when switched off. */
  until: number;
}

/** A calendar to add to a user's list. Everything but `summary` has a default. */
export interface CalendarSpec {
  id?: string;
  summary: string;
  description?: string;
  timeZone?: string;
  accessRole?: AccessRole;
  primary?: boolean;
  selected?: boolean;
  hidden?: boolean;
  summaryOverride?: string;
  backgroundColor?: string;
  colorId?: string;
}

export interface CalendarPatch {
  hidden?: boolean;
  selected?: boolean;
  summaryOverride?: string | null;
  backgroundColor?: string;
  colorId?: string;
}

/** An invitation as another organizer's client would have created it in this user's calendar. */
export interface InvitationSpec {
  summary: string;
  start: EventTime;
  end: EventTime;
  organizer: { email: string; displayName?: string };
  /** Other guests besides the organizer and the user, who is added as needsAction. */
  guests?: string[];
  calendarId?: string;
  location?: string;
  description?: string;
  recurrence?: string[];
  guestsCanModify?: boolean;
  id?: string;
}

export interface ExpireOptions {
  /** Only this user (email or sub); every user when omitted. */
  user?: string;
  /** Only the sync tokens of this list kind; both when omitted. */
  kind?: 'events' | 'calendarList';
  /** Only the events tokens of this calendar. */
  calendarId?: string;
}

export interface CalendarHelpers {
  settings: GcalSettings;
  /** Requests per minute, as the Calendar side meters them (1 unit per request). */
  meter: MeterHelpers;
  /** Every notification that `sendUpdates` would have caused. */
  sentUpdates: SentUpdate[];
  /** Fills a user's calendars with synthetic data; see `generateCalendars`. */
  seed(
    options?: import('./generate').GenerateCalendarsOptions,
  ): import('./generate').GeneratedCalendars;
  /** Calendars of a user (email or sub; the first user when omitted), as the calendar list shows them. */
  listCalendars(user?: string): CalendarListEntry[];
  addCalendar(spec: CalendarSpec, user?: string): CalendarListEntry;
  /** Hide, deselect, rename or recolor an entry, as the user would in the Google Calendar UI. */
  updateCalendar(calendarId: string, patch: CalendarPatch, user?: string): CalendarListEntry;
  hideCalendar(calendarId: string, user?: string): CalendarListEntry;
  deselectCalendar(calendarId: string, user?: string): CalendarListEntry;
  /** Unsubscribes (or deletes, for an owned secondary calendar): the entry stays as `deleted: true` for sync. */
  deleteCalendar(calendarId: string, user?: string): void;
  /** Changes the calendar's own title. Read-only to API clients, so no calendar-list sync entry results. */
  renameCalendar(calendarId: string, summary: string, user?: string): void;

  /** The current JSON of an event, cancelled ones included (stripped as the API strips them). */
  getEvent(calendarId: string, eventId: string, user?: string): GcalEvent | undefined;
  /**
   * Creates an event the way a client signed in as the user would (same code as events.insert) but
   * without quota or HTTP. `organizer` makes it somebody else's event.
   */
  addEvent(
    calendarId: string,
    body: Record<string, unknown>,
    options?: { user?: string; sendUpdates?: SendUpdates; conferenceDataVersion?: 0 | 1 },
  ): GcalEvent;
  /** An invitation from somebody else, with the user as a needsAction attendee. */
  addInvitation(spec: InvitationSpec, user?: string): GcalEvent;
  /** Another client's edit of an event (events.patch semantics, no quota). */
  editEvent(
    calendarId: string,
    eventId: string,
    patch: Record<string, unknown>,
    options?: { user?: string; conferenceDataVersion?: 0 | 1 },
  ): GcalEvent;
  /** Another client's delete. */
  removeEvent(calendarId: string, eventId: string, user?: string): void;
  /** An attendee other than the user answers an invitation; the organizer's copy changes. */
  respond(
    calendarId: string,
    eventId: string,
    email: string,
    responseStatus: ResponseStatus,
    user?: string,
  ): GcalEvent;

  /** Makes sync tokens invalid so the next incremental call answers 410 fullSyncRequired. */
  expireSyncTokens(options?: ExpireOptions): void;
  /** Writes answer 403 quotaExceeded until switched off, or for `forMs` of clock time. */
  setAbuse(on: boolean, options?: { forMs?: number }): void;
  abuse(): AbuseState | null;
}
