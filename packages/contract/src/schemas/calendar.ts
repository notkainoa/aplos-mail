import * as z from 'zod/mini';
import {
  bool,
  choice,
  Count,
  Email,
  EpochMs,
  Id,
  line,
  LocalDate,
  openEnum,
  text,
  TimeZone,
} from './common';
import { ReasonCodeSchema } from '../status';

/**
 * A point or day in time. All-day events use days; timed events an instant; `floating` keeps a wall-clock time with an
 * optional zone (CalDAV floating times, plan 20 PV8). Never `Date` on the wire.
 */
export const EventTime = z.discriminatedUnion('type', [
  z.object({ type: z.literal('utc'), utc: EpochMs }),
  z.object({ type: z.literal('date'), date: LocalDate }),
  z.object({ type: z.literal('floating'), local: line(40), timeZone: z.optional(TimeZone) }),
]);
export type EventTime = z.infer<typeof EventTime>;

export const RsvpResponse = openEnum(['needsAction', 'accepted', 'declined', 'tentative']);
/** Which occurrences an edit or answer touches (plan 20 `EditScope`); `following` is refused with a plain reason until built. */
export const EditScope = choice(['occurrence', 'series', 'following']);

export const Attendee = z.object({
  address: line(320),
  name: z.optional(line(200)),
  response: RsvpResponse,
  organizer: z.boolean(),
  self: z.boolean(),
  optional: z.optional(z.boolean()),
});

/**
 * One event or one occurrence of a series. Masters and overrides are stored; occurrences are expanded on the client side
 * of the engine (ADR-20). An occurrence's id is `<seriesId>@<recurrenceId>`, the recurrence id in the one canonical form (UTC `YYYYMMDDTHHMMSSZ`,
 * `YYYYMMDD` for all-day, no `Z` when floating; `RECURRENCE_ID_FORMAT` in the engine's calendar port, freeze FR-20).
 * Treat it as opaque.
 */
export const Event = z.object({
  id: Id,
  rev: Count,
  accountId: Id,
  calendarId: Id,
  seriesId: z.optional(Id),
  /** The original start of an overridden or expanded occurrence. */
  originalStart: z.optional(EventTime),
  recurring: z.boolean(),
  /** This occurrence was edited apart from its series. */
  exception: z.boolean(),
  title: text(1_000),
  start: EventTime,
  end: EventTime,
  allDay: z.boolean(),
  timeZone: z.optional(TimeZone),
  location: z.optional(text(2_000)),
  /** Plain text. */
  description: z.optional(text(20_000)),
  /** Meeting link, never rewritten by Aplos (D11). */
  conference: z.optional(z.object({ url: text(2_000), label: z.optional(line(200)) })),
  organizer: z.optional(Attendee),
  attendees: z.array(Attendee),
  myResponse: z.optional(RsvpResponse),
  status: openEnum(['confirmed', 'tentative', 'cancelled']),
  transparency: z.optional(openEnum(['opaque', 'transparent'])),
  recurrence: z.optional(z.object({ rrule: z.optional(text(2_000)), text: line(500) })),
  can: z.object({
    edit: z.boolean(),
    move: z.boolean(),
    delete: z.boolean(),
    rsvp: z.boolean(),
    editGuests: z.boolean(),
  }),
  lockedReason: z.optional(line(500)),
  /** The invitation mail this event came from ("Invite from Priya Raman"). */
  invite: z.optional(z.object({ threadId: Id, messageId: Id, fromName: z.optional(line(200)) })),
  /** The thread the event was made from (a plan). */
  threadId: z.optional(Id),
  htmlLink: z.optional(text(2_000)),
  /** Hidden in Aplos only (`Event/hide`), never at the provider; events windows leave it out unless `includeHidden`. */
  hidden: z.optional(z.boolean()),
  /** Where the latest local change stands: `localOnly` is an event not yet created at the provider, so it has no Delete (acceptance 6). */
  sync: openEnum(['localOnly', 'pending', 'synced', 'failed', 'conflict']),
});
export type Event = z.infer<typeof Event>;

/** Visibility and colour are Aplos-side: Google's calendar-list scope is read-only. */
export const Calendar = z.object({
  id: Id,
  accountId: Id,
  name: line(500),
  colorTag: z.optional(line(40)),
  primary: z.boolean(),
  readOnly: z.boolean(),
  shown: z.boolean(),
  /** Hidden in the provider's own UI (D24). */
  providerHidden: z.boolean(),
  timeZone: z.optional(TimeZone),
  status: z.optional(
    z.object({
      state: openEnum(['ok', 'paused', 'error']),
      until: z.optional(EpochMs),
      reasonCode: z.optional(ReasonCodeSchema),
    }),
  ),
});
export type Calendar = z.infer<typeof Calendar>;

/** The fields `Event/set` writes. Today's sentences: "Give the event a title.", "An event must end after it starts." */
export const EventFields = z.object({
  title: text(1_000).check(z.refine(v => v.trim().length > 0, 'Give the event a title.')),
  start: EventTime,
  end: EventTime,
  allDay: bool(),
  timeZone: z.optional(TimeZone),
  location: z.optional(text(2_000)),
  description: z.optional(text(20_000)),
  attendees: z.optional(
    z
      .array(
        z.object({ address: Email, name: z.optional(line(200)), optional: z.optional(bool()) }),
      )
      .check(z.maxLength(500)),
  ),
  threadId: z.optional(Id),
});
export type EventFields = z.infer<typeof EventFields>;

/** One calendar change per `Event/set`. Input: closed. */
export const EventChange = z.discriminatedUnion('type', [
  z.object({ type: z.literal('create'), calendarId: Id, fields: EventFields }),
  z.object({ type: z.literal('update'), id: Id, scope: EditScope, fields: z.partial(EventFields) }),
  z.object({ type: z.literal('destroy'), id: Id, scope: EditScope }),
]);
export type EventChange = z.infer<typeof EventChange>;

/** A date or meeting found in mail, waiting for the owner to confirm or dismiss it (today's `calendar.extract`). */
export const Plan = z.object({
  id: Id,
  rev: Count,
  threadId: Id,
  messageId: z.optional(Id),
  fromName: z.optional(line(200)),
  quote: z.optional(text(1_000)),
  title: text(1_000),
  start: EventTime,
  end: EventTime,
  allDay: z.boolean(),
  timeZone: z.optional(TimeZone),
  location: z.optional(text(2_000)),
  state: openEnum(['open', 'confirmed', 'dismissed']),
  eventId: z.optional(Id),
});
export type Plan = z.infer<typeof Plan>;
