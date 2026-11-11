/**
 * Harness states for the Calendar screen (DESIGN 7.8, 7.14; plan 30 U7 acceptance 6): every state the visual
 * harness captures, drawn by `CalendarView` from hand-written contract values through the same reducer the
 * container uses, so the gallery is clickable too. Original demo data only: invented people on example domains.
 * The clock is the harness's, 2026-10-29 10:00 in America/Los_Angeles (`HARNESS_NOW_MS`); the capture runs in
 * that zone. `loading` is the opening moment (no spinner for a local read, DESIGN 5 rule 12) and `error` the
 * failed events window.
 *
 * The shell's sidebar slot draws the MiniMonth and Calendars list at runtime; the states are standalone, so they draw
 * the same `calendarSidebar` props in a plain aside for the shots to show the whole screen as DESIGN 7.8 intends.
 */
import { useMemo, useRef, useState, type JSX } from 'react';
import {
  HARNESS_NOW_MS,
  toIsoDate,
  type Account,
  type Calendar,
  type EpochMs,
  type Event,
  type Plan,
} from '../../data';
import { CalendarList, MiniMonth } from '../../ui/calendar';
import type { CalendarEventData } from '../../ui/props';
import { Pane, Toast } from '../../ui/surfaces';
import { ErrorLine } from '../../ui/list';
import {
  defaultCalendarId,
  draftFromEvent,
  EMPTY_OVERLAY,
  entriesFor,
  eventsRange,
  initialState,
  localMs,
  newDraft,
  overlayWith,
  periodOf,
  planEntryId,
  shownView,
  update,
  viewModel,
  type CalendarAction,
  type CalendarContext,
  type CalendarState,
  type Overlay,
} from './calendar.model';
import { CALENDAR_PANE_TOOLS, CalendarView } from './CalendarView';
import { CALENDAR_EVENTS_SCOPE } from './accountCalendarState';
import type { FailedHold } from './FailedHolds';
import { calendarSidebar } from './sidebar';

const noop = () => {};

// ---------------------------------------------------------------------------
// The demo world: Alex Moreno's calendars, the week of October 25, 2026
// ---------------------------------------------------------------------------

const ME = { address: 'alex.moreno@example.com', name: 'Alex Moreno' };

function calendar(
  id: string,
  name: string,
  colorTag: string,
  extra: Partial<Calendar> = {},
): Calendar {
  return {
    id,
    accountId: 'acct-alex',
    name,
    colorTag,
    primary: false,
    readOnly: false,
    shown: true,
    providerHidden: false,
    ...extra,
  };
}

const WORK = calendar('work', 'Work', 'hill', { primary: true });
const PERSONAL = calendar('personal', 'Personal', 'sky');
const HOLLOW = calendar('hollow', 'Hollow Creek', 'ember');
const FAMILY = calendar('family', 'Family', 'sand');
const HOLIDAYS = calendar('holidays', 'Holidays', 'dusk', { readOnly: true });
const CALENDARS: readonly Calendar[] = [WORK, PERSONAL, HOLLOW, FAMILY];

/** A Google account for the sidebar's accounts block; `over` makes the state under test. */
function googleAccount(id: string, address: string, over: Partial<Account> = {}): Account {
  return {
    id,
    rev: 1,
    provider: 'google',
    address,
    name: address,
    colorTag: 'sky',
    demo: false,
    health: { status: { state: 'ok' }, lastSyncAt: HARNESS_NOW_MS - 120_000 },
    capabilities: {
      labels: true,
      folders: false,
      drafts: true,
      serverSearch: true,
      calendar: true,
      filters: true,
      push: true,
      sendAs: true,
      unsubscribeHeaders: true,
    },
    grantedScopes: [],
    aiAllowed: true,
    notifications: true,
    identities: [],
    pendingChanges: 0,
    baselineDoneAt: HARNESS_NOW_MS - 86_400_000,
    calendarListedAt: HARNESS_NOW_MS - 86_400_000,
    createdAt: HARNESS_NOW_MS - 30 * 86_400_000,
    ...over,
  };
}

const ALEX_ACCOUNT = googleAccount('acct-alex', 'alex.moreno@example.com', {
  name: 'Alex Moreno',
  // A connected Google account in the demo world holds the write grant, so the editing gate stays quiet.
  grantedScopes: [CALENDAR_EVENTS_SCOPE],
});
/** Read access, no write grant: the sidebar stays quiet but an event's detail offers 'Turn on editing'. */
const JORDAN_READ = googleAccount('acct-jordan', 'jordan.lee@example.com', {
  name: 'Jordan Lee',
  colorTag: 'hill',
});
const JORDAN_NO_CALENDAR = googleAccount('acct-jordan', 'jordan.lee@example.com', {
  name: 'Jordan Lee',
  colorTag: 'hill',
  capabilities: { ...googleAccount('a', 'a@e.c').capabilities, calendar: false },
  missingPermissions: [{ capability: 'calendar', reasonCode: 'permission.calendar' }],
});
const JORDAN_SIGNIN = googleAccount('acct-jordan', 'jordan.lee@example.com', {
  name: 'Jordan Lee',
  colorTag: 'hill',
  health: {
    status: { state: 'needsReauth', reason: 'invalid_grant' },
    reasonCode: 'auth.expired',
  },
});

type Person = { address: string; name: string };
const person = (name: string, domain = 'example.com'): Person => ({
  name,
  address: `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@${domain}`,
});
const MINA = person('Mina Cho', 'example.org');
const JORDAN = person('Jordan Park', 'example.org');
const PRIYA = person('Priya Raman', 'example.net');
const THEO = person('Theo Lindqvist');
const LEAH = person('Leah Okafor');

type Reply = 'accepted' | 'tentative' | 'declined' | 'needsAction';
const guest = (p: Person, response: Reply, role: { organizer?: boolean; self?: boolean } = {}) => ({
  address: p.address,
  name: p.name,
  response,
  organizer: role.organizer ?? false,
  self: role.self ?? false,
});

const OWN = { edit: true, move: true, delete: true, rsvp: false, editGuests: true };
const INVITED = { edit: false, move: false, delete: false, rsvp: true, editGuests: false };

/** One event at local wall-clock times; `end` may be "24:00" or a later day as "YYYY-MM-DDTHH:MM". */
function ev(
  id: string,
  title: string,
  cal: Calendar,
  date: string,
  start: string,
  end: string,
  extra: Partial<Event> = {},
): Event {
  const endMs = end.includes('T') ? localMs(end.slice(0, 10), end.slice(11)) : localMs(date, end);
  return {
    id,
    rev: 1,
    accountId: cal.accountId,
    calendarId: cal.id,
    recurring: false,
    exception: false,
    title,
    start: { type: 'utc', utc: localMs(date, start) },
    end: { type: 'utc', utc: endMs },
    allDay: false,
    attendees: [],
    status: 'confirmed',
    can: OWN,
    sync: 'synced',
    ...extra,
  };
}

function allDay(
  id: string,
  title: string,
  cal: Calendar,
  first: string,
  last: string,
  extra: Partial<Event> = {},
): Event {
  const next = new Date(localMs(last, '00:00'));
  next.setDate(next.getDate() + 1);
  return {
    ...ev(id, title, cal, first, '00:00', '00:00', extra),
    start: { type: 'date', date: first },
    end: { type: 'date', date: toIsoDate(next.getTime()) },
    allDay: true,
    ...extra,
  };
}

/** Mon to Thu standups from October 5 to November 26: one series, occurrences keyed `<seriesId>@<originalStart>`. */
function standups(): Event[] {
  const out: Event[] = [];
  for (let d = new Date(2026, 9, 5); d < new Date(2026, 10, 27); d.setDate(d.getDate() + 1)) {
    const dow = d.getDay();
    if (dow < 1 || dow > 4) continue;
    const day = toIsoDate(d.getTime());
    const start = localMs(day, '11:00');
    out.push(
      ev(`standup@${start}`, 'Standup', WORK, day, '11:00', '11:15', {
        seriesId: 'standup',
        originalStart: { type: 'utc', utc: start },
        recurring: true,
        organizer: guest(ME, 'accepted', { organizer: true, self: true }),
        attendees: [
          guest(ME, 'accepted', { organizer: true, self: true }),
          guest(PRIYA, 'accepted'),
          guest(MINA, 'accepted'),
        ],
        conference: { url: 'https://meet.example.com/standup' },
        recurrence: { rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH', text: 'Every weekday but Friday' },
      }),
    );
  }
  return out;
}

const STANDUPS = standups();
const standupOn = (day: string): Event => STANDUPS.find(e => toIsoDate(msStart(e)) === day)!;
function msStart(e: Event): EpochMs {
  return e.start.type === 'utc' ? e.start.utc : 0;
}

const DESIGN_REVIEW = ev(
  'design',
  'Design review with Mina and Jordan',
  HOLLOW,
  '2026-10-29',
  '14:00',
  '14:30',
  {
    organizer: guest(ME, 'accepted', { organizer: true, self: true }),
    attendees: [
      guest(ME, 'accepted', { organizer: true, self: true }),
      guest(MINA, 'accepted'),
      guest(JORDAN, 'accepted'),
    ],
    myResponse: 'accepted',
    conference: { url: 'https://meet.example.com/design-review' },
    description:
      'Walk through the two layout directions and pick one. Jordan needs a decision by Friday so the build can start Monday.',
  },
);

const Q4_REVIEW = ev('q4', 'Q4 review', WORK, '2026-10-30', '11:00', '12:00', {
  organizer: guest(PRIYA, 'accepted', { organizer: true }),
  attendees: [
    guest(PRIYA, 'accepted', { organizer: true }),
    guest(MINA, 'tentative'),
    guest(ME, 'needsAction', { self: true }),
  ],
  myResponse: 'needsAction',
  can: INVITED,
  lockedReason: 'Only Priya can change this event.',
  conference: { url: 'https://meet.example.com/q4-review' },
  invite: { threadId: 'thread-q4', messageId: 'msg-q4', fromName: 'Priya Raman' },
  description:
    'Walk through the Q4 deck and agree on next quarter’s priorities. Bring the revised numbers.',
});

/** Jordan's readable calendar and its event: the account's grant lacks the write scope (write states). */
const JORDAN_CAL = calendar('jordan-work', 'Jordan’s Work', 'hill', {
  accountId: 'acct-jordan',
});
const JORDAN_SYNC = ev('jordansync', 'Team sync', JORDAN_CAL, '2026-10-29', '13:00', '13:30', {
  description: 'Weekly sync across the two teams.',
});

const WEEK: readonly Event[] = [
  ev('brunch', 'Brunch with Mom', FAMILY, '2026-10-25', '10:00', '11:30'),
  ev('samples', 'Type samples with Mina', HOLLOW, '2026-10-26', '13:00', '14:00'),
  ev('planning', 'Hollow Creek planning', HOLLOW, '2026-10-27', '10:30', '11:30'),
  ev('pottery', 'Pottery wheel class', PERSONAL, '2026-10-27', '18:30', '20:00'),
  ev('focus', 'Focus time', WORK, '2026-10-28', '10:00', '12:00'),
  ev('sami', 'Call Sami about the lease', PERSONAL, '2026-10-28', '15:00', '15:30'),
  ev('dental', 'Northwind Dental', PERSONAL, '2026-10-29', '09:30', '10:30', {
    location: 'Northwind Dental, 14 Alder Street',
    description: 'Cleaning. Arrive five minutes early.',
  }),
  DESIGN_REVIEW,
  ev('climb', 'Climbing with Theo', PERSONAL, '2026-10-29', '17:30', '19:00', {
    location: 'The climbing gym on Mill Road',
    organizer: guest(ME, 'accepted', { organizer: true, self: true }),
    attendees: [guest(ME, 'accepted', { organizer: true, self: true }), guest(THEO, 'accepted')],
  }),
  Q4_REVIEW,
  ev('lunch', 'Lunch with Leah', PERSONAL, '2026-10-30', '12:30', '13:30', {
    location: 'Somewhere quiet, still to pick',
    organizer: guest(ME, 'accepted', { organizer: true, self: true }),
    attendees: [guest(ME, 'accepted', { organizer: true, self: true }), guest(LEAH, 'accepted')],
    description: 'Lunch for six. Leah asked for vegetarian options.',
  }),
  ev('garden', 'Garden shift with Ana', PERSONAL, '2026-10-31', '10:00', '12:00'),
  ev('lease', 'Lease renewal due', PERSONAL, '2026-11-04', '09:00', '09:30'),
  ev('dinner', 'Birthday dinner for Mom', FAMILY, '2026-11-07', '19:00', '21:00'),
  ev('workshop', 'Letterpress workshop', PERSONAL, '2026-10-10', '10:00', '13:00'),
  ev('vet', 'Vet visit for Biscuit', FAMILY, '2026-10-14', '16:00', '16:45'),
  ev('offsite', 'Studio offsite planning', WORK, '2026-10-21', '13:00', '15:00'),
  ...STANDUPS,
];

const ONE_ON_ONE = ev('oneone', '1:1 with Mina', HOLLOW, '2026-10-28', '11:00', '11:45');

const LAUNCH_PREP: Plan = {
  id: 'launch',
  rev: 1,
  threadId: 'thread-launch',
  messageId: 'msg-launch',
  fromName: 'Jordan Park',
  quote: 'If we lock it by Friday, Mina can start the build on Monday.',
  title: 'Hollow Creek launch prep',
  start: { type: 'utc', utc: localMs('2026-10-30', '15:00') },
  end: { type: 'utc', utc: localMs('2026-10-30', '16:30') },
  allDay: false,
  state: 'open',
};

const HALLOWEEN = allDay('halloween', 'Halloween', HOLIDAYS, '2026-10-31', '2026-10-31', {
  can: { edit: false, move: false, delete: false, rsvp: false, editGuests: false },
  htmlLink: 'https://calendar.example.com/event/halloween',
});

// ---------------------------------------------------------------------------
// Worst case (break-ui): 12 overlapping events, a 200-character title, non-Latin titles, DST day 2026-11-01
// ---------------------------------------------------------------------------

const LONG_TITLE =
  'Quarterly planning and budget alignment session with the whole studio, the two freelance illustrators, the print shop liaison and the accountant, covering invoices, reprints, the spring catalogue and more';

const WORST: readonly Event[] = [
  // DST: clocks fall back at 2:00 AM on Sunday, November 1; 1:00 to 3:00 AM is three hours long.
  ev('dst-night', 'Night shift handover', WORK, '2026-11-01', '01:00', '03:00'),
  ev('dst-zero', 'Zero-minute reminder', PERSONAL, '2026-11-01', '09:00', '09:00'),
  ev('dst-tiny', 'Pill', PERSONAL, '2026-11-01', '12:00', '12:10'),
  ...Array.from({ length: 12 }, (_, i) =>
    ev(
      `crowd-${i + 1}`,
      `Interview slot ${i + 1}`,
      [WORK, PERSONAL, HOLLOW, FAMILY][i % 4],
      '2026-11-02',
      `${String(10 + Math.floor(i / 4)).padStart(2, '0')}:${String((i % 4) * 15).padStart(2, '0')}`,
      '13:00',
    ),
  ),
  ev('long', LONG_TITLE, HOLLOW, '2026-11-03', '09:00', '11:00', {
    location:
      'The big table upstairs at the studio, 221 Larkspur Avenue, second floor, past the drying racks',
    description: `${LONG_TITLE}. ${LONG_TITLE}.`,
    organizer: guest(ME, 'accepted', { organizer: true, self: true }),
    attendees: [
      guest(ME, 'accepted', { organizer: true, self: true }),
      ...[
        'Mina Cho',
        'Jordan Park',
        'Priya Raman',
        'Theo Lindqvist',
        'Leah Okafor',
        'Bartholomew Featherstonehaugh-Wilmington',
      ].map((n, i) =>
        guest(person(n), (['accepted', 'tentative', 'declined', 'needsAction'] as const)[i % 4]),
      ),
    ],
  }),
  ev('ja', '週次の振り返りミーティングと来期の計画について', WORK, '2026-11-04', '13:00', '14:00'),
  ev('ar', 'اجتماع مراجعة التصميم مع الفريق', HOLLOW, '2026-11-04', '15:00', '16:00'),
  ev('marathon', 'Print run, overnight', WORK, '2026-11-05', '08:00', '2026-11-06T20:00'),
  allDay('fair', 'Book fair in Portland', PERSONAL, '2026-11-05', '2026-11-07'),
  ev('late', 'Late call with the Sydney printer', WORK, '2026-11-06', '22:30', '23:59'),
];

// ---------------------------------------------------------------------------
// The harness: reducer, overlay and a frame like the main window
// ---------------------------------------------------------------------------

interface Fixture {
  title: string;
  /** Window size; the pane is the window less the 232 px sidebar and the 8 px inset. */
  width?: number;
  height?: number;
  now?: EpochMs;
  state: Partial<CalendarState>;
  events?: readonly Event[];
  plans?: readonly Plan[];
  calendars?: readonly Calendar[];
  /** The accounts the sidebar's block lists; default Alex alone, calendars granted and synced. */
  accounts?: readonly Account[];
  /** False makes the block say "Syncing…" (Account/get unanswered); default true. */
  accountsLoaded?: boolean;
  /** False keeps the calendars list unanswered, so a granted account reads "Syncing…"; default true. */
  calendarsLoaded?: boolean;
  /** Draw a pane state instead of the grid: 'loading' (the opening moment) or 'error' (the failed events window). */
  pane?: 'loading' | 'error';
  /** A notice toast over the pane, as the shell's stack would show it (the write failure surfaces). */
  toast?: { message: string; actions?: readonly { id: string; label: string }[] };
  /** Failed calendar holds the pane's quiet line and Review list draw (review19). */
  holds?: readonly FailedHold[];
}

function PreviewCalendar({ fixture }: { fixture: Fixture }) {
  const now = fixture.now ?? HARNESS_NOW_MS;
  const weekStartsOn = 0;
  const [state, setState] = useState<CalendarState>(() => ({
    ...initialState(toIsoDate(now)),
    ...fixture.state,
  }));
  const [overlay, setOverlay] = useState<Overlay>(EMPTY_OVERLAY);
  const [calendars, setCalendars] = useState<readonly Calendar[]>(fixture.calendars ?? CALENDARS);
  const events = fixture.events ?? WEEK;
  const plans = useMemo(() => fixture.plans ?? [LAUNCH_PREP], [fixture.plans]);
  const { from: periodFrom, to: periodTo } = periodOf(shownView(state), state.anchor, weekStartsOn);
  const defaultId = defaultCalendarId(calendars, undefined, state.solo);
  const entries = useMemo<CalendarEventData[]>(
    () =>
      entriesFor({
        events,
        plans,
        calendars,
        solo: state.solo,
        period: { from: periodFrom, to: periodTo },
        planCalendarId: defaultId,
        overlay,
      }),
    [events, plans, calendars, state.solo, periodFrom, periodTo, defaultId, overlay],
  );
  const ctx: CalendarContext = {
    now,
    weekStartsOn,
    entries,
    events: new Map(events.map(e => [e.id, e])),
    plans: new Map(plans.map(p => [p.id, p])),
    calendars,
    accounts: fixture.accounts ?? [ALEX_ACCOUNT],
    loadedThrough: eventsRange({ from: periodFrom, to: periodTo }, now).to,
    defaultCalendarId: defaultId,
    calendarsReady: true,
    windowReady: true,
    failedHolds: fixture.holds ?? [],
  };
  const stateRef = useRef(state);
  const ctxRef = useRef(ctx);
  stateRef.current = state;
  ctxRef.current = ctx;

  const dispatch = useMemo(
    () => (action: CalendarAction) => {
      const t = update(stateRef.current, action, ctxRef.current);
      stateRef.current = t.state;
      setState(t.state);
      for (const fx of t.effects) {
        if ('optimistic' in fx) setOverlay(o => overlayWith(o, 'preview', fx.optimistic));
        if (fx.kind === 'calendarSet')
          setCalendars(list => list.map(c => (c.id === fx.id ? { ...c, shown: fx.shown } : c)));
      }
    },
    [],
  );
  const sidebar = calendarSidebar({
    state,
    calendars,
    entries,
    today: toIsoDate(now),
    weekStartsOn,
    dispatch,
    accounts: fixture.accounts ?? [ALEX_ACCOUNT],
    accountsLoaded: fixture.accountsLoaded ?? true,
    calendarsLoaded: fixture.calendarsLoaded ?? true,
    onAccessAction: noop,
  });

  return (
    <div className="calp-window">
      <aside
        className="calp-sidebar"
        aria-label="Sidebar (drawn by ui-shell; the calendar block is this lane's data)"
      >
        <MiniMonth {...sidebar.miniMonth} />
        {sidebar.calendars ? <CalendarList {...sidebar.calendars} /> : null}
        {sidebar.calendarAccounts}
      </aside>
      <Pane
        kind="main"
        label="Calendar"
        header={{
          tools: CALENDAR_PANE_TOOLS,
          onTool: () => dispatch({ type: 'newEvent' }),
          ask: { pressed: false, scope: 'mail', onPress: noop },
          today: { pressed: false, onPress: noop },
        }}
      >
        {fixture.pane === 'error' ? (
          <ErrorLine kind="listFailed" placement="column" onAction={noop} />
        ) : fixture.pane === 'loading' ? null : (
          <CalendarView vm={viewModel(state, ctx)} dispatch={dispatch} />
        )}
      </Pane>
      {fixture.toast ? (
        <div className="calp-toast">
          <Toast
            id="calp-notice"
            kind="info"
            message={fixture.toast.message}
            actions={fixture.toast.actions ?? []}
            undoable={false}
            onAction={noop}
            onDismiss={noop}
          />
        </div>
      ) : null}
    </div>
  );
}

const THU = '2026-10-29';

/** What N makes on the harness's Thursday: the next free half hour after 10:00 AM, on Work. */
function newEventDraft() {
  const period = periodOf('week', THU, 0);
  const entries = entriesFor({
    events: WEEK,
    plans: [],
    calendars: CALENDARS,
    solo: null,
    period,
    planCalendarId: 'work',
  });
  return newDraft(THU, HARNESS_NOW_MS, entries, 'work');
}
const STANDUP_THU = standupOn(THU);

const FIXTURES: Record<string, Fixture> = {
  'week-default': {
    title: 'Week of October 25, today Thursday at 10:00 AM',
    state: { view: 'week' },
  },
  'week-overlap': {
    title: 'Three overlapping on Wednesday: Focus time beside a "+2" stack, its menu open',
    state: { view: 'week', stackIds: ['oneone', standupOn('2026-10-28').id] },
    events: [...WEEK, ONE_ON_ONE],
  },
  'week-today-now-line': {
    title: 'Now at 2:10 PM: the now-line crosses Design review in the today column',
    now: HARNESS_NOW_MS + (4 * 60 + 10) * 60_000,
    state: { view: 'week', selectedId: 'design' },
  },
  'day-default': {
    title: 'Thursday, the detail rail on Design review',
    state: { view: 'day', anchor: THU, selectedId: 'design' },
  },
  'day-empty': {
    title:
      'Sunday, November 1 (the DST day): Nothing on Sunday, November 1. Next: Standup, Monday. New event N',
    state: { view: 'day', anchor: '2026-11-01' },
  },
  'week-empty': {
    title: 'The week of December 6, nothing on it: A clear week. New event N',
    state: { view: 'week', anchor: '2026-12-09' },
  },
  month: {
    title: 'October 2026: six weeks, "2 more" on busy days, the event count beside the label',
    state: { view: 'month' },
  },
  'agenda-narrow': {
    title: 'Window 900 wide, pane under 720 px: the agenda list replaces the grid',
    width: 900,
    state: { view: 'week' },
  },
  'event-detail': {
    title: 'Design review open in the popover (yours: More offers edit and delete)',
    state: { view: 'week', selectedId: 'design', detailId: 'design' },
  },
  'event-rsvp-unanswered': {
    title: 'Q4 review invite: nothing chosen, Send reply disabled',
    state: { view: 'week', selectedId: 'q4', detailId: 'q4' },
  },
  'event-rsvp-chosen': {
    title: 'Q4 review invite: Yes chosen, Send reply enabled',
    state: {
      view: 'week',
      selectedId: 'q4',
      detailId: 'q4',
      rsvp: { eventId: 'q4', answer: 'yes', changing: false },
    },
  },
  'repeat-scope-chooser': {
    title: 'Moving Thursday’s Standup: This event or All events',
    state: {
      view: 'week',
      selectedId: STANDUP_THU.id,
      scope: {
        action: 'move',
        entryId: STANDUP_THU.id,
        pending: { kind: 'move', start: '2026-10-29T11:30:00', end: '2026-10-29T11:45:00' },
      },
    },
  },
  'editor-new': {
    title: 'N: a new event at the next free half hour, no Delete',
    state: { view: 'week', editor: newEventDraft() },
  },
  'editor-existing': {
    title: 'E on Design review: Delete shows because it is stored',
    state: { view: 'week', selectedId: 'design', editor: draftFromEvent(DESIGN_REVIEW) },
  },
  'plan-from-mail': {
    title: 'Hollow Creek launch prep, found in mail: dashed, From mail, Add to Calendar',
    state: { view: 'week', selectedId: planEntryId('launch'), detailId: planEntryId('launch') },
  },
  'read-only-calendar-event': {
    title: 'Halloween on the read-only Holidays calendar, More open: Edit disabled with the reason',
    state: { view: 'week', selectedId: 'halloween', detailId: 'halloween', moreOpen: true },
    events: [...WEEK, HALLOWEEN],
    calendars: [...CALENDARS, HOLIDAYS],
  },
  'sidebar-solo': {
    title: 'Family hidden, then Work shown alone with ⌥-click',
    state: { view: 'week', solo: 'work' },
    calendars: CALENDARS.map(c => (c.id === 'family' ? { ...c, shown: false } : c)),
  },
  'sidebar-accounts-on': {
    title: 'Accounts under the legend: Alex’s four calendars, “Calendar on · 4 calendars”',
    state: { view: 'week' },
  },
  'sidebar-accounts-not-allowed': {
    title: 'Alex’s calendars on, Jordan’s not allowed yet: the one-line Allow calendar access',
    state: { view: 'week' },
    accounts: [ALEX_ACCOUNT, JORDAN_NO_CALENDAR],
  },
  'sidebar-accounts-needs-signin': {
    title: 'Alex’s calendars on, Jordan’s sign-in expired: Needs sign-in again · Sign in again',
    state: { view: 'week' },
    accounts: [ALEX_ACCOUNT, JORDAN_SIGNIN],
  },
  'sidebar-accounts-syncing': {
    title: 'Jordan’s grant is in and its list is still arriving: Syncing…',
    state: { view: 'week' },
    events: [],
    plans: [],
    calendars: [],
    accounts: [
      googleAccount('acct-jordan', 'jordan.lee@example.com', {
        name: 'Jordan Lee',
        colorTag: 'hill',
        health: { status: { state: 'syncing' } },
        calendarListedAt: undefined,
      }),
    ],
  },
  'sidebar-accounts-no-calendars': {
    title: 'Jordan’s grant is in and the list answered empty: No calendars',
    state: { view: 'week' },
    events: [],
    plans: [],
    calendars: [],
    accounts: [
      googleAccount('acct-jordan', 'jordan.lee@example.com', {
        name: 'Jordan Lee',
        colorTag: 'hill',
        calendarListedAt: HARNESS_NOW_MS - 86_400_000,
      }),
    ],
  },
  'sidebar-accounts-pending': {
    title: 'Calendar/get has not answered: a granted account reads Syncing…',
    state: { view: 'week' },
    events: [],
    plans: [],
    calendars: [],
    calendarsLoaded: false,
  },
  'sidebar-accounts-none': {
    title: 'No accounts: the legend and the block both say so',
    state: { view: 'week' },
    events: [],
    plans: [],
    calendars: [],
    accounts: [],
  },
  'cal-loading': {
    title: 'Opening: nothing yet, and no spinner for a local read',
    state: {},
    pane: 'loading',
  },
  'cal-error': {
    title: 'The events window failed: "Couldn’t load this list." with Try again',
    state: {},
    pane: 'error',
  },
  'worst-case': {
    title:
      'Week of November 1: DST night, 12 overlapping, a 200-character title, non-Latin titles, 36-hour and all-day spans',
    state: { view: 'week', anchor: '2026-11-02' },
    events: [...WORST, ...STANDUPS],
    plans: [],
  },
  'worst-case-day': {
    title:
      'Tuesday, November 3: the rail on the 200-character title, seven guests and a long place',
    state: { view: 'day', anchor: '2026-11-03', selectedId: 'long' },
    events: [...WORST, ...STANDUPS],
    plans: [],
  },
  'worst-case-crowd-day': {
    title: 'Monday, November 2 in day view: lanes fold to "+N" at 44 px',
    state: { view: 'day', anchor: '2026-11-02' },
    events: [...WORST, ...STANDUPS],
    plans: [],
  },
  'worst-case-month': {
    title: 'November 2026 with the crowded Monday: "N more", never "1 more"',
    state: { view: 'month', anchor: '2026-11-02' },
    events: [...WORST, ...STANDUPS],
    plans: [],
  },
  'write-turn-on-editing': {
    title:
      'Team sync is Jordan’s, and the grant lacks the write scope: Turn on editing to change events · Enable editing',
    state: { view: 'week', selectedId: 'jordansync', detailId: 'jordansync' },
    events: [...WEEK, JORDAN_SYNC],
    calendars: [...CALENDARS, JORDAN_CAL],
    accounts: [ALEX_ACCOUNT, JORDAN_READ],
  },
  'write-conflict-reopened': {
    title: 'Design review save raced a remote change: the editor re-opened on the newer copy',
    state: {
      view: 'week',
      selectedId: 'design',
      editor: {
        ...draftFromEvent(DESIGN_REVIEW),
        error: "This event changed somewhere else. Your changes weren't saved.",
      },
    },
  },
  'write-uncertain': {
    title:
      'The write’s answer was lost: "We couldn’t confirm that went through. Check your calendar before trying again." — no Retry',
    state: { view: 'week', selectedId: 'design' },
    toast: {
      message: "We couldn't confirm that went through. Check your calendar before trying again.",
    },
  },
  'write-hold-failed-late': {
    title:
      'The held change never left: "That change wasn’t sent in time. Check the event, then send it again." — Retry sends the failed hold (Operation/retry), never the write again',
    state: { view: 'week', selectedId: 'design' },
    toast: {
      message: "That change wasn't sent in time. Check the event, then send it again.",
      actions: [
        { id: 'retry', label: 'Retry' },
        { id: 'dismiss', label: 'Dismiss' },
      ],
    },
  },
  'write-hold-refused': {
    title:
      'A second change while the earlier one is still waiting — the editor re-opens on the saved draft with why',
    state: {
      view: 'week',
      selectedId: 'design',
      editor: {
        ...draftFromEvent(DESIGN_REVIEW),
        error:
          "Your earlier change to this event hasn't been sent yet. Undo it, or try again once it has.",
      },
    },
  },
  'failed-holds-line': {
    title:
      'The held change failed after its toast left: "1 change didn’t send · Review" under the page head',
    state: { view: 'week' },
    holds: [
      {
        id: 'op:op-hold-design',
        opId: 'op-hold-design',
        reason: "That change wasn't sent in time. Check the event, then send it again.",
        canRetry: true,
        canDiscard: true,
        eventId: 'design',
      },
    ],
  },
  'failed-holds-list': {
    title:
      'Review open: Design review offers Retry and Discard, Lunch with Leah (a dead grant) Discard only',
    state: { view: 'week', holdsReview: true },
    holds: [
      {
        id: 'op:op-hold-design',
        opId: 'op-hold-design',
        reason: "That change wasn't sent in time. Check the event, then send it again.",
        canRetry: true,
        canDiscard: true,
        eventId: 'design',
      },
      {
        id: 'op:op-hold-lunch',
        opId: 'op-hold-lunch',
        reason: 'Sign in to Google again to send this change.',
        canRetry: false,
        canDiscard: true,
        eventId: 'lunch',
      },
    ],
  },
};

export interface CalendarPreviewState {
  title: string;
  width: number;
  height: number;
  render: () => JSX.Element;
}

export const calendarStates: Record<string, CalendarPreviewState> = Object.fromEntries(
  Object.entries(FIXTURES).map(([name, fixture]) => [
    name,
    {
      title: fixture.title,
      width: fixture.width ?? 1440,
      height: fixture.height ?? 900,
      render: () => <PreviewCalendar fixture={fixture} />,
    },
  ]),
);

/** For tests: the demo world as contract values. */
export const demoWorld = {
  calendars: CALENDARS,
  events: WEEK,
  accounts: [ALEX_ACCOUNT],
  plans: [LAUNCH_PREP],
  worst: WORST,
  holidays: HOLIDAYS,
  halloween: HALLOWEEN,
};
