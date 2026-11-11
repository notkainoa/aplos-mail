/** The one reducer: every key, click and drag of the screen goes through `update` (DESIGN 5 rule 1: state first, then effects). */
import { toIsoDate } from '../../../data';
import { periodOf, stepAnchor } from './period';
import { editingOff } from '../accountCalendarState';
import { draftFromEvent, draftFromRange, newDraft, patchDraft } from './editor';
import { lockedMessage } from './rsvp';
import { planIdOf, walk } from './entries';
import {
  detailEntry,
  entryById,
  liveRsvp,
  shownView,
  type CalendarAction,
  type CalendarContext,
  type CalendarState,
  type DetailMenuId,
  type Transition,
} from './state';
import {
  cancelScope,
  closed,
  deleteTransition,
  done,
  moveTransition,
  rsvpTransition,
  saveEditor,
  sendReply,
} from './transitions';

type ActionOf<T extends CalendarAction['type']> = Extract<CalendarAction, { type: T }>;
type Handler<T extends CalendarAction['type']> = (
  state: CalendarState,
  action: ActionOf<T>,
  ctx: CalendarContext,
) => Transition;

const unhandled = (state: CalendarState): Transition => done(state, [], false);

function onSelect(state: CalendarState, action: ActionOf<'select'>): Transition {
  const keep = state.rsvp?.eventId === action.id ? state.rsvp : null;
  // A pick inside the stack menu opens that event; a click on the grid only selects.
  return done({
    ...state,
    selectedId: action.id,
    detailId: null,
    moreOpen: false,
    stackIds: null,
    rsvp: keep,
    scope: null,
  });
}

function onWalk(state: CalendarState, action: ActionOf<'walk'>, ctx: CalendarContext): Transition {
  const next = walk(ctx.entries, state.selectedId, action.dir);
  if (!next) return unhandled(state);
  return done({ ...state, selectedId: next, detailId: null, moreOpen: false, rsvp: null });
}

function onOpen(state: CalendarState, action: ActionOf<'open'>, ctx: CalendarContext): Transition {
  const entry = entryById(ctx, action.id ?? state.selectedId);
  if (!entry) return unhandled(state);
  // Opening the entry whose answer is chosen keeps the answer.
  const rsvp = state.rsvp?.eventId === entry.id ? state.rsvp : null;
  if (shownView(state) === 'day')
    return done({ ...closed(state), selectedId: entry.id, rsvp }, [
      { kind: 'focus', target: 'rail' },
    ]);
  return done({ ...closed(state), selectedId: entry.id, detailId: entry.id, rsvp });
}

function onReturn(
  state: CalendarState,
  _action: ActionOf<'return'>,
  ctx: CalendarContext,
): Transition {
  // Return sends a chosen answer while the RSVP block shows; otherwise it opens the selection.
  const live = liveRsvp(state, ctx);
  if (live && live.answer !== null) return rsvpTransition(state, ctx);
  return onOpen(state, { type: 'open' }, ctx);
}

function onClose(state: CalendarState): Transition {
  const effects = state.detailId ? [{ kind: 'focus', target: 'grid' } as const] : [];
  return done(closed(state), effects, state.detailId !== null);
}

/**
 * The Esc ladder: scope question, ⋯ menu, stack menu, popover, the chosen answer, then the selection; never leaves
 * Calendar. With the editor open the Dialog owns Esc (it cancels), so the ladder lets it through. Unhandled once
 * nothing is left, so Esc falls through to the shell (review1 4b).
 */
function onEscape(state: CalendarState): Transition {
  if (state.editor) return unhandled(state);
  if (state.scope) return cancelScope(state);
  if (state.moreOpen) return done({ ...state, moreOpen: false });
  if (state.stackIds) return done({ ...state, stackIds: null });
  if (state.holdsReview) return done({ ...state, holdsReview: false });
  if (state.detailId) return done(closed(state), [{ kind: 'focus', target: 'grid' }]);
  if (state.rsvp) return done({ ...state, rsvp: null });
  if (state.selectedId) return done({ ...state, selectedId: null });
  return unhandled(state);
}

function menuHide(s: CalendarState, id: string, ctx: CalendarContext): Transition {
  return done({ ...closed(s), selectedId: null }, [
    {
      kind: 'eventHide',
      id,
      optimistic: { id, remove: true },
      toast: { kind: 'info', message: 'Hidden in Aplos', undoable: true },
      accountId: ctx.events.get(id)?.accountId,
    },
  ]);
}

function menuNotNow(s: CalendarState, id: string): Transition {
  const planId = planIdOf(id);
  if (!planId) return unhandled(s);
  return done({ ...closed(s), selectedId: null }, [
    { kind: 'planDismiss', planId, optimistic: { id, remove: true } },
  ]);
}

function menuCopyLink(s: CalendarState, id: string, ctx: CalendarContext): Transition {
  const event = ctx.events.get(id);
  const link = event?.conference?.url ?? event?.htmlLink;
  if (!link) return unhandled(s);
  return done(s, [
    { kind: 'copy', text: link, toast: { kind: 'info', message: 'Link copied', undoable: false } },
  ]);
}

function onMenu(state: CalendarState, action: ActionOf<'menu'>, ctx: CalendarContext): Transition {
  const entry = detailEntry(state, ctx);
  if (!entry) return unhandled(state);
  const s = { ...state, moreOpen: false };
  const items: Record<DetailMenuId, () => Transition> = {
    edit: () => onEdit({ ...s, selectedId: entry.id }, { type: 'edit' }, ctx),
    delete: () => deleteTransition({ ...s, selectedId: entry.id }, ctx),
    changeReply: () =>
      done({ ...s, rsvp: { eventId: entry.id, answer: entry.myReply ?? null, changing: true } }),
    notNow: () => menuNotNow(s, entry.id),
    hide: () => menuHide(s, entry.id, ctx),
    copyLink: () => menuCopyLink(s, entry.id, ctx),
  };
  return items[action.item]();
}

function onAnswer(
  state: CalendarState,
  action: ActionOf<'answer'>,
  ctx: CalendarContext,
): Transition {
  const live = liveRsvp(state, ctx);
  if (!live) return unhandled(state);
  return done({ ...state, rsvp: { ...live, answer: action.answer } });
}

function onScope(
  state: CalendarState,
  action: ActionOf<'scope'>,
  ctx: CalendarContext,
): Transition {
  const ask = state.scope;
  if (!ask) return unhandled(state);
  const p = ask.pending;
  if (p.kind === 'move')
    return moveTransition(state, ctx, ask.entryId, p.start, p.end, action.scope);
  if (p.kind === 'delete') return deleteTransition(state, ctx, action.scope);
  if (p.kind === 'edit') return saveEditor(state, ctx, action.scope);
  const entry = entryById(ctx, ask.entryId);
  const event = ctx.events.get(ask.entryId);
  if (!entry || !event) return done({ ...state, scope: null }, [], false);
  return sendReply(state, entry, event, p.answer, action.scope);
}

function onNewEvent(
  state: CalendarState,
  _action: ActionOf<'newEvent'>,
  ctx: CalendarContext,
): Transition {
  // Today when it is in view (the next free half hour), else the anchor day at 9 AM.
  const shown = shownView(state);
  const today = toIsoDate(ctx.now);
  const inView = periodOf(shown, state.anchor, ctx.weekStartsOn).days.includes(today);
  const day = shown !== 'day' && inView ? today : state.anchor;
  return done({
    ...closed(state),
    editor: newDraft(day, ctx.now, ctx.entries, ctx.defaultCalendarId),
  });
}

function onEdit(state: CalendarState, _action: ActionOf<'edit'>, ctx: CalendarContext): Transition {
  // Explicit targets only: the day rail's passive first entry is never one (review2 1).
  const target = entryById(ctx, state.detailId ?? state.selectedId);
  const event = target ? ctx.events.get(target.id) : undefined;
  if (!target || target.kind !== 'event' || !event) return unhandled(state);
  const calendar = ctx.calendars.find(c => c.id === event.calendarId);
  if (!event.can.edit || calendar?.readOnly)
    return done(state, [{ kind: 'notice', message: lockedMessage(event, calendar) }]);
  // The grant lacks the write scope: E gets the calm notice, not an editor whose save would fail (shape 3).
  if (editingOff(ctx.accounts, event.accountId))
    return done(state, [{ kind: 'editingNotice', accountId: event.accountId }]);
  return done({ ...closed(state), selectedId: target.id, editor: draftFromEvent(event) });
}

/**
 * `calendar.conflict` on an editor save: select the event and re-run 'edit' against the newer copy
 * already in the store, but take only the state — its locked/editing-gate notices would double the
 * conflict's own sentence (review7 5). Unhandled when no editor can open, so the notice stands alone.
 * An editor already open owns its draft: a late conflict never swaps it out (review8 2).
 */
function onReopenEditor(
  state: CalendarState,
  action: ActionOf<'reopenEditor'>,
  ctx: CalendarContext,
): Transition {
  if (state.editor !== null) return unhandled(state);
  const sel = onSelect(state, { type: 'select', id: action.eventId });
  const t = onEdit(sel.state, { type: 'edit' }, ctx);
  if (t.state === sel.state || t.state.editor === null) return done(sel.state, [], false);
  return done({ ...t.state, editor: { ...t.state.editor, error: action.note } });
}

/**
 * A times refusal (`event.allDayMismatch`, `event.timesRequired`) on an editor save: the draft comes
 * back as it was typed — never rebuilt from the store, which holds the pre-save event (the gate and
 * `draftProblem` keep it the same way). An editor already open owns its draft: the notice falls back
 * to the toast, like a late conflict (review8 2).
 */
function onRestoreEditor(state: CalendarState, action: ActionOf<'restoreEditor'>): Transition {
  if (state.editor !== null) return unhandled(state);
  return done({ ...closed(state), editor: { ...action.draft, error: action.note } });
}

function onEditorPatch(state: CalendarState, action: ActionOf<'editor'>): Transition {
  if (!state.editor) return unhandled(state);
  return done({ ...state, editor: patchDraft(state.editor, action.patch) });
}

function onResize(
  state: CalendarState,
  action: ActionOf<'resize'>,
  ctx: CalendarContext,
): Transition {
  const entry = entryById(ctx, action.id);
  if (!entry) return unhandled(state);
  return moveTransition(state, ctx, action.id, entry.start, action.end);
}

function onConfirmPlan(
  state: CalendarState,
  _action: ActionOf<'confirmPlan'>,
  ctx: CalendarContext,
): Transition {
  const entry = detailEntry(state, ctx);
  const planId = entry ? planIdOf(entry.id) : null;
  if (!entry || !planId) return unhandled(state);
  const accountId = ctx.calendars.find(c => c.id === ctx.defaultCalendarId)?.accountId;
  if (editingOff(ctx.accounts, accountId))
    return done({ ...closed(state) }, [{ kind: 'editingNotice', accountId }]);
  return done({ ...closed(state), selectedId: null }, [
    {
      kind: 'planConfirm',
      planId,
      calendarId: ctx.defaultCalendarId,
      optimistic: { id: entry.id, remove: true },
      accountId,
    },
  ]);
}

function onOpenInvite(
  state: CalendarState,
  _action: ActionOf<'openInvite'>,
  ctx: CalendarContext,
): Transition {
  const entry = detailEntry(state, ctx);
  if (!entry?.invite) return unhandled(state);
  return done(state, [{ kind: 'openThread', threadId: entry.invite.threadId }]);
}

function onOpenSource(
  state: CalendarState,
  _action: ActionOf<'openSource'>,
  ctx: CalendarContext,
): Transition {
  const entry = detailEntry(state, ctx);
  if (!entry?.source) return unhandled(state);
  return done(state, [{ kind: 'openThread', threadId: entry.source.threadId }]);
}

/** Only an https meeting link is opened outside Aplos; a malformed or other-scheme link is never handed on. */
function isHttpsUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

function onOpenVideo(
  state: CalendarState,
  _action: ActionOf<'openVideo'>,
  ctx: CalendarContext,
): Transition {
  const entry = detailEntry(state, ctx);
  const url = entry ? ctx.events.get(entry.id)?.conference?.url : undefined;
  return url && isHttpsUrl(url) ? done(state, [{ kind: 'openUrl', url }]) : unhandled(state);
}

function onToggleCalendar(
  state: CalendarState,
  action: ActionOf<'toggleCalendar'>,
  ctx: CalendarContext,
): Transition {
  // A plain click while one calendar is shown alone leaves solo and brings the saved set back.
  if (state.solo) return done({ ...state, solo: null });
  const calendar = ctx.calendars.find(c => c.id === action.id);
  if (!calendar) return unhandled(state);
  const shown = !calendar.shown;
  return done(state, [
    {
      kind: 'calendarSet',
      id: calendar.id,
      shown,
      // One Undo toast per write, like every other lane write (review1 17).
      toast: {
        kind: 'info',
        message: `${calendar.name} ${shown ? 'shown' : 'hidden'}`,
        undoable: true,
      },
    },
  ]);
}

const HANDLERS: { readonly [T in CalendarAction['type']]: Handler<T> } = {
  width: (s, a) => (a.px === s.paneWidth ? unhandled(s) : done({ ...s, paneWidth: a.px })),
  today: (s, _a, ctx) => done({ ...closed(s), anchor: toIsoDate(ctx.now), miniMonth: null }),
  // A view switch re-syncs the sidebar's month to the anchor like a period step does (review1 15).
  view: (s, a) => done({ ...closed(s), view: a.view, miniMonth: null }),
  period: (s, a) =>
    done({ ...closed(s), anchor: stepAnchor(shownView(s), s.anchor, a.dir), miniMonth: null }),
  pick: (s, a) => done({ ...closed(s), anchor: a.date, miniMonth: null }),
  miniMonth: (s, a) => done({ ...s, miniMonth: a.month }),
  select: onSelect,
  walk: onWalk,
  open: onOpen,
  return: onReturn,
  close: onClose,
  escape: onEscape,
  openStack: (s, a) => done({ ...closed(s), stackIds: [...a.ids] }),
  closeStack: s => done({ ...s, stackIds: null }),
  more: (s, a) => done({ ...s, moreOpen: a.open }),
  menu: onMenu,
  answer: onAnswer,
  sendReply: (s, _a, ctx) => rsvpTransition(s, ctx),
  scope: onScope,
  scopeCancel: s => cancelScope(s),
  newEvent: onNewEvent,
  createRange: (s, a, ctx) =>
    done({
      ...closed(s),
      editor: draftFromRange({ start: a.start, end: a.end }, ctx.defaultCalendarId),
    }),
  edit: onEdit,
  editor: onEditorPatch,
  editorSave: (s, _a, ctx) => saveEditor(s, ctx),
  editorCancel: s => done({ ...s, editor: null }),
  // The conflict notice lands on the re-opened editor's own line (writeErrors, calendar.conflict).
  editorNote: (s, a) =>
    s.editor ? done({ ...s, editor: { ...s.editor, error: a.message } }) : unhandled(s),
  reopenEditor: onReopenEditor,
  restoreEditor: onRestoreEditor,
  enableEditing: (s, a) => done(s, [{ kind: 'enableEditing', accountId: a.accountId }]),
  delete: (s, _a, ctx) => deleteTransition(s, ctx),
  move: (s, a, ctx) => moveTransition(s, ctx, a.id, a.start, a.end),
  resize: onResize,
  confirmPlan: onConfirmPlan,
  openInvite: onOpenInvite,
  openSource: onOpenSource,
  openVideo: onOpenVideo,
  toggleCalendar: onToggleCalendar,
  soloCalendar: (s, a) => done({ ...closed(s), solo: s.solo === a.id ? null : a.id }),
  holdsReview: (s, a) => done({ ...s, holdsReview: a.open }),
  // The Review list stays open while a row's action settles; the row leaves in place, and the
  // component closes the list itself once it is empty (review19).
  holdRetry: (s, a) => done(s, [{ kind: 'holdRetry', id: a.id, opId: a.opId }]),
  holdDiscard: (s, a) => done(s, [{ kind: 'holdDiscard', id: a.id }]),
};

/** The one reducer: every key, click and drag of the screen goes through here (DESIGN 5 rule 1: state first, then effects). */
export function update(
  state: CalendarState,
  action: CalendarAction,
  ctx: CalendarContext,
): Transition {
  const handler = HANDLERS[action.type] as Handler<CalendarAction['type']>;
  return handler(state, action, ctx);
}
