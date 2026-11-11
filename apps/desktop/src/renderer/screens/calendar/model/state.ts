/** The screen's state, its actions and effects, and the selectors the reducer, the commands and the view share. */
import type { EventChange } from '@aplos/contract';
import type { Account, Calendar, EpochMs, Event, Plan } from '../../../data';
import type {
  CalendarEventData,
  CalendarView,
  EventScope,
  IsoDate,
  IsoDateTime,
  IsoYearMonth,
  MenuEntry,
  RsvpAnswer,
  ToastKind,
} from '../../../ui/props';
import type { EditorDraft } from './editor';
import { entriesOnDay } from './entries';
import { shownViewFor, type GridView } from './period';
import { lockedMessage, type RsvpState } from './rsvp';

// ---------------------------------------------------------------------------
// The screen's state and its one reducer
// ---------------------------------------------------------------------------

/** A change waiting for "This event" or "All events" (ScopeChooser). */
export type PendingChange =
  | { readonly kind: 'move'; readonly start: IsoDateTime; readonly end: IsoDateTime }
  | { readonly kind: 'edit'; readonly draft: EditorDraft }
  /** The draft is carried so Cancel returns to the editor with the edits intact (review1 6). */
  | { readonly kind: 'delete'; readonly draft?: EditorDraft }
  | { readonly kind: 'reply'; readonly answer: RsvpAnswer };

export interface ScopeAsk {
  readonly action: 'move' | 'change' | 'delete' | 'reply';
  readonly entryId: string;
  readonly pending: PendingChange;
}

export interface CalendarState {
  readonly view: GridView;
  /** The day the period is built around. */
  readonly anchor: IsoDate;
  /** Measured pane width; 0 until measured. */
  readonly paneWidth: number;
  readonly selectedId: string | null;
  /** The detail popover (week, month, agenda); the day view's rail follows the selection instead. */
  readonly detailId: string | null;
  /** The ⋯ menu of the open detail. */
  readonly moreOpen: boolean;
  /** The "+N" stack's menu. */
  readonly stackIds: readonly string[] | null;
  /** Answers chosen but not sent, while the RSVP block shows. */
  readonly rsvp: RsvpState | null;
  readonly scope: ScopeAsk | null;
  readonly editor: EditorDraft | null;
  /** ⌥-click: one calendar alone, for this session. */
  readonly solo: string | null;
  /** The sidebar's month when paged away from the anchor; null follows the anchor. */
  readonly miniMonth: IsoYearMonth | null;
}

export function initialState(today: IsoDate, view: GridView = 'week'): CalendarState {
  return {
    view,
    anchor: today,
    paneWidth: 0,
    selectedId: null,
    detailId: null,
    moreOpen: false,
    stackIds: null,
    rsvp: null,
    scope: null,
    editor: null,
    solo: null,
    miniMonth: null,
  };
}

/** What the reducer reads besides the state. */
export interface CalendarContext {
  readonly now: EpochMs;
  readonly weekStartsOn: 0 | 1;
  /** The period's visible entries, overlay applied (`entriesFor`). */
  readonly entries: readonly CalendarEventData[];
  readonly events: ReadonlyMap<string, Event>;
  readonly plans: ReadonlyMap<string, Plan>;
  readonly calendars: readonly Calendar[];
  /** The accounts events and calendars belong to: `grantedScopes` gates editing (shape 1). */
  readonly accounts: readonly Account[];
  /** `Calendar/get` has answered at least once. Until then the grid is loading, never empty (review1 12). */
  readonly calendarsReady: boolean;
  /**
   * The events window draws the grid. Until it does (opening with no rows, or failed), commands stay off so
   * nothing mutates a state nobody can see — N's editor would pop up unannounced later (review2 5).
   */
  readonly windowReady: boolean;
  /** The watched events window's `to` (`eventsRange`): the empty panel's "next" line stays honest inside it. */
  readonly loadedThrough: EpochMs;
  /** Where new events and confirmed plans go. */
  readonly defaultCalendarId: string | null;
}

export type CalendarAction =
  | { type: 'width'; px: number }
  | { type: 'today' }
  | { type: 'view'; view: GridView }
  | { type: 'period'; dir: 1 | -1 }
  | { type: 'pick'; date: IsoDate }
  | { type: 'miniMonth'; month: IsoYearMonth }
  | { type: 'select'; id: string }
  | { type: 'walk'; dir: 1 | -1 }
  | { type: 'open'; id?: string }
  | { type: 'return' }
  | { type: 'close' }
  | { type: 'escape' }
  | { type: 'openStack'; ids: readonly string[] }
  | { type: 'closeStack' }
  | { type: 'more'; open: boolean }
  | { type: 'menu'; item: DetailMenuId }
  | { type: 'answer'; answer: RsvpAnswer }
  | { type: 'sendReply' }
  | { type: 'scope'; scope: EventScope }
  | { type: 'scopeCancel' }
  | { type: 'newEvent' }
  | { type: 'createRange'; start: IsoDateTime; end: IsoDateTime }
  | { type: 'edit' }
  | {
      type: 'editor';
      patch: Partial<Pick<EditorDraft, 'title' | 'date' | 'start' | 'end' | 'calendarId'>>;
    }
  | { type: 'editorSave' }
  | { type: 'editorCancel' }
  | { type: 'editorNote'; message: string }
  /** `calendar.conflict` on a save: re-open the editor on the newer copy with `note` as its error line. */
  | { type: 'reopenEditor'; eventId: string; note: string }
  /** A times refusal on a save: re-open the editor on the saved draft, `note` as its error line. */
  | { type: 'restoreEditor'; draft: EditorDraft; note: string }
  /** The detail's 'Enable editing' button: opens the grant sheet for this account. */
  | { type: 'enableEditing'; accountId: string }
  | { type: 'delete' }
  | { type: 'move'; id: string; start: IsoDateTime; end: IsoDateTime }
  | { type: 'resize'; id: string; end: IsoDateTime }
  | { type: 'confirmPlan' }
  | { type: 'openInvite' }
  | { type: 'openSource' }
  | { type: 'openVideo' }
  | { type: 'toggleCalendar'; id: string }
  | { type: 'soloCalendar'; id: string };

/** A toast to push: one operation, one notice (DESIGN 7.13). */
export interface ToastPlan {
  readonly kind: ToastKind;
  readonly message: string;
  readonly undoable: boolean;
  /**
   * The in-flight wording while the engine holds the write (`undoUntil`, a calendar write guests are not
   * told about yet); `message` lands once the hold ends, like the RSVP toast's held/sent pair (review2 4).
   */
  readonly held?: string;
}

/** An optimistic change to apply at once (DESIGN 5 rule 1) and drop when the receipt or a failure comes back. */
export interface OptimisticChange {
  readonly id: string;
  readonly patch?: Partial<CalendarEventData>;
  readonly remove?: boolean;
  readonly add?: CalendarEventData;
  /**
   * Other entries the same write touches: an "All events" time change shifts every loaded occurrence of the series
   * (model/transitions.ts). Applied, settled and rolled back with `id` — one write, one undo.
   */
  readonly more?: readonly OptimisticChange[];
}

export type CalendarEffect =
  | {
      kind: 'eventSet';
      change: EventChange;
      optimistic: OptimisticChange;
      /**
       * `notify: true` when the change would email other guests — the engine only holds a write that
       * tells them (`holdIfNotifying`), and only a held write gives an undo window. Set by
       * `notifiesGuests` (model/transitions.ts); effects send `notify: true` to `Event/set` then,
       * never `false` (unset keeps the provider's own default).
       */
      notify?: boolean;
      /** Every write's own Undo toast (id = opId); `held` words it while the engine holds the write. */
      toast?: ToastPlan;
      undoLabel: string;
      /** The sentence if it is refused: "Couldn't move Q4 review." */
      failure: string;
      /** An editor save's event: on `calendar.conflict` the editor re-opens on the newer copy (writeErrors). */
      reopenEditorId?: string;
      /** An editor save's draft: a times refusal re-opens the editor on it, typed work intact (writeErrors). */
      draft?: EditorDraft;
      /** The account the write goes to: `permission.calendarWrite` offers Enable editing on it. */
      accountId?: string;
    }
  | {
      kind: 'rsvp';
      id: string;
      response: 'accepted' | 'tentative' | 'declined';
      scope: EventScope;
      optimistic: OptimisticChange;
      answer: RsvpAnswer;
      organizer?: string;
      failure: string;
      /** The account the reply goes to: `permission.calendarWrite` offers Enable editing on it. */
      accountId?: string;
    }
  /** The owner tried to change something on an account whose grant lacks the write scope: the calm notice. */
  | { kind: 'editingNotice'; accountId?: string }
  /** The detail's Enable editing button: opens the grant sheet for this account. */
  | { kind: 'enableEditing'; accountId: string }
  | { kind: 'calendarSet'; id: string; shown: boolean; toast?: ToastPlan }
  | {
      kind: 'planConfirm';
      planId: string;
      calendarId: string | null;
      optimistic: OptimisticChange;
      /** The calendar the plan would join: `permission.calendarWrite` offers Enable editing on it. */
      accountId?: string;
    }
  | { kind: 'planDismiss'; planId: string; optimistic: OptimisticChange }
  | {
      kind: 'eventHide';
      id: string;
      optimistic: OptimisticChange;
      toast: ToastPlan;
      /** The event's account: `permission.calendarWrite` offers Enable editing on it. */
      accountId?: string;
    }
  | { kind: 'openThread'; threadId: string }
  | { kind: 'openUrl'; url: string }
  | { kind: 'copy'; text: string; toast: ToastPlan }
  | { kind: 'notice'; message: string }
  | { kind: 'focus'; target: 'grid' | 'rail' };

export interface Transition {
  readonly state: CalendarState;
  readonly effects: readonly CalendarEffect[];
  /** False when the action did nothing, so a key falls through (the Esc ladder's next rung). */
  readonly handled: boolean;
}

/** The view the pane draws right now. */
export function shownView(state: CalendarState): CalendarView {
  return shownViewFor(state.view, state.paneWidth);
}

export function entryById(
  ctx: CalendarContext,
  id: string | null | undefined,
): CalendarEventData | undefined {
  return id ? ctx.entries.find(e => e.id === id) : undefined;
}

/** The entry the day view's rail shows: the selection when it is on that day, else the day's first entry. */
export function railEntry(
  state: CalendarState,
  ctx: CalendarContext,
): CalendarEventData | undefined {
  if (shownView(state) !== 'day') return undefined;
  const day = entriesOnDay(ctx.entries, state.anchor);
  return day.find(e => e.id === state.selectedId) ?? day[0];
}

/**
 * `calendar.eventGone` closes the detail only when it is the gone event's own: the open popover or
 * the RSVP choice names it — never an unrelated detail (review7 4).
 */
export function detailIsFor(state: CalendarState, eventId: string): boolean {
  return state.detailId === eventId || state.rsvp?.eventId === eventId;
}

/** The open detail: the popover's entry, or the day rail's. */
export function detailEntry(
  state: CalendarState,
  ctx: CalendarContext,
): CalendarEventData | undefined {
  return entryById(ctx, state.detailId) ?? railEntry(state, ctx);
}

/**
 * The RSVP block of the open detail: shown for an unanswered invite (nothing chosen) or after "Change your reply".
 * Y/M/N answer only while this is not null; otherwise M means Month and N a new event (DESIGN 7.8, 8).
 */
export function liveRsvp(state: CalendarState, ctx: CalendarContext): RsvpState | null {
  const entry = detailEntry(state, ctx);
  if (!entry || entry.kind !== 'event' || state.editor || state.scope) return null;
  if (state.rsvp && state.rsvp.eventId === entry.id) return state.rsvp;
  return entry.unanswered ? { eventId: entry.id, answer: null, changing: false } : null;
}

/**
 * The registry condition `invite`: an unanswered invite (or a reply being changed) is open, so Y/M/N answer it. The day
 * view's rail shows the day's first entry by itself; that invite counts as open only once it is selected or answered
 * there, so M and N on a day nobody touched still mean Month and New event (review1 4a).
 */
export function inviteOpen(state: CalendarState, ctx: CalendarContext): boolean {
  const live = liveRsvp(state, ctx);
  if (!live) return false;
  if (state.detailId === live.eventId || shownView(state) !== 'day') return true;
  return state.selectedId === live.eventId || state.rsvp?.eventId === live.eventId;
}

/** The ⋯ menu's items for an entry: edit and delete on your own, change your reply on an invite, hide, copy link. */
export type DetailMenuId = 'edit' | 'delete' | 'changeReply' | 'hide' | 'copyLink' | 'notNow';

export function detailMenu(entry: CalendarEventData, ctx: CalendarContext): MenuEntry[] {
  if (entry.kind === 'plan') return [{ kind: 'item', id: 'notNow', label: 'Not now' }];
  const event = ctx.events.get(entry.id);
  const calendar = event ? ctx.calendars.find(c => c.id === event.calendarId) : undefined;
  const items: MenuEntry[] = [];
  const editable = event ? event.can.edit && !calendar?.readOnly : entry.isOrganizer === true;
  if (editable) items.push({ kind: 'item', id: 'edit', label: 'Edit', commandId: 'calendar.edit' });
  else if (event)
    items.push({
      kind: 'item',
      id: 'edit',
      label: 'Edit',
      disabled: true,
      detail: lockedMessage(event, calendar),
    });
  if (entry.myReply !== undefined && (event?.can.rsvp ?? true) && !entry.unanswered)
    items.push({ kind: 'item', id: 'changeReply', label: 'Change your reply' });
  if (event && (event.conference?.url || event.htmlLink))
    items.push({ kind: 'item', id: 'copyLink', label: 'Copy link' });
  if (entry.persisted) items.push({ kind: 'item', id: 'hide', label: 'Hide in Aplos' });
  // Delete only on a stored event you may delete (DESIGN 7.8 Fixes; acceptance 6).
  if (entry.persisted && (event ? event.can.delete && !calendar?.readOnly : editable)) {
    items.push({ kind: 'separator' });
    items.push({
      kind: 'item',
      id: 'delete',
      label: 'Delete',
      commandId: 'calendar.delete',
      danger: true,
    });
  }
  return items;
}
