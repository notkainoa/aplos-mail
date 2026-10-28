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
      'Create (no `id`) or save a draft, compare-and-set on `baseRevision`: `stateMismatch` "This draft changed in another window. Reopen it before editing."',
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
    summary: 'Discard a draft; refused while it is sending.',
    kind: 'command',
    scope: 'draft',
    audit: true,
    input: z.object({ opId: OpId, id: Id }),
    output: Receipt,
  },
  'Draft/resolve': {
    summary:
      'Settle a draft changed on another device: keep mine, take theirs, or keep both (a copy).',
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
      'Send with undo, send later, undo, send now, reschedule, send anyway after an unconfirmed send, or retry a failed one.',
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
      "Find dates and meetings in a thread with the Plans model (today's `calendar.extract`); results are Plans to confirm.",
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
    summary: 'Add a plan to a calendar, with optional edits.',
    kind: 'command',
    scope: 'triage',
    input: z.object({
      opId: OpId,
      id: Id,
      calendarId: z.optional(Id),
      fields: z.optional(z.partial(EventFields)),
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
