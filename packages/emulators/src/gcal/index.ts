/**
 * Google Calendar v3 emulator, served by the same instance and the same `fetch` as the Gmail
 * emulator (`createGmailEmulator(...).calendar`). Shares its OAuth server, test users, clock, fault
 * hook and request log (service 'gcal'); keeps its own per-user budget (600 requests a minute).
 *
 * What is modelled: calendarList (list, get, sync), events (list, get, insert, update, patch,
 * delete, instances), sync tokens, recurrence expansion with DST, overrides and cancelled
 * instances, organizer rules, etags and If-Match, conferenceDataVersion, sendUpdates recording,
 * the anti-abuse switch. What is not: free/busy, ACLs, watch channels, events.import/move/quickAdd,
 * attachments upload, `maxAttendees`, `timeZone`/`alwaysIncludeEmail` query parameters (ignored),
 * "this and following" edits, and the batch endpoint. See rrule.ts for the recurrence limits.
 */
export { CalendarHub } from './hub';
export {
  generateCalendars,
  type GenerateCalendarsOptions,
  type GeneratedCalendars,
} from './generate';
export { CALENDAR_ROUTES, CAL_SCOPES_FOR, matchCalendarRoute } from './routes';
export {
  RecurrenceError,
  occurrences,
  validateRecurrence,
  type Occurrence,
  type Series,
} from './rrule';
export { isoInZone, localToUtc, localParts } from './tz';
export type {
  AbuseState,
  AccessRole,
  Attendee,
  CalendarHelpers,
  CalendarListEntry,
  CalendarPatch,
  CalendarSpec,
  EventTime,
  ExpireOptions,
  GcalEvent,
  GcalOptions,
  GcalSettings,
  InvitationSpec,
  ResponseStatus,
  SendUpdates,
  SentUpdate,
} from './types';
