import type {
  Anchor,
  Announce,
  CommandAction,
  CommandId,
  IsoDate,
  IsoDateTime,
  IsoTime,
  IsoYearMonth,
  TagColor,
} from './shared';

/* ───────────────────────── calendar ───────────────────────── */

/** The five fixed presets, digits 1–5 (DESIGN §7.3). */
export type DatePresetId = 'evening' | 'tomorrow' | 'weekend' | 'nextWeek' | 'someday';

/** One preset with the moment it resolves to. */
export interface DatePresetOption {
  /** Which preset; its label ("Today evening", "Tomorrow", "This weekend", "Next week", "Someday") is fixed copy. */
  id: DatePresetId;
  /** Resolved moment shown dim on the right; absent for Someday. */
  at?: IsoDateTime;
}

/** Presets 1–5 with digits always visible, "Pick a date…" with a month calendar and time, Return to confirm (DESIGN §6 DatePresets, §7.3). Shown in a Menu-like popover. Mockups: later-picker.html (default, calendar). Plain: ui-foundation; refines: ui-calendar; used by ui-home. */
export interface DatePresetsProps {
  /** Whether it is shown (`reveal`). */
  open: boolean;
  /** Element it opens from, e.g. the focus letter's Later button (`FocusLetter.onLater(anchor)`). */
  anchor: Anchor;
  /** 'later' titles it "Later until"; 'due' sets a due date (D). */
  purpose: 'later' | 'due';
  /** The five presets in order. */
  presets: readonly DatePresetOption[];
  /** Highlighted entry: a preset or the date picker. */
  activeId: DatePresetId | 'date';
  /** Highlight moved. */
  onActiveChange: (id: DatePresetId | 'date') => void;
  /** A preset was chosen (digit, Return or click). */
  onPick: (id: DatePresetId) => void;
  /** The calendar under "Pick a date…" is open. */
  calendarOpen: boolean;
  /** Month the calendar shows. */
  month: IsoYearMonth;
  /** Month changed. */
  onMonthChange: (month: IsoYearMonth) => void;
  /** Picked day. */
  pickedDate?: IsoDate;
  /** Day picked (arrows or click). */
  onPickDate: (date: IsoDate) => void;
  /** Picked time, default "08:00". */
  pickedTime: IsoTime;
  /** Time changed. */
  onTimeChange: (time: IsoTime) => void;
  /** Return on the picked date. */
  onConfirmDate: () => void;
  /** Esc or outside click. */
  onClose: () => void;
}

/** A calendar's identity. */
export interface CalendarInfo {
  /** Stable id. */
  id: string;
  /** Name, e.g. "Work". */
  name: string;
  /** Swatch colour (DESIGN §4.2). */
  color: TagColor;
  /** Shown on the grid. */
  visible: boolean;
  /** Nothing can be added to it from here (the demo calendars): the list says "View only". */
  readOnly?: boolean;
}

/** A small month in the sidebar on Calendar; out-of-month days `--dim`; today a filled accent badge (DESIGN §6 MiniMonth, §7.8). Mockups: calendar-*.html (shell.js miniMonth). Plain: ui-foundation; refines: ui-calendar. */
export interface MiniMonthProps {
  /** Month shown. */
  month: IsoYearMonth;
  /** Today. */
  today: IsoDate;
  /** The range the grid shows (a week band, or one day). */
  range?: { start: IsoDate; end: IsoDate };
  /** First weekday from the locale: 0 Sunday, 1 Monday. */
  weekStartsOn: 0 | 1;
  /** Previous / next month. */
  onMonthChange: (month: IsoYearMonth) => void;
  /** A day was picked. */
  onPick: (date: IsoDate) => void;
  /** Days with at least one event in a visible calendar; drawn as a quiet `--dim` mark under the number, never a colour (gap list C15). Omit for none. */
  marks?: readonly IsoDate[];
}

/** The "Calendars" list with colour swatches, the calendar legend; ⌥-click shows one alone (DESIGN §6 CalendarList, §7.1, §7.8). Mockups: calendar-*.html (shell.js). Plain: ui-foundation; refines: ui-calendar. */
export interface CalendarListProps {
  /** Calendars in order. */
  calendars: readonly CalendarInfo[];
  /** Show or hide one. */
  onToggle: (id: string) => void;
  /** ⌥-click: show this one alone. */
  onSolo: (id: string) => void;
}

/** A calendar entry from the data layer. */
export interface CalendarEventData {
  /** Stable id. */
  id: string;
  /** Title. */
  title: string;
  /** Start. */
  start: IsoDateTime;
  /** End. */
  end: IsoDateTime;
  /** All-day event. */
  allDay?: boolean;
  /** Its calendar. */
  calendar: Pick<CalendarInfo, 'id' | 'name' | 'color'>;
  /** Place, shown in wide day columns. */
  place?: string;
  /** 'event' = on a calendar; 'plan' = found in mail, not added yet (PlanOutline). */
  kind: 'event' | 'plan';
  /** An invite still waiting for your answer (Y/M/N apply). */
  unanswered?: boolean;
  /** Saved on the server; Delete appears only on persisted events (DESIGN §7.8 Fixes). */
  persisted: boolean;
  /** For plans: the mail it came from. */
  source?: { from: string; subject: string; threadId: string };
  /** Video call link shown in the detail, e.g. "meet.google.com/abc-defg-hij". */
  video?: string;
  /** Guests with their replies (EventDetail). */
  guests?: readonly EventGuest[];
  /** You organise it: ⋯ offers edit and delete; otherwise change your reply and hide. */
  isOrganizer?: boolean;
  /** Your own reply to an invite; null = not answered yet. */
  myReply?: RsvpAnswer | null;
  /** The invite email: "Invite from Priya" link (O). */
  invite?: { from: string; threadId: string };
  /** Plain-text description. */
  description?: string;
  /** One occurrence of a repeating event: moving, resizing, deleting or answering asks for a scope first (ScopeChooser, freeze finding FR-21). */
  recurring?: boolean;
  /** Read-only here: a read-only calendar, or an invite you don't organise. The grid offers no drag to move and no resize handle; selecting and opening still work. */
  locked?: boolean;
}

/** Which occurrences a change or an answer touches. Round 1 offers "This event" and "All events" (roadmap 8.3 #32); the contract's EditScope 'following' is refused until built. */
export type EventScope = 'occurrence' | 'series';

/** Asks which occurrences of a repeating event a change touches: "This event" (Return, the default) or "All events" (⇧Return), Esc cancels (DESIGN §7.8; roadmap 8.3 #32; freeze finding FR-21). Plain + refines: ui-foundation; used by ui-calendar before Event/set or Event/rsvp on a recurring event. */
export interface ScopeChooserProps {
  /** What is about to change; picks the question ("Move", "Change", "Delete", "Reply to"). */
  action: 'move' | 'change' | 'delete' | 'reply';
  /** The event title, for the accessible name. */
  title: string;
  /** A scope was chosen. */
  onChoose: (scope: EventScope) => void;
  /** Esc or Cancel. */
  onCancel: () => void;
}

/** An RSVP answer (Y / M / N, DESIGN §7.8). */
export type RsvpAnswer = 'yes' | 'maybe' | 'no';

/** One guest line: "Going", "Maybe", "Declined", "Not answered" (calendar-event.html; DESIGN 10 bans "No reply yet"). */
export interface EventGuest {
  /** Display name. */
  name: string;
  /** Their reply. */
  status: 'going' | 'maybe' | 'declined' | 'none';
  /** The owner: the role reads "(you)" (or "(you) · Organizer"). */
  isYou?: boolean;
  /** The organizer: the role reads "Organizer". */
  isOrganizer?: boolean;
}

/** Views of the grid; 'agenda' is the narrow-pane list and the Today tab (DESIGN §7.7 Today, §7.8 Narrow). */
export type CalendarView = 'day' | 'week' | 'month' | 'agenda';

/** The calendar grid: `--line` hairlines, 56 px per hour (the whole day is drawn and scrolls; it opens at 8 AM, or at now when today is shown), today column `--today-tint`, now-line, overlap lanes with a "+N" stack, drag to create, move or resize with `lift` and `snap` (DESIGN §6 CalendarGrid, §7.8). Mockups: calendar-week.html (default, overlap), calendar-day.html (default, empty), calendar-event.html, ask.html (today). Plain + refines: ui-calendar. */
export interface CalendarGridProps {
  /** View. */
  view: CalendarView;
  /** First day shown (or the month's first day for 'month'). */
  start: IsoDate;
  /** Entries in range. */
  events: readonly CalendarEventData[];
  /** Now, for the now-line and today column. */
  now: IsoDateTime;
  /** First weekday from the locale. */
  weekStartsOn: 0 | 1;
  /** Selected entry. */
  selectedId?: string;
  /** Click or ↑/↓: select. */
  onSelect: (id: string) => void;
  /** Double-click or Return: open the detail. */
  onOpen: (id: string, anchor: HTMLElement) => void;
  /** Drag on empty grid: create. */
  onCreate: (range: { start: IsoDateTime; end: IsoDateTime }) => void;
  /** Drag an entry to a new time. */
  onMove: (id: string, range: { start: IsoDateTime; end: IsoDateTime }) => void;
  /** Drag an entry's end. */
  onResize: (id: string, end: IsoDateTime) => void;
  /** A "+N" stack was opened; the screen shows a Menu of these ids. */
  onOpenStack: (ids: readonly string[], anchor: HTMLElement) => void;
  /** Empty day: "Nothing scheduled" with this action (New event · N, DESIGN §7.14). */
  emptyAction?: CommandAction;
  /** View 'agenda' only: 'today' = the Today tab's compact agenda (header "Thursday, October 29 · 4 events · next at 11:00 AM", next event, the following two, free gaps, now line); 'full' = the narrow-pane calendar list. Default 'full'. */
  agenda?: 'today' | 'full';
  /** Accessible name for the `grid`, e.g. "Week of October 25, 2026". */
  label: string;
  /** Announces range and selection changes (DESIGN §11.3). */
  announce?: Announce;
  /** Day and week views: the hour (0–24, fractions allowed) at the top of the grid when it opens. Default: 8, or an hour before now when today is shown. Applied on mount and when `view` changes, never when paging, so the reader keeps their place. */
  scrollToHour?: number;
}

/** Where the grid placed an entry among overlapping lanes; lanes are never under 44 px (DESIGN §7.8). */
export interface EventPlacement {
  /** 0-based lane. */
  lane: number;
  /** Lanes in this overlap cluster. */
  lanes: number;
  /** A wide day column: the time line adds the place. */
  wide: boolean;
}

/** One entry on the grid: radius 6, a 2 px leading rule in the calendar colour, the §4.2 fill, title `small` 500, time `--dim` (dark `--ink-2`); under 30 minutes is one line; or the "+N" stack (DESIGN §6 EventBlock, §7.8). Rendered by CalendarGrid. Mockups: calendar-week.html, calendar-day.html. Plain + refines: ui-calendar. */
export type EventBlockProps =
  | {
      /** A single event. */
      kind: 'event';
      /** The event (kind 'event'). */
      event: CalendarEventData;
      /** Lane placement. */
      placement: EventPlacement;
      /** Selected (`aria-pressed`). */
      selected: boolean;
      /** Select. */
      onSelect: () => void;
      /** Open the detail. */
      onOpen: (anchor: HTMLElement) => void;
      /** Locked: no drag or resize affordance (`data-locked`, no move cursor). Defaults to `event.locked`. */
      locked?: boolean;
    }
  | {
      /** The "+N" stack for the third and later overlapping events. */
      kind: 'stack';
      /** Ids folded into the stack. */
      ids: readonly string[];
      /** Earliest start in the stack. */
      start: IsoDateTime;
      /** Latest end in the stack. */
      end: IsoDateTime;
      /** Colour of the first folded event. */
      color: TagColor;
      /** Open the stack menu. */
      onOpen: (anchor: HTMLElement) => void;
    };

/** A plan found in mail on the grid: dashed 1 px outline and a "From mail" label until confirmed (DESIGN §6 PlanOutline, §7.8, §11.1). Rendered by CalendarGrid. Mockups: calendar-week.html (launch prep). Plain + refines: ui-calendar. */
export interface PlanOutlineProps {
  /** The plan (kind 'plan', with `source`). */
  plan: CalendarEventData;
  /** Lane placement. */
  placement: EventPlacement;
  /** Selected. */
  selected: boolean;
  /** Select. */
  onSelect: () => void;
  /** Open the detail (which offers confirm and the source email). */
  onOpen: (anchor: HTMLElement) => void;
}

/** The event detail: title with ⋯ ("More: edit, delete" / "change your reply, hide") and optional close; when line; calendar swatch; video link; place; "Invite from Priya" (O); the "Going?" RSVP Puck with "Send reply" disabled until chosen; Guests; description; for a plan, confirm and the source email (DESIGN §7.8). Mockups: calendar-event.html (detail, rsvp; cal.js detail()), calendar-day.html (`.day-rail`). Plain + refines: ui-calendar. */
export interface EventDetailProps {
  /** The entry. */
  event: CalendarEventData;
  /** 'popover' = content for a Popover from the grid; 'rail' = the day view's persistent side rail. */
  presentation: 'popover' | 'rail';
  /** RSVP block for an unanswered or changeable invite; Y/M/N answer only while it shows. */
  reply?: {
    /** Chosen answer; null shows no thumb and keeps "Send reply" disabled. */
    answer: RsvpAnswer | null;
    /** Registry ids for Y, M and N. */
    commands: { yes: CommandId; maybe: CommandId; no: CommandId };
    /** An answer was chosen. */
    onAnswer: (answer: RsvpAnswer) => void;
    /** "Send reply"; for a recurring event the screen asks ScopeChooser first and passes the scope. */
    onSend: (scope?: EventScope) => void;
  };
  /** Open the invite email (O). */
  onOpenInvite?: (threadId: string) => void;
  /** Open the video link. */
  onOpenVideo?: () => void;
  /** A plan: add it to the calendar (it stops being an outline). */
  onConfirmPlan?: () => void;
  /** Open a plan's source email. */
  onOpenSource?: (threadId: string) => void;
  /** ⋯; the element anchors its Menu. */
  onMore: (anchor: HTMLElement) => void;
  /** Close (×, Esc); omit to hide the button (the rail). */
  onClose?: () => void;
}

/** The now-line: 1 px `--stamp` with a 5 px cap; it may cross event text (DESIGN §6 NowLine, §7.8). Mockups: calendar-week.html, calendar-day.html, ask.html (today agenda). Plain + refines: ui-calendar. */
export interface NowLineProps {
  /** Now. */
  now: IsoDateTime;
  /** 'grid' = across the today column; 'agenda' = a row with the time label (Today tab). */
  variant: 'grid' | 'agenda';
}
