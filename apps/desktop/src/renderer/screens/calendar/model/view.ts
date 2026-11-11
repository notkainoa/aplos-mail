/** The view model CalendarScreen draws. */
import { toIsoDate, toIsoDateTime, type Calendar, type Event } from '../../../data';
import { failedHoldLine, type FailedHold } from '../FailedHolds';
import type {
  CalendarEventData,
  CalendarView,
  IsoDate,
  IsoDateTime,
  IsoTime,
  MenuEntry,
  RsvpAnswer,
  TagColor,
} from '../../../ui/props';
import {
  dateOf,
  dayOf,
  dayTitle,
  formatClock,
  longDay,
  rangeOf,
  timeOf,
  WEEKDAYS,
  yearMonthOf,
} from '../../../ui/calendar/dates';
import {
  daysBetween,
  editorShowsDelete,
  endChoices,
  startChoices,
  type EditorDraft,
} from './editor';
import {
  entriesFor,
  entriesOnDay,
  monthEventCount,
  tagFor,
  visibleCalendarIds,
  writableCalendars,
} from './entries';
import {
  gridLabel,
  lookaheadEnd,
  periodOf,
  periodWord,
  topLabel,
  type GridView,
  type Period,
} from './period';
import { DAY_MS } from './units';
import { canSendReply } from './rsvp';
import { editingOff } from '../accountCalendarState';
import {
  detailMenu,
  entryById,
  liveRsvp,
  railEntry,
  shownView,
  type CalendarContext,
  type CalendarState,
  type ScopeAsk,
} from './state';

export interface EditorView {
  readonly draft: EditorDraft;
  readonly title: string;
  readonly showDelete: boolean;
  /** "Thursday, October 29, 2026". */
  readonly dateLabel: string;
  readonly startLabel: string;
  readonly endLabel: string;
  readonly startChoices: readonly IsoTime[];
  readonly endChoices: ReadonlyArray<{ time: IsoTime; length: string }>;
  /** Calendars a new event can go on; an existing event shows its own, fixed. */
  readonly calendars: ReadonlyArray<{ id: string; name: string; color: TagColor }>;
  readonly calendar: { id: string; name: string; color: TagColor } | null;
  readonly calendarFixed: boolean;
  /** For the day picker's today badge and first weekday. */
  readonly today: IsoDate;
  readonly weekStartsOn: 0 | 1;
}

export interface CalendarViewModel {
  readonly view: GridView;
  /**
   * The D | W | M switcher's choice: none while the narrow agenda shows, which always lists a week (label, J and K
   * included), so the switcher never claims Day or Month the pane is not drawing (DESIGN 7.8 Narrow; review1 4d).
   */
  readonly viewSelected: GridView | null;
  readonly shown: CalendarView;
  readonly period: Period;
  readonly head: { label: string; range: string };
  readonly gridLabel: string;
  readonly periodWord: 'day' | 'week' | 'month';
  readonly entries: readonly CalendarEventData[];
  /** The loaded events by id: the failed-holds rows resolve their titles here (review19). */
  readonly events: ReadonlyMap<string, Event>;
  readonly now: IsoDateTime;
  readonly weekStartsOn: 0 | 1;
  readonly selectedId: string | undefined;
  /** The day view's rail (hidden when the day is empty or the pane is narrow). */
  readonly rail: CalendarEventData | null;
  /** The popover's entry. */
  readonly popover: CalendarEventData | null;
  /**
   * The RSVP block of the rail or popover: `answer` is the pending new answer, null while nothing new is chosen
   * (never picked, or the pick is the reply already sent) — EventDetail disables "Send reply" exactly then, the
   * only lever its props give (review1 4). `canSend` is the same condition, kept for the tests.
   */
  readonly reply: { answer: RsvpAnswer | null; canSend: boolean } | null;
  readonly more: readonly MenuEntry[];
  readonly moreOpen: boolean;
  readonly stack: { ids: readonly string[]; label: string; entries: readonly MenuEntry[] } | null;
  readonly scope: {
    action: ScopeAsk['action'];
    title: string;
    entryId: string;
  } | null;
  readonly editor: EditorView | null;
  /**
   * The open detail's 'Turn on editing' line and Enable editing action: the account id when that event's
   * grant lacks the write scope (shape 3). Contextual to the event, so a read-only account carries no
   * standing nag — no banner, no sidebar line.
   */
  readonly editing: { accountId: string } | null;
  /** DESIGN 7.14: "Nothing scheduled" with New event · N, on an empty day. */
  readonly emptyAction: boolean;
  /** The calm panel an empty day or week draws in the visible window; null while anything shows. */
  readonly empty: EmptyView | null;
  /**
   * Failed guest-notifying holds from the queue (review20): the pane's quiet line ("N changes didn't
   * send · Review") and its list; null while nothing failed — never a standing nag.
   */
  readonly failedHolds: { items: readonly FailedHold[]; line: string; open: boolean } | null;
}

/** What an empty day or week says: one plain sentence, then what comes next from the loaded events. */
export interface EmptyView {
  /** "Nothing on Sunday, November 1" / "A clear week" */
  readonly sentence: string;
  /** "Next: Q4 review, Thursday at 11:00 AM", or the honest fallback. */
  readonly next: string;
}

/** The soonest upcoming entry in the watched window: `from` is now, or the period's start when it is ahead. */
function nextUpcoming(state: CalendarState, ctx: CalendarContext, period: Period): string {
  const from = Math.max(ctx.now, period.from);
  const limit = lookaheadEnd(from);
  const horizon = Math.min(limit, ctx.loadedThrough);
  const next = entriesFor({
    events: [...ctx.events.values()],
    plans: [],
    calendars: ctx.calendars,
    solo: state.solo,
    period: { from, to: horizon },
    planCalendarId: ctx.defaultCalendarId,
  }).find(e => new Date(e.start).getTime() >= from);
  if (!next) {
    return ctx.loadedThrough >= limit
      ? 'Nothing coming up in the next two weeks'
      : 'Nothing coming up';
  }
  const day = dayOf(next.start);
  const soon = new Date(next.start).getTime() - from < 7 * DAY_MS;
  const when = soon ? WEEKDAYS[dateOf(day).getDay()] : longDay(day);
  return next.allDay
    ? `Next: ${next.title}, ${when}`
    : `Next: ${next.title}, ${when} at ${timeOf(next.start)}`;
}

/** The panel's copy for a bare grid, or null: a plan alone still counts as something on the day or week. */
function emptyView(
  shown: CalendarView,
  state: CalendarState,
  ctx: CalendarContext,
  period: Period,
  entries: readonly CalendarEventData[],
  dayCount: number,
): EmptyView | null {
  // No calendars yet means loading, not empty: the panel and its status line wait for the first get (review1 12).
  if (!ctx.calendarsReady) return null;
  // Every calendar hidden draws a bare grid that is not a clear week: say what is really true (review2 7).
  if (ctx.calendars.length > 0 && visibleCalendarIds(ctx.calendars, state.solo).length === 0)
    return {
      sentence: 'All your calendars are hidden',
      next: 'Turn one back on to see your events',
    };
  const sentence =
    shown === 'day' && dayCount === 0
      ? `Nothing on ${longDay(state.anchor)}`
      : shown === 'week' && entries.length === 0
        ? 'A clear week'
        : null;
  return sentence === null ? null : { sentence, next: nextUpcoming(state, ctx, period) };
}

/** The open detail's 'Turn on editing' line: the account when its grant lacks the write scope (shape 3). */
function detailEditing(
  detail: CalendarEventData | null,
  ctx: CalendarContext,
): { accountId: string } | null {
  if (detail?.kind !== 'event') return null;
  const event = ctx.events.get(detail.id);
  if (!event) return null;
  // Only where the missing scope is all that stands between the owner and a change: an event
  // without a write the grant would unlock (or one on a read-only calendar, where only an
  // invite's reply can still be written) carries no standing nag (review7 6).
  const calendar = ctx.calendars.find(c => c.id === event.calendarId);
  const writable =
    event.can.rsvp ||
    (!calendar?.readOnly && (event.can.edit || event.can.move || event.can.delete));
  if (!writable) return null;
  const account = editingOff(ctx.accounts, event.accountId);
  return account ? { accountId: account.id } : null;
}

export function viewModel(state: CalendarState, ctx: CalendarContext): CalendarViewModel {
  const shown = shownView(state);
  const period = periodOf(shown, state.anchor, ctx.weekStartsOn);
  const entries = ctx.entries;
  const dayCount = entriesOnDay(entries, state.anchor).length;
  const rail = shown === 'day' ? (railEntry(state, ctx) ?? null) : null;
  const popover = shown === 'day' ? null : (entryById(ctx, state.detailId) ?? null);
  const detail = popover ?? rail;
  const live = liveRsvp(state, ctx);
  const stackEntries = state.stackIds
    ? state.stackIds
        .map(id => entryById(ctx, id))
        .filter((e): e is CalendarEventData => e !== undefined)
    : [];
  const scopeEntry = state.scope ? entryById(ctx, state.scope.entryId) : undefined;
  return {
    view: state.view,
    viewSelected: shown === 'agenda' ? null : state.view,
    shown,
    period,
    head: topLabel(
      shown,
      period,
      state.anchor,
      monthEventCount(entries, yearMonthOf(state.anchor)),
    ),
    gridLabel: gridLabel(shown, period, state.anchor, dayCount),
    periodWord: periodWord(shown),
    entries,
    events: ctx.events,
    now: toIsoDateTime(ctx.now),
    weekStartsOn: ctx.weekStartsOn,
    selectedId: entryById(ctx, state.selectedId)?.id,
    rail,
    popover,
    reply:
      live && detail && live.eventId === detail.id
        ? {
            answer: canSendReply(live, detail) ? live.answer : null,
            canSend: canSendReply(live, detail),
          }
        : null,
    editing: detailEditing(detail, ctx),
    more: detail ? detailMenu(detail, ctx) : [],
    moreOpen: state.moreOpen && detail !== null,
    stack:
      stackEntries.length > 0
        ? {
            ids: stackEntries.map(e => e.id),
            label: `${stackEntries.length} more at ${timeOf(stackEntries[0].start)}`,
            entries: [
              {
                kind: 'label',
                label: `${stackEntries.length} more at ${timeOf(stackEntries[0].start)}`,
              },
              ...stackEntries.map((e): MenuEntry => ({
                kind: 'item',
                id: e.id,
                label: e.title,
                swatch: e.calendar.color,
                aside: e.allDay ? 'All day' : rangeOf(e.start, e.end),
              })),
            ],
          }
        : null,
    scope:
      state.scope && scopeEntry
        ? {
            action: state.scope.action,
            title: scopeEntry.title,
            entryId: scopeEntry.id,
          }
        : null,
    editor: state.editor ? editorView(state.editor, ctx) : null,
    emptyAction: ctx.calendarsReady && (shown === 'day' || shown === 'agenda'),
    empty: emptyView(shown, state, ctx, period, entries, dayCount),
    failedHolds:
      ctx.failedHolds.length > 0
        ? {
            items: ctx.failedHolds,
            line: failedHoldLine(ctx.failedHolds.length),
            open: state.holdsReview,
          }
        : null,
  };
}

function editorView(draft: EditorDraft, ctx: CalendarContext): EditorView {
  const ref = (c: Calendar) => ({ id: c.id, name: c.name, color: tagFor(c, ctx.calendars) });
  const own = ctx.calendars.find(c => c.id === draft.calendarId);
  return {
    draft,
    title: draft.mode === 'new' ? 'New event' : 'Edit event',
    showDelete: editorShowsDelete(draft),
    dateLabel: dayTitle(draft.date),
    startLabel: formatClock(draft.start),
    endLabel: formatClock(draft.end),
    startChoices: startChoices(draft.start),
    endChoices: endChoices(
      draft.start,
      draft.end,
      draft.allDay ? 0 : daysBetween(draft.date, draft.endDate),
    ),
    calendars: writableCalendars(ctx.calendars).map(ref),
    calendar: own ? ref(own) : null,
    calendarFixed: draft.mode === 'edit',
    today: toIsoDate(ctx.now),
    weekStartsOn: ctx.weekStartsOn,
  };
}
