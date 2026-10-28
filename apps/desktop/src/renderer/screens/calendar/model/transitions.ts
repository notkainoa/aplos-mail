/** The reducer's transitions that write (move, delete, reply, save) and their shared helpers. Internal to the model. */
import { toIsoDateTime, type Event } from '../../../data';
import type { CalendarEventData, EventGuest, EventScope, IsoDateTime, RsvpAnswer } from '../../../ui/props';
import { draftChange, draftProblem, draftTimes } from './editor';
import { isoOfTime } from './period';
import { timeChange } from './times';
import { canSendReply, lockedMessage, RESPONSE } from './rsvp';
import { organizerFirstName, tagFor, walk } from './entries';
import {
  detailEntry,
  entryById,
  liveRsvp,
  railEntry,
  type CalendarContext,
  type CalendarEffect,
  type CalendarState,
  type PendingChange,
  type ScopeAsk,
  type Transition,
} from './state';

export const done = (state: CalendarState, effects: CalendarEffect[] = [], handled = true): Transition => ({
  state,
  effects,
  handled,
});

/** Close every transient surface (popover, its menu, the stack menu, the RSVP choice, a pending scope). */
export function closed(state: CalendarState): CalendarState {
  return { ...state, detailId: null, moreOpen: false, stackIds: null, rsvp: null, scope: null };
}

/** The series row behind a repeating occurrence, when the window holds it. */
export function seriesOf(event: Event, ctx: CalendarContext): Event | undefined {
  return event.seriesId ? ctx.events.get(event.seriesId) : undefined;
}

export function decideScope(
  state: CalendarState,
  entry: CalendarEventData,
  action: ScopeAsk['action'],
  pending: PendingChange,
): CalendarState {
  return { ...state, moreOpen: false, stackIds: null, scope: { action, entryId: entry.id, pending } };
}

export function failureFor(verb: 'move' | 'change' | 'delete', title: string): string {
  return `Couldn't ${verb} ${title}.`;
}

/** The change a move or resize makes, or why it can't, or the scope question first. */
export function moveTransition(
  state: CalendarState,
  ctx: CalendarContext,
  id: string,
  start: IsoDateTime,
  end: IsoDateTime,
  scope?: EventScope,
): Transition {
  const entry = entryById(ctx, id);
  const event = ctx.events.get(id);
  if (!entry || entry.kind !== 'event') return done(state, [], false);
  if (!event || !entry.persisted) return done(state, [], false);
  const calendar = ctx.calendars.find(c => c.id === event.calendarId);
  if (!event.can.move || calendar?.readOnly)
    return done(state, [{ kind: 'notice', message: lockedMessage(event, calendar) }]);
  if (event.recurring && !scope)
    return done(decideScope(state, entry, 'move', { kind: 'move', start, end }));
  const startUtc = new Date(start).getTime();
  const endUtc = new Date(end).getTime();
  const scoped = scope ?? 'occurrence';
  // Times keep the event's own type and zone; "All events" shifts the series' own times (model/times.ts).
  const target = timeChange(
    event,
    { start: { type: 'utc', utc: startUtc }, end: { type: 'utc', utc: endUtc } },
    scoped,
    seriesOf(event, ctx),
  );
  if (Object.keys(target.fields).length === 0) return done({ ...state, scope: null });
  return done({ ...state, scope: null, selectedId: id }, [
    {
      kind: 'eventSet',
      change: { type: 'update', id: target.id, scope: scoped, fields: target.fields },
      optimistic: { id, patch: { start: toIsoDateTime(startUtc), end: toIsoDateTime(endUtc) } },
      undoLabel: `Moved ${entry.title}`,
      failure: failureFor('move', entry.title),
    },
  ]);
}

export function deleteTransition(state: CalendarState, ctx: CalendarContext, scope?: EventScope): Transition {
  const id =
    state.scope?.entryId ?? state.editor?.eventId ?? state.detailId ?? state.selectedId ?? railEntry(state, ctx)?.id;
  const entry = entryById(ctx, id);
  const event = id ? ctx.events.get(id) : undefined;
  // Never on an unsaved event or a plan (acceptance 6).
  if (!entry || entry.kind !== 'event' || !entry.persisted || !event) return done(state, [], false);
  const calendar = ctx.calendars.find(c => c.id === event.calendarId);
  if (!event.can.delete || calendar?.readOnly)
    return done(state, [{ kind: 'notice', message: lockedMessage(event, calendar) }]);
  if (event.recurring && !scope) return done(decideScope({ ...state, editor: null }, entry, 'delete', { kind: 'delete' }));
  // Focus never lost: the selection moves on to the next event in time order, else the previous one.
  const rest = ctx.entries.filter(e => e.id !== entry.id);
  const next = walk(ctx.entries, entry.id, 1) ?? walk(ctx.entries, entry.id, -1);
  return done(
    { ...closed(state), editor: null, selectedId: next && rest.some(e => e.id === next) ? next : null },
    [
      {
        kind: 'eventSet',
        change: { type: 'destroy', id: entry.id, scope: scope ?? 'occurrence' },
        optimistic: { id: entry.id, remove: true },
        toast: { kind: 'trash', message: 'Event deleted', undoable: true },
        undoLabel: 'Event deleted',
        failure: failureFor('delete', entry.title),
      },
      { kind: 'focus', target: 'grid' },
    ],
  );
}

export function rsvpTransition(state: CalendarState, ctx: CalendarContext, scope?: EventScope): Transition {
  const live = liveRsvp(state, ctx);
  const entry = detailEntry(state, ctx);
  const event = entry ? ctx.events.get(entry.id) : undefined;
  if (!live || !entry || !event || !canSendReply(live, entry) || live.answer === null) return done(state, [], false);
  if (event.recurring && !scope)
    return done(decideScope(state, entry, 'reply', { kind: 'reply', answer: live.answer }));
  return sendReply(state, entry, event, live.answer, scope ?? 'occurrence');
}

export function sendReply(
  state: CalendarState,
  entry: CalendarEventData,
  event: Event,
  answer: RsvpAnswer,
  scope: EventScope,
): Transition {
  const guests = entry.guests?.map(g =>
    g.isYou ? { ...g, status: (answer === 'yes' ? 'going' : answer === 'maybe' ? 'maybe' : 'declined') as EventGuest['status'] } : g,
  );
  return done({ ...state, rsvp: null, scope: null }, [
    {
      kind: 'rsvp',
      id: entry.id,
      response: RESPONSE[answer],
      scope,
      answer,
      organizer: organizerFirstName(event),
      optimistic: { id: entry.id, patch: { myReply: answer, unanswered: false, ...(guests ? { guests } : {}) } },
      failure: `Couldn't send your reply to ${entry.title}.`,
    },
  ]);
}

export function saveEditor(state: CalendarState, ctx: CalendarContext, scope?: EventScope): Transition {
  const draft = state.scope?.pending.kind === 'edit' ? state.scope.pending.draft : state.editor;
  if (!draft) return done(state, [], false);
  const problem = draftProblem(draft);
  if (problem) return done({ ...state, editor: { ...draft, error: problem } });
  const original = draft.eventId ? ctx.events.get(draft.eventId) : undefined;
  if (draft.mode === 'edit' && original?.recurring && !scope) {
    const entry = entryById(ctx, draft.eventId);
    if (entry) return done(decideScope({ ...state, editor: null }, entry, 'change', { kind: 'edit', draft }));
  }
  const change = draftChange(draft, original, scope ?? 'occurrence', original ? seriesOf(original, ctx) : undefined);
  const next = { ...closed(state), editor: null };
  if (!change) return done(next);
  if (change.type === 'create') {
    const calendar = ctx.calendars.find(c => c.id === change.calendarId);
    const times = draftTimes(draft);
    const tempId = `new:${draft.date}:${draft.start}:${draft.title.trim()}`;
    const entry: CalendarEventData = {
      id: tempId,
      title: draft.title.trim(),
      start: isoOfTime(times.start),
      end: isoOfTime(times.end),
      ...(draft.allDay ? { allDay: true } : {}),
      calendar: calendar
        ? { id: calendar.id, name: calendar.name, color: tagFor(calendar, ctx.calendars) }
        : { id: '', name: '', color: 'dusk' },
      kind: 'event',
      persisted: false,
      isOrganizer: true,
    };
    return done({ ...next, selectedId: tempId, anchor: draft.date }, [
      {
        kind: 'eventSet',
        change,
        optimistic: { id: tempId, add: entry },
        undoLabel: `Added ${entry.title}`,
        failure: `Couldn't add ${entry.title}.`,
      },
    ]);
  }
  const entry = entryById(ctx, draft.eventId);
  const title = draft.title.trim();
  const times = draftTimes(draft);
  return done({ ...next, selectedId: draft.eventId ?? null }, [
    {
      kind: 'eventSet',
      change,
      optimistic: {
        id: draft.eventId ?? '',
        patch: { title, start: isoOfTime(times.start), end: isoOfTime(times.end) },
      },
      undoLabel: `Changed ${title}`,
      failure: failureFor('change', entry?.title ?? title),
    },
  ]);
}
