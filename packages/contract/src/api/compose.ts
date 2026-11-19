import * as z from 'zod/mini';
import { area } from '../registry/define';
import {
  bool,
  choice,
  Count,
  getResult,
  GetInput,
  Id,
  Ids,
  OpId,
  Receipt,
  TimeZone,
} from '../schemas/common';
import { Draft, DraftFields, Submission, SubmissionAction } from '../schemas/compose';
import { Calendar, EventChange, EventFields, Event, Plan } from '../schemas/calendar';
import { line } from '../schemas/common';

export const draft = area('draft', {
  'Draft/get': {
    summary: 'Drafts, local and from other devices.',
    kind: 'query',
    scope: 'read',
    input: GetInput,
    output: getResult(Draft),
  },
  'Draft/set': {
    summary:
      'Create (no `id`) or save a draft, compare-and-set on `baseRevision`: `stateMismatch` "This draft changed in another window. Reopen it before editing." Refused while a send of it is live (`Draft.submissionId`). When `id` names an `incomplete` draft (written on another device, text not readable here) the reply\'s `draft.id` is a NEW local draft: use that id and its `revision` for later saves.',
    kind: 'command',
    scope: 'draft',
    input: z.object({
      opId: OpId,
      id: z.optional(Id),
      baseRevision: z.optional(Count),
      fields: DraftFields,
    }),
    output: z.object({ draft: Draft, receipt: Receipt }),
  },
  'Draft/destroy': {
    summary:
      'Discard a draft, cancelling any send of it that has not started; refused while it is sending. A draft with a live send (`Draft.submissionId`) also needs `send`, the scope that cancels a send.',
    kind: 'command',
    scope: 'draft',
    audit: true,
    scopeRule: 'originating',
    input: z.object({ opId: OpId, id: Id }),
    output: Receipt,
  },
  'Contact/suggest': {
    summary:
      'Recipient type-ahead for To, Cc and Bcc: addresses you have written to or heard from, ranked by how much (the correspondents table), matching the start of a name or address.',
    kind: 'query',
    scope: 'read',
    input: z.object({
      query: line(320),
      accountId: z.optional(Id),
      limit: z.optional(z.int().check(z.minimum(1), z.maximum(20))),
    }),
    output: z.object({
      list: z.array(
        z.object({
          address: line(320),
          name: z.optional(line(200)),
          /** Messages you sent to them, and received from them. */
          sentTo: Count,
          receivedFrom: Count,
        }),
      ),
    }),
  },
  'Draft/resolve': {
    summary:
      'Settle a draft changed on another device: keep mine, take theirs, or keep both (a copy). Refused while a send of it is live.',
    kind: 'command',
    scope: 'draft',
    input: z.object({ opId: OpId, id: Id, choice: choice(['keepMine', 'takeTheirs', 'keepBoth']) }),
    output: z.object({ draft: Draft, copyId: z.optional(Id), receipt: Receipt }),
  },
});

export const submission = area('submission', {
  'Submission/get': {
    summary: 'Sends in the outbox and their states.',
    kind: 'query',
    scope: 'read',
    input: GetInput,
    output: getResult(Submission),
  },
  'Submission/set': {
    summary:
      'Send with undo, send later, undo, send now, reschedule, send anyway after an unconfirmed send, retry a failed one, or cancel one that failed, is unconfirmed or missed its time.',
    kind: 'command',
    scope: 'send',
    audit: true,
    input: z.object({ opId: OpId, action: SubmissionAction }),
    output: z.object({ submission: Submission, receipt: Receipt }),
  },
});

export const event = area('event', {
  'Calendar/get': {
    summary: 'Calendars with Aplos-side visibility and colour.',
    kind: 'query',
    scope: 'read',
    input: z.object({ accountId: z.optional(Id) }),
    output: z.object({ list: z.array(Calendar) }),
  },
  'Calendar/set': {
    summary:
      'Show or hide a calendar in Aplos, or change its colour; never written to the provider.',
    kind: 'command',
    scope: 'triage',
    input: z.object({
      opId: OpId,
      id: Id,
      shown: z.optional(bool()),
      colorTag: z.optional(line(40)),
    }),
    output: z.object({ calendar: Calendar, receipt: Receipt }),
  },
  'Event/get': {
    summary: 'Events and occurrences by id.',
    kind: 'query',
    scope: 'read',
    input: GetInput,
    output: getResult(Event),
  },
  'Event/set': {
    summary:
      'Create, edit or delete an event, for one occurrence, the series or the following ones; may notify guests, so it is held briefly for undo.',
    kind: 'command',
    scope: 'send',
    audit: true,
    input: z.object({ opId: OpId, change: EventChange, notify: z.optional(bool()) }),
    output: z.object({ event: z.optional(Event), receipt: Receipt }),
  },
  'Event/hide': {
    summary:
      "Hide events in Aplos only (the event detail's Hide), or show them again; never written to the provider, so nobody is told.",
    kind: 'command',
    scope: 'triage',
    input: z.object({ opId: OpId, ids: Ids(200), hidden: bool() }),
    output: Receipt,
  },
  'Event/rsvp': {
    summary: 'Answer an invitation for one occurrence or the series.',
    kind: 'command',
    scope: 'send',
    audit: true,
    input: z.object({
      opId: OpId,
      id: Id,
      response: choice(['accepted', 'tentative', 'declined']),
      scope: choice(['occurrence', 'series']),
      notify: z.optional(bool()),
    }),
    output: Receipt,
  },
  'Event/extract': {
    summary:
      "Find dates and meetings in a thread with the Plans model (today's `calendar.extract`); results are Plans to confirm. `forbidden` (`ai.accountExcluded`) for an account left out of AI.",
    kind: 'command',
    scope: 'ai',
    input: z.object({ opId: OpId, threadId: Id, timeZone: z.optional(TimeZone) }),
    output: z.object({ plans: z.array(Plan), receipt: Receipt }),
  },
  'Plan/get': {
    summary: 'Plans found in mail.',
    kind: 'query',
    scope: 'read',
    input: GetInput,
    output: getResult(Plan),
  },
  'Plan/confirm': {
    summary:
      'Add a plan to a calendar, with optional edits. Never with guests, so nobody is invited: add them afterwards with `Event/set`.',
    kind: 'command',
    scope: 'triage',
    audit: true,
    input: z.object({
      opId: OpId,
      id: Id,
      calendarId: z.optional(Id),
      fields: z.optional(z.partial(z.omit(EventFields, { attendees: true }))),
    }),
    output: z.object({ eventId: Id, receipt: Receipt }),
  },
  'Plan/dismiss': {
    summary: 'Dismiss a plan.',
    kind: 'command',
    scope: 'triage',
    input: z.object({ opId: OpId, ids: Ids(200) }),
    output: Receipt,
  },
});
