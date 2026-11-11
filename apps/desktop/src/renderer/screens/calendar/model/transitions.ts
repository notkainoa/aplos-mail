/** The reducer's transitions that write (move, delete, reply, save) and their shared helpers. Internal to the model. */
import type { EventChange, EventFields } from '@aplos/contract';
import { toIsoDateTime, type Event } from '../../../data';
import type {
  CalendarEventData,
  EventGuest,
  EventScope,
  IsoDateTime,
  RsvpAnswer,
} from '../../../ui/props';
import { editingOff } from '../accountCalendarState';
import { draftChange, draftProblem, draftTimes, type EditorDraft } from './editor';
import { isoOfTime } from './period';
import { shiftInZone, timeChange, wallDeltaMs } from './times';
import { canSendReply, lockedMessage, RESPONSE } from './rsvp';
import { organizerFirstName, tagFor, walk } from './entries';
import {
  detailEntry,
  entryById,
  liveRsvp,
  type CalendarContext,
  type CalendarEffect,
  type CalendarState,
  type OptimisticChange,
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

/**
 * True when the change would email other guests — the engine only holds (and only then gives an
 * undo window) a write that tells them. An event with attendees other than the owner, a create
 * carrying attendees, or a delete of an event with guests; an update's new guest list counts too
 * (guests added get invites, guests removed get cancellations). Guest-less writes go at once.
 */
export function notifiesGuests(change: EventChange, original?: Event): boolean {
  if (change.type === 'create') return (change.fields.attendees?.length ?? 0) > 0;
  const before = original?.attendees.some(a => !a.self) ?? false;
  const after =
    change.type === 'update' && change.fields.attendees !== undefined
      ? change.fields.attendees.length > 0
      : before;
  return before || after;
}

/** Cancelling the scope question returns to the editor with the draft it stashed, edits intact (review1 6). */
export function cancelScope(state: CalendarState): Transition {
  const p = state.scope?.pending;
  const draft = p?.kind === 'edit' || p?.kind === 'delete' ? p.draft : undefined;
  return done({ ...state, scope: null, ...(draft ? { editor: draft } : {}) });
}

/**
 * Close every transient surface (popover, its menu, the stack menu, the RSVP choice, a pending
 * scope, the failed-holds Review popover): two `role="dialog"` surfaces must never stack — a
 * Review popover open under an editor or an event detail would take no Escape of its own.
 */
export function closed(state: CalendarState): CalendarState {
  return {
    ...state,
    detailId: null,
    moreOpen: false,
    stackIds: null,
    rsvp: null,
    scope: null,
    holdsReview: false,
  };
}

export function decideScope(
  state: CalendarState,
  entry: CalendarEventData,
  action: ScopeAsk['action'],
  pending: PendingChange,
): CalendarState {
  return {
    ...state,
    moreOpen: false,
    stackIds: null,
    scope: {
      action,
      entryId: entry.id,
      pending,
    },
  };
}

export function failureFor(verb: 'move' | 'change' | 'delete', title: string): string {
  return `Couldn't ${verb} ${title}.`;
}

/**
 * The `more` overlay for scope `series`: every loaded row of the same series patched the way the engine's rule
 * (DECISIONS 2026-11-04, engine #290) writes it — `start`/`end` moved by the dragged occurrence's wall-clock
 * delta in the series' zone (model/times.ts), so a 10:00 standup stays 10:00 local across a DST change, and the
 * changed text fields copied to every row. The engine's own write lands the same change, so the settled window
 * agrees with what this showed.
 */
function seriesShift(
  ctx: CalendarContext,
  event: Event,
  fields: Partial<EventFields>,
  zone = event.timeZone,
): readonly OptimisticChange[] {
  // The shift runs in the zone the written times carry — the series zone the engine moves them in —
  // so what the overlay shows is what the write will do.
  const shiftZone =
    (fields.start?.type === 'floating' ? fields.start.timeZone : undefined) ??
    (fields.end?.type === 'floating' ? fields.end.timeZone : undefined) ??
    zone;
  const dStart = fields.start ? wallDeltaMs(event.start, fields.start, shiftZone) : 0;
  const dEnd = fields.end ? wallDeltaMs(event.end, fields.end, shiftZone) : 0;
  // The series key is the dragged row's `seriesId` — or its own id when the master itself is dragged, so its
  // occurrences (whose `seriesId` names it) shift too.
  const key = event.seriesId ?? event.id;
  const out: OptimisticChange[] = [];
  for (const e of ctx.events.values()) {
    if (e.id === event.id || (e.seriesId ?? e.id) !== key) continue;
    const patch: Partial<CalendarEventData> = {};
    if (fields.title !== undefined) patch.title = fields.title;
    if (fields.allDay !== undefined) patch.allDay = fields.allDay;
    if (dStart) patch.start = isoOfTime(shiftInZone(e.start, dStart, shiftZone));
    if (dEnd) patch.end = isoOfTime(shiftInZone(e.end, dEnd, shiftZone));
    if (Object.keys(patch).length > 0) out.push({ id: e.id, patch });
  }
  return out;
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
  // The grant lacks the write scope: the attempt gets the calm notice, not a doomed write (shape 3).
  if (editingOff(ctx.accounts, event.accountId))
    return done(state, [{ kind: 'editingNotice', accountId: event.accountId }]);
  if (event.recurring && !scope)
    return done(decideScope(state, entry, 'move', { kind: 'move', start, end }));
  const startUtc = new Date(start).getTime();
  const endUtc = new Date(end).getTime();
  const scoped = scope ?? 'occurrence';
  const next = {
    start: { type: 'utc', utc: startUtc },
    end: { type: 'utc', utc: endUtc },
  } as const;
  // Times keep the event's own type and zone. Under `series` the update carries this occurrence's new times and
  // the engine shifts the master's by the wall-clock delta (DECISIONS 2026-11-04); `more` mirrors the shift on
  // every loaded occurrence until the window settles.
  const target = timeChange(event, next);
  if (Object.keys(target.fields).length === 0) return done({ ...state, scope: null });
  const more = scoped === 'series' ? seriesShift(ctx, event, target.fields) : undefined;
  const change: EventChange = {
    type: 'update',
    id: target.id,
    scope: scoped,
    fields: target.fields,
  };
  return done({ ...state, scope: null, selectedId: id }, [
    {
      kind: 'eventSet',
      change,
      notify: notifiesGuests(change, event),
      optimistic: {
        id,
        patch: { start: toIsoDateTime(startUtc), end: toIsoDateTime(endUtc) },
        ...(more && more.length > 0 ? { more } : {}),
      },
      toast: {
        kind: 'info',
        message: `Moved ${entry.title}`,
        held: `Moving ${entry.title}`,
        undoable: true,
      },
      undoLabel: `Moved ${entry.title}`,
      failure: failureFor('move', entry.title),
      accountId: event.accountId,
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
  if (editingOff(ctx.accounts, event.accountId))
    return done(state, [{ kind: 'editingNotice', accountId: event.accountId }]);
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
        // Guests get the cancellation: the engine holds the delete so Undo still cancels it.
        notify: notifiesGuests(
          { type: 'destroy', id: entry.id, scope: scope ?? 'occurrence' },
          event,
        ),
        optimistic: { id: entry.id, remove: true },
        toast: { kind: 'trash', message: 'Event deleted', undoable: true },
        undoLabel: 'Event deleted',
        failure: failureFor('delete', entry.title),
        accountId: event.accountId,
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
  if (editingOff(ctx.accounts, event.accountId))
    return done(state, [{ kind: 'editingNotice', accountId: event.accountId }]);
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
      accountId: event.accountId,
    },
  ]);
}

/** The scope ask a save on a repeating event opens, or null when the entry is gone. */
function askEditScope(
  state: CalendarState,
  ctx: CalendarContext,
  draft: EditorDraft,
): Transition | null {
  const entry = entryById(ctx, draft.eventId);
  if (!entry) return null;
  return done(decideScope({ ...state, editor: null }, entry, 'change', { kind: 'edit', draft }));
}

/** Pending creates get distinct temp ids even with identical fields, or the second would replace the first (review1 10). */
let nextTempSeq = 0;

/**
 * The zone a timed write is made in: an update keeps the event's own — the series zone the engine
 * moves a series in (a floating series change in any other zone is refused `calendar.floatingSeries`) —
 * else the target calendar's. A create has no event of its own, so it takes the calendar's.
 */
function zoneFor(
  draft: EditorDraft,
  original: Event | undefined,
  ctx: CalendarContext,
): string | undefined {
  const calendar = ctx.calendars.find(c => c.id === (draft.calendarId ?? original?.calendarId));
  return original?.timeZone ?? calendar?.timeZone;
}

/** A new event's optimistic entry and its create write: the temp id stands in until the receipt lands. */
function createSave(
  state: CalendarState,
  ctx: CalendarContext,
  draft: EditorDraft,
  change: Extract<EventChange, { type: 'create' }>,
): Transition {
  const calendar = ctx.calendars.find(c => c.id === change.calendarId);
  const times = draftTimes(draft, calendar?.timeZone);
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
      // Invites go out with the create: held, so Undo still pulls them back.
      notify: notifiesGuests(change),
      optimistic: { id: tempId, add: entry },
      toast: {
        kind: 'info',
        message: `Added ${entry.title}`,
        held: `Adding ${entry.title}`,
        undoable: true,
      },
      undoLabel: `Added ${entry.title}`,
      failure: `Couldn't add ${entry.title}.`,
      draft,
      accountId: calendar?.accountId,
    },
  ]);
}

/** The account a save writes to: the target calendar's for a create, the event's for an update. */
function changeAccount(
  change: EventChange,
  original: Event | undefined,
  ctx: CalendarContext,
): string | undefined {
  return change.type === 'create'
    ? ctx.calendars.find(c => c.id === change.calendarId)?.accountId
    : original?.accountId;
}

/** The 'Turn on editing' notice when the account behind `accountId` lacks the write scope, else null. */
function editingGate(
  accountId: string | undefined,
  ctx: CalendarContext,
  next: CalendarState,
): Transition | null {
  return editingOff(ctx.accounts, accountId)
    ? done(next, [{ kind: 'editingNotice', accountId }])
    : null;
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
    const ask = askEditScope(state, ctx, draft);
    if (ask) return ask;
  }
  const scoped = scope ?? 'occurrence';
  const zone = zoneFor(draft, original, ctx);
  const change = draftChange(draft, original, scoped, zone);
  const next = { ...closed(state), editor: null };
  if (!change) return done(next);
  // The grant lacks the write scope: the save gets the calm notice, not a doomed write — and the
  // editor keeps the draft, like draftProblem's line does, so the typed work is not lost (review7 3).
  const gate = editingGate(changeAccount(change, original, ctx), ctx, {
    ...closed(state),
    editor: draft,
  });
  if (gate) return gate;
  if (change.type === 'create') return createSave(next, ctx, draft, change);
  return updateSave(next, ctx, draft, original, change, scoped, zone);
}

/** An existing event's optimistic patch and its update write; `series` mirrors the shift on loaded rows. */
function updateSave(
  next: CalendarState,
  ctx: CalendarContext,
  draft: EditorDraft,
  original: Event | undefined,
  change: EventChange,
  scoped: EventScope,
  zone?: string,
): Transition {
  const entry = entryById(ctx, draft.eventId);
  const title = draft.title.trim();
  const times = draftTimes(draft, zone);
  // "All events": the same whole-series change the engine makes, mirrored on the loaded rows — shifted times,
  // and the changed text fields too (a series rename retitles every occurrence, not just the edited one).
  const more =
    scoped === 'series' && original && change.type === 'update'
      ? seriesShift(ctx, original, change.fields, zone)
      : undefined;
  return done({ ...next, selectedId: draft.eventId ?? null }, [
    {
      kind: 'eventSet',
      change,
      notify: notifiesGuests(change, original),
      optimistic: {
        id: draft.eventId ?? '',
        // allDay rides with the times the way seriesShift patches its siblings: an All day toggle
        // redraws in the strip (or off it) at once, not when the write settles (review7 2).
        patch: {
          title,
          start: isoOfTime(times.start),
          end: isoOfTime(times.end),
          ...('fields' in change && change.fields.allDay !== undefined
            ? { allDay: change.fields.allDay }
            : {}),
        },
        ...(more && more.length > 0 ? { more } : {}),
      },
      toast: {
        kind: 'info',
        message: `Changed ${title}`,
        held: `Changing ${title}`,
        undoable: true,
      },
      undoLabel: `Changed ${title}`,
      failure: failureFor('change', entry?.title ?? title),
      reopenEditorId: draft.eventId,
      draft,
      accountId: original?.accountId,
    },
  ]);
}
