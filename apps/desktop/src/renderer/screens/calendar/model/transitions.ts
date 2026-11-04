/** The reducer's transitions that write (move, delete, reply, save) and their shared helpers. Internal to the model. */
import type { EventChange } from '@aplos/contract';
import { toIsoDateTime, type Event } from '../../../data';
import type {
  CalendarEventData,
  EventGuest,
  EventScope,
  IsoDateTime,
  RsvpAnswer,
} from '../../../ui/props';
import { draftChange, draftProblem, draftTimes, timesTouched, type EditorDraft } from './editor';
import { isoOfTime } from './period';
import { timeChange } from './times';
import { canSendReply, lockedMessage, RESPONSE } from './rsvp';
import { organizerFirstName, tagFor, walk } from './entries';
import {
  detailEntry,
  entryById,
  liveRsvp,
  seriesAloneLine,
  type CalendarContext,
  type CalendarEffect,
  type CalendarState,
  type PendingChange,
  type ScopeAsk,
  type Transition,
} from './state';

export const done = (
  state: CalendarState,
  effects: CalendarEffect[] = [],
  handled = true,
): Transition => ({
  state,
  effects,
  handled,
});

/** Cancelling the scope question returns to the editor with the draft it stashed, edits intact (review1 6). */
export function cancelScope(state: CalendarState): Transition {
  const p = state.scope?.pending;
  const draft = p?.kind === 'edit' || p?.kind === 'delete' ? p.draft : undefined;
  return done({ ...state, scope: null, ...(draft ? { editor: draft } : {}) });
}

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
  opts: { readonly seriesAlone?: boolean } = {},
): CalendarState {
  return {
    ...state,
    moreOpen: false,
    stackIds: null,
    scope: {
      action,
      entryId: entry.id,
      pending,
      ...(opts.seriesAlone ? { seriesAlone: true } : {}),
    },
  };
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
    return done(
      decideScope(
        state,
        entry,
        'move',
        { kind: 'move', start, end },
        {
          seriesAlone: event.seriesId !== undefined && seriesOf(event, ctx) === undefined,
        },
      ),
    );
  const startUtc = new Date(start).getTime();
  const endUtc = new Date(end).getTime();
  const scoped = scope ?? 'occurrence';
  const series = seriesOf(event, ctx);
  // "All events" on a time move needs the series row to shift it by the delta; without it there is no safe write
  // (model/times.ts), so the chooser never offers it and a stale choice answers with why instead.
  if (scoped === 'series' && event.seriesId && !series)
    return done({ ...state, scope: null }, [{ kind: 'notice', message: seriesAloneLine('move') }]);
  // Times keep the event's own type and zone; "All events" shifts the series' own times (model/times.ts).
  const target = timeChange(
    event,
    { start: { type: 'utc', utc: startUtc }, end: { type: 'utc', utc: endUtc } },
    scoped,
    series,
  );
  if (Object.keys(target.fields).length === 0) return done({ ...state, scope: null });
  return done({ ...state, scope: null, selectedId: id }, [
    {
      kind: 'eventSet',
      change: { type: 'update', id: target.id, scope: scoped, fields: target.fields },
      optimistic: { id, patch: { start: toIsoDateTime(startUtc), end: toIsoDateTime(endUtc) } },
      toast: {
        kind: 'info',
        message: `Moved ${entry.title}`,
        held: `Moving ${entry.title}`,
        undoable: true,
      },
      undoLabel: `Moved ${entry.title}`,
      failure: failureFor('move', entry.title),
    },
  ]);
}

export function deleteTransition(
  state: CalendarState,
  ctx: CalendarContext,
  scope?: EventScope,
): Transition {
  // Explicit targets only: the day rail's passive first entry is never one (review2 1).
  const id = state.scope?.entryId ?? state.editor?.eventId ?? state.detailId ?? state.selectedId;
  const entry = entryById(ctx, id);
  const event = id ? ctx.events.get(id) : undefined;
  // Never on an unsaved event or a plan (acceptance 6).
  if (!entry || entry.kind !== 'event' || !entry.persisted || !event) return done(state, [], false);
  const calendar = ctx.calendars.find(c => c.id === event.calendarId);
  if (!event.can.delete || calendar?.readOnly)
    return done(state, [{ kind: 'notice', message: lockedMessage(event, calendar) }]);
  if (event.recurring && !scope)
    return done(
      decideScope({ ...state, editor: null }, entry, 'delete', {
        kind: 'delete',
        ...(state.editor ? { draft: state.editor } : {}),
      }),
    );
  // Focus never lost: the selection moves on to the next event in time order, else the previous one.
  const rest = ctx.entries.filter(e => e.id !== entry.id);
  const next = walk(ctx.entries, entry.id, 1) ?? walk(ctx.entries, entry.id, -1);
  return done(
    {
      ...closed(state),
      editor: null,
      selectedId: next && rest.some(e => e.id === next) ? next : null,
    },
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

export function rsvpTransition(
  state: CalendarState,
  ctx: CalendarContext,
  scope?: EventScope,
): Transition {
  const live = liveRsvp(state, ctx);
  const entry = detailEntry(state, ctx);
  const event = entry ? ctx.events.get(entry.id) : undefined;
  if (!live || !entry || !event || !canSendReply(live, entry) || live.answer === null)
    return done(state, [], false);
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
    g.isYou
      ? {
          ...g,
          status: (answer === 'yes'
            ? 'going'
            : answer === 'maybe'
              ? 'maybe'
              : 'declined') as EventGuest['status'],
        }
      : g,
  );
  return done({ ...state, rsvp: null, scope: null }, [
    {
      kind: 'rsvp',
      id: entry.id,
      response: RESPONSE[answer],
      scope,
      answer,
      organizer: organizerFirstName(event),
      optimistic: {
        id: entry.id,
        patch: { myReply: answer, unanswered: false, ...(guests ? { guests } : {}) },
      },
      failure: `Couldn't send your reply to ${entry.title}.`,
    },
  ]);
}

/** The scope ask a save on a repeating event opens, or null when the entry is gone. */
function askEditScope(
  state: CalendarState,
  ctx: CalendarContext,
  draft: EditorDraft,
  original: Event,
): Transition | null {
  const entry = entryById(ctx, draft.eventId);
  if (!entry) return null;
  return done(
    decideScope(
      { ...state, editor: null },
      entry,
      'change',
      { kind: 'edit', draft },
      {
        // "All events" stays for a title-or-place edit; only a time change needs the series row (review1 1).
        seriesAlone:
          original.seriesId !== undefined &&
          seriesOf(original, ctx) === undefined &&
          timesTouched(draft, original),
      },
    ),
  );
}

/** Pending creates get distinct temp ids even with identical fields, or the second would replace the first (review1 10). */
let nextTempSeq = 0;

/** A new event's optimistic entry and its create write: the temp id stands in until the receipt lands. */
function createSave(
  state: CalendarState,
  ctx: CalendarContext,
  draft: EditorDraft,
  change: Extract<EventChange, { type: 'create' }>,
): Transition {
  const calendar = ctx.calendars.find(c => c.id === change.calendarId);
  const times = draftTimes(draft);
  const tempId = `new:${++nextTempSeq}:${draft.date}:${draft.start}:${draft.title.trim()}`;
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
  return done({ ...state, selectedId: tempId, anchor: draft.date }, [
    {
      kind: 'eventSet',
      change,
      optimistic: { id: tempId, add: entry },
      toast: {
        kind: 'info',
        message: `Added ${entry.title}`,
        held: `Adding ${entry.title}`,
        undoable: true,
      },
      undoLabel: `Added ${entry.title}`,
      failure: `Couldn't add ${entry.title}.`,
    },
  ]);
}

/** The event being edited left the window while the dialog was open: close with why, no write (review2 2). */
function saveGone(state: CalendarState): Transition {
  return done({ ...closed(state), editor: null }, [
    { kind: 'notice', message: 'That event changed or was removed. Nothing was saved.' },
  ]);
}

export function saveEditor(
  state: CalendarState,
  ctx: CalendarContext,
  scope?: EventScope,
): Transition {
  const draft = state.scope?.pending.kind === 'edit' ? state.scope.pending.draft : state.editor;
  if (!draft) return done(state, [], false);
  const problem = draftProblem(draft);
  if (problem) return done({ ...state, editor: { ...draft, error: problem } });
  const original = draft.eventId ? ctx.events.get(draft.eventId) : undefined;
  if (draft.mode === 'edit' && !original) return saveGone(state);
  if (original?.recurring && !scope) {
    const ask = askEditScope(state, ctx, draft, original);
    if (ask) return ask;
  }
  const scoped = scope ?? 'occurrence';
  const series = original ? seriesOf(original, ctx) : undefined;
  if (scoped === 'series' && original?.seriesId && !series && timesTouched(draft, original))
    return done({ ...closed(state), editor: null }, [
      { kind: 'notice', message: seriesAloneLine('change') },
    ]);
  const change = draftChange(draft, original, scoped, series);
  const next = { ...closed(state), editor: null };
  if (!change) return done(next);
  if (change.type === 'create') return createSave(next, ctx, draft, change);
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
      toast: {
        kind: 'info',
        message: `Changed ${title}`,
        held: `Changing ${title}`,
        undoable: true,
      },
      undoLabel: `Changed ${title}`,
      failure: failureFor('change', entry?.title ?? title),
    },
  ]);
}
