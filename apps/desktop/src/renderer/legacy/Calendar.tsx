import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  ExternalLink,
  Mail,
  MapPin,
  Plus,
  SquarePen,
  Trash2,
  Users,
  X,
} from './icons';
import type { Account, CalendarEvent, CalendarInfo, Thread } from '@aplos/contract/legacy/types';
import { invoke, openUrl, uid } from './bridge';
import {
  Button,
  Checkbox,
  Dialog,
  DialogClose,
  Field,
  IconButton,
  Notice,
  Popover,
  Select,
  Spinner,
  Tabs,
  confirmAction,
  cx,
  dialogOpen,
  duration,
  reducedMotion,
  toast,
  useHandlers,
  useLatest,
} from './ui';
import {
  addDays,
  clock,
  dayKey,
  localInput,
  moveStart,
  parseGuests,
  setAllDay as withAllDay,
  shortClock,
  shortRange,
  slotOn,
  timeRange,
  ymd,
} from './calendarTime';
import {
  allDayLanes,
  calendarIndex,
  clashes,
  emailContext,
  eventsOnDay,
  layoutDay,
  mergeCalendars,
  planKey,
  plansToReview,
  shiftAnchor,
  viewDays,
  visibleEvents,
  type CalendarSource,
  type CalendarView,
} from './calendarLayout';
import {
  fadeIn,
  flip,
  hourLimits,
  openingHour,
  usePeriodSlide,
  usePeriodSwipe,
  zoomHour,
  zoomScroll,
  type Box,
} from './calendarMotion';
import { dismissPlans, usePlans } from './detectedPlans';
import { liveAction } from '@aplos/contract/legacy/mailbox';

export function EventEditor({
  event,
  accounts,
  onClose,
  notify,
}: {
  event: Partial<CalendarEvent>;
  accounts: Account[];
  onClose: () => void;
  notify: (s: string) => void;
}) {
  const [value, setValue] = useState<CalendarEvent>(() => ({
    id: event.id || uid(),
    accountId: event.accountId || accounts[0]?.id,
    calendarId: 'primary',
    title: '',
    ...slotOn(new Date()),
    allDay: false,
    location: '',
    description: '',
    guests: [],
    ...event,
  }));
  const [calendars, setCalendars] = useState<{ id: string; name: string; accountId: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [guestText, setGuestText] = useState((event.guests ?? []).join(', '));
  const [typingGuests, setTypingGuests] = useState(false);
  const [open, setOpen] = useState(true);
  useEffect(() => {
    invoke<typeof calendars>('calendar.list', { accountId: value.accountId })
      .then(list => {
        setCalendars(list);
        if (list.length)
          setValue(current =>
            list.some(c => c.id === current.calendarId)
              ? current
              : { ...current, calendarId: list[0].id },
          );
      })
      .catch(e => setError(e.message));
  }, [value.accountId]);
  function close() {
    setOpen(false);
    setTimeout(onClose, 120);
  }
  const { guests, invalid: badGuests } = parseGuests(guestText);
  const backwards = +new Date(value.end) <= +new Date(value.start);
  const setStart = (next: string) => setValue(v => moveStart(v, next));
  const setAllDay = (allDay: boolean) => setValue(v => withAllDay(v, allDay));
  async function save() {
    setBusy(true);
    try {
      if (!value.title.trim()) throw new Error('Give this event a title.');
      if (backwards) throw new Error('End time must be after start time.');
      if (badGuests.length)
        throw new Error(
          `Check ${badGuests.length === 1 ? 'this guest address' : 'these guest addresses'}: ${badGuests.join(', ')}`,
        );
      await invoke('calendar.save', { event: { ...value, guests } });
      notify('Calendar updated');
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onClose={close} label="Calendar event" className="event-editor">
      <header>
        <div className="title-with-icon">
          <CalendarDays size={19} />
          <strong>{event.id ? 'Event details' : 'Add to calendar'}</strong>
        </div>
        <DialogClose label="Close event" onClick={close} />
      </header>
      <div className="event-fields">
        <input
          className="event-title"
          aria-label="Event title"
          placeholder="Event title"
          autoFocus
          value={value.title}
          onChange={e => setValue({ ...value, title: e.target.value })}
        />
        <div className="field-grid">
          <Field label="Account">
            <Select
              variant="field"
              label="Account"
              value={value.accountId}
              options={accounts.map(a => [a.id, a.email] as [string, string])}
              onChange={accountId => setValue({ ...value, accountId, calendarId: 'primary' })}
            />
          </Field>
          <Field label="Calendar">
            <Select
              variant="field"
              label="Calendar"
              value={value.calendarId}
              options={
                calendars.length
                  ? calendars.map(c => [c.id, c.name] as [string, string])
                  : [['primary', 'Primary calendar']]
              }
              onChange={calendarId => setValue({ ...value, calendarId })}
            />
          </Field>
        </div>
        <div className="field-grid">
          <Field label="Starts">
            <input
              type={value.allDay ? 'date' : 'datetime-local'}
              aria-label="Starts"
              value={value.allDay ? dayKey(value.start) : localInput(value.start)}
              onChange={e => {
                if (e.target.value) setStart(e.target.value);
              }}
            />
          </Field>
          {/* All-day ends are stored exclusive (as Google does) but shown as the last day of the event. */}
          <Field label="Ends">
            <input
              type={value.allDay ? 'date' : 'datetime-local'}
              aria-label="Ends"
              aria-invalid={backwards || undefined}
              min={value.allDay ? dayKey(value.start) : localInput(value.start)}
              value={value.allDay ? addDays(value.end.slice(0, 10), -1) : localInput(value.end)}
              onChange={e => {
                const next = e.target.value;
                if (next)
                  setValue(v => ({
                    ...v,
                    end: v.allDay ? addDays(next, 1) : new Date(next).toISOString(),
                  }));
              }}
            />
          </Field>
        </div>
        {backwards && (
          <p className="field-error" role="alert">
            Ends before it starts.
          </p>
        )}
        <Checkbox
          className="all-day"
          label="All-day event"
          checked={value.allDay}
          onChange={setAllDay}
        />
        <Field label="Location">
          <input
            value={value.location}
            placeholder="Add a place or meeting link"
            onChange={e => setValue({ ...value, location: e.target.value })}
          />
        </Field>
        <Field label="Guests">
          <input
            value={guestText}
            aria-invalid={(!typingGuests && badGuests.length > 0) || undefined}
            placeholder="Email addresses, separated by commas"
            onFocus={() => setTypingGuests(true)}
            onChange={e => setGuestText(e.target.value)}
            onBlur={() => {
              setTypingGuests(false);
              setGuestText(guests.join(', '));
            }}
          />
        </Field>
        {!typingGuests && badGuests.length > 0 && (
          <p className="field-error">
            {badGuests.length === 1
              ? `“${badGuests[0]}” isn’t an email address.`
              : `${badGuests.length} guests aren’t email addresses.`}
          </p>
        )}
        <Field label="Notes">
          <textarea
            rows={3}
            value={value.description}
            onChange={e => setValue({ ...value, description: e.target.value })}
          />
        </Field>
        {value.url && (
          <Button
            variant="text"
            iconRight={ExternalLink}
            onClick={() => void openUrl(value.url!).catch(e => setError(e.message))}
          >
            Open in Google Calendar
          </Button>
        )}
        {error && <Notice>{error}</Notice>}
      </div>
      <footer>
        {event.id ? (
          <Button
            variant="danger"
            size="sm"
            icon={Trash2}
            onClick={async () => {
              if (
                !(await confirmAction({
                  title: 'Delete this event?',
                  message: value.title || undefined,
                  confirmLabel: 'Delete event',
                  danger: true,
                }))
              )
                return;
              try {
                await invoke('calendar.delete', { id: event.id });
                notify('Event deleted');
                close();
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            Delete event
          </Button>
        ) : (
          <span className="muted small">You’ll see duplicates before adding.</span>
        )}
        <Button variant="primary" icon={Check} loading={busy} onClick={() => void save()}>
          Save event
        </Button>
      </footer>
    </Dialog>
  );
}

const SNAP = 15;
const viewStorageKey = 'aplos.calendar.view';
const lastCalendarKey = 'aplos.calendar.last';
const viewLabels: Record<CalendarView, string> = { day: 'Day', week: 'Week', month: 'Month' };
const todayKey = () => ymd(new Date());
const dateOf = (day: string) => new Date(day + 'T00:00:00');
/** A wall-clock time on a day; minutes past midnight may run over into the next day. */
const wall = (day: string, minutes: number) => {
  const d = dateOf(day);
  d.setMinutes(minutes);
  return d;
};
const minutesInto = (iso: string, day: string) => (+new Date(iso) - +dateOf(day)) / 60000;
const dayLabel = (day: string, options: Intl.DateTimeFormatOptions) =>
  dateOf(day).toLocaleDateString([], options);
const hourLabel = (h: number) =>
  new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: 'numeric' });
const accountLabel = (a?: Account) =>
  !a ? '' : a.provider === 'demo' ? (a.id === 'work' ? 'Work' : 'Personal') : a.email;
/** "Team · Work": the account only when it adds something. */
const calendarLabel = (s: CalendarSource, a?: Account) => {
  const owner = accountLabel(a);
  return owner && owner !== s.name ? `${s.name} · ${owner}` : s.name;
};
const zoneName = () =>
  new Intl.DateTimeFormat([], { timeZoneName: 'short' })
    .formatToParts(new Date())
    .find(p => p.type === 'timeZoneName')?.value ?? '';
/** "October 2026", "Oct – Nov 2026" for a week across months, or the full date for a day. */
function rangeTitle(view: CalendarView, days: string[], anchor: string): [string, string] {
  if (view === 'day')
    return [
      dayLabel(anchor, { weekday: 'long', month: 'long', day: 'numeric' }),
      anchor.slice(0, 4),
    ];
  if (view === 'month') return [dayLabel(anchor, { month: 'long' }), anchor.slice(0, 4)];
  const first = days[0],
    last = days[days.length - 1];
  if (first.slice(0, 7) === last.slice(0, 7))
    return [dayLabel(first, { month: 'long' }), first.slice(0, 4)];
  return [
    `${dayLabel(first, { month: 'short' })} – ${dayLabel(last, { month: 'short' })}`,
    last.slice(0, 4),
  ];
}

/** The current minute, for the now line. Only the time grid listens, so the rest of the app never re-renders for it. */
function useNow() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      setNow(new Date());
      timer = setTimeout(tick, 60_000 - (Date.now() % 60_000) + 50);
    };
    timer = setTimeout(tick, 60_000 - (Date.now() % 60_000) + 50);
    return () => clearTimeout(timer);
  }, []);
  return now;
}

/** The pixels per hour a time grid was last pinched to, per place it appears. */
function useHourHeight(key: string, fallback: number) {
  const [hour, setHour] = useState(() => {
    const saved = Number(localStorage.getItem(key));
    return saved >= hourLimits.min && saved <= hourLimits.max ? saved : fallback;
  });
  useEffect(() => {
    const timer = setTimeout(() => localStorage.setItem(key, String(hour)), 300);
    return () => clearTimeout(timer);
  }, [hour]);
  return [hour, setHour] as const;
}

type SourceOf = (
  event: Pick<CalendarEvent, 'accountId' | 'calendarId'>,
) => CalendarSource | undefined;
/** An event being created: where it sits and which calendar it goes to. */
type DraftEvent = {
  start: string;
  end: string;
  allDay: boolean;
  calendar: string;
  anchor?: HTMLElement;
};
type Slide = React.RefObject<{ direction: number; from?: number } | null>;

// The page and Today ask for the calendar list together; one request serves both until the accounts change.
let calendarList: { key: string; promise: Promise<CalendarInfo[]> } | undefined;
function loadCalendars(key: string) {
  if (calendarList?.key !== key) {
    const entry = {
      key,
      promise: invoke<CalendarInfo[]>('calendar.list', { accountId: 'all' }).catch(() => {
        if (calendarList === entry) calendarList = undefined;
        return [] as CalendarInfo[];
      }),
    };
    calendarList = entry;
  }
  return calendarList.promise;
}

type ModelOptions = {
  events: CalendarEvent[];
  accounts: Account[];
  accountId: string;
  hidden: string[];
  edit: (event: Partial<CalendarEvent>) => void;
  onThread: (id: string) => void;
};

/**
 * What the Calendar page and Today share: the combined calendars, the events in view, the open event and the
 * plan being drawn, saving moves with Undo, and the two popovers. Each place keeps its own copy of this state.
 */
function useCalendarModel({ events, accounts, accountId, hidden, edit, onThread }: ModelOptions) {
  const [listed, setListed] = useState<CalendarInfo[]>([]);
  const [moved, setMoved] = useState<Record<string, { start: string; end: string }>>({});
  const [selection, setSelection] = useState<{ id: string; anchor: HTMLElement } | null>(null);
  const [draft, setDraft] = useState<DraftEvent | null>(null);
  const [draftNode, setDraftNode] = useState<HTMLElement | null>(null);
  const accountsKey = accounts.map(a => a.id + (a.calendarConnected ? '+' : '')).join();
  useEffect(() => {
    let live = true;
    void loadCalendars(accountsKey).then(list => {
      if (live) setListed(list);
    });
    return () => {
      live = false;
    };
  }, [accountsKey]);
  const sources = useMemo(
    () => mergeCalendars(accounts, listed, events),
    [accounts, listed, events],
  );
  const sourceOf = useMemo(() => calendarIndex(sources), [sources]);
  const scoped = useMemo(
    () => sources.filter(s => accountId === 'all' || s.accountId === accountId),
    [sources, accountId],
  );
  const shown = useMemo(
    () =>
      visibleEvents(events, sourceOf, accountId, hidden).map(e =>
        moved[e.id] ? { ...e, ...moved[e.id] } : e,
      ),
    [events, sourceOf, accountId, hidden, moved],
  );
  const selected = selection ? shown.find(e => e.id === selection.id) : undefined;
  // New plans go to the calendar used last, while it is shown; otherwise the default calendar of the chosen account.
  function defaultCalendar(accountHint?: string) {
    const visible = scoped.filter(s => !hidden.includes(s.key));
    const last = localStorage.getItem(lastCalendarKey);
    return (
      (accountHint && visible.find(s => s.accountId === accountHint && s.primary)) ||
      visible.find(s => s.key === last) ||
      visible.find(s => s.primary) ||
      visible[0] ||
      scoped[0]
    )?.key;
  }
  function startDraft(
    start: Date | string,
    end: Date | string,
    allDay: boolean,
    where?: HTMLElement,
  ) {
    const calendar = defaultCalendar();
    if (!calendar) {
      toast.show({ text: 'Connect a calendar in Settings → Accounts first.' });
      return;
    }
    setSelection(null);
    setDraft({
      start: typeof start === 'string' ? start : start.toISOString(),
      end: typeof end === 'string' ? end : end.toISOString(),
      allDay,
      calendar,
      anchor: where,
    });
  }
  async function reschedule(id: string, start: string, end: string, undo = true) {
    const original = events.find(e => e.id === id);
    if (!original) return;
    setMoved(m => ({ ...m, [id]: { start, end } }));
    try {
      await invoke('calendar.save', { event: { ...original, start, end } });
      if (undo)
        toast.show({
          text: `Moved “${original.title}” to ${dayLabel(dayKey(start), { weekday: 'short' })} ${original.allDay ? '' : clock(start)}`.trim(),
          action: {
            label: 'Undo',
            run: () => void reschedule(id, original.start, original.end, false),
          },
        });
    } catch (e) {
      toast.show({ tone: 'error', text: (e as Error).message });
    } finally {
      setMoved(m => {
        const next = { ...m };
        delete next[id];
        return next;
      });
    }
  }
  async function remove(event: CalendarEvent) {
    if (
      !(await confirmAction({
        title: 'Delete this event?',
        message: event.title || undefined,
        confirmLabel: 'Delete event',
        danger: true,
      }))
    )
      return;
    setSelection(null);
    try {
      await invoke('calendar.delete', { id: event.id });
      toast.show({ text: 'Event deleted' });
    } catch (e) {
      toast.show({ tone: 'error', text: (e as Error).message });
    }
  }
  const handlers = useHandlers({
    open: (event: CalendarEvent, element: HTMLElement) => {
      setDraft(null);
      setSelection(current =>
        current?.id === event.id ? null : { id: event.id, anchor: element },
      );
    },
    edit: (event: CalendarEvent) => {
      setSelection(null);
      edit(events.find(e => e.id === event.id) ?? event);
    },
    create: (start: Date | string, end: Date | string, allDay: boolean, where?: HTMLElement) =>
      startDraft(start, end, allDay, where),
    change: (event: CalendarEvent, start: string, end: string) =>
      void reschedule(event.id, start, end),
    draftNode: (node: HTMLElement | null) => setDraftNode(node),
  });
  const draftSource = draft ? sources.find(s => s.key === draft.calendar) : undefined;
  const draftAnchor = draft?.anchor ?? draftNode;
  // Popovers keep their last content while they fade out, with the same scale and fade as every Aplos popover.
  const card = useLatest(selected);
  const lastDraft = useLatest(draft);
  const popovers = (
    <>
      <Popover
        open={!!selected}
        anchor={selection?.anchor}
        onClose={() => setSelection(null)}
        placement="right-start"
        gap={8}
        className="ui-surface cal-popover"
        role="dialog"
        label="Event"
      >
        {card && (
          <EventCard
            event={card}
            source={sourceOf(card)}
            account={accounts.find(a => a.id === card.accountId)}
            onEdit={() => handlers.edit(card)}
            onDelete={() => void remove(card)}
            onThread={onThread}
            onClose={() => setSelection(null)}
          />
        )}
      </Popover>
      <Popover
        open={!!draft && !!draftAnchor}
        anchor={draftAnchor}
        onClose={() => setDraft(null)}
        placement="right-start"
        gap={8}
        className="ui-surface cal-popover"
        role="dialog"
        label="New event"
      >
        {lastDraft && (
          <QuickCreate
            key={lastDraft.start + lastDraft.allDay}
            draft={lastDraft}
            sources={scoped}
            accounts={accounts}
            onCalendar={calendar => setDraft(d => d && { ...d, calendar })}
            onClose={() => setDraft(null)}
            onMore={value => {
              setDraft(null);
              edit(value);
            }}
          />
        )}
      </Popover>
    </>
  );
  return {
    sources,
    sourceOf,
    scoped,
    shown,
    selection,
    selected,
    draft,
    setDraft,
    setSelection,
    startDraft,
    defaultCalendar,
    remove,
    handlers,
    popovers,
    draftColor: draftSource?.color,
    overlay: !!draft || !!selection,
  };
}

type CalendarProps = {
  events: CalendarEvent[];
  accounts: Account[];
  accountId: string;
  hidden: string[];
  suggestions: Thread[];
  busyId?: string;
  /** Shortcuts pause while the composer is open. */ paused: boolean;
  edit: (event: Partial<CalendarEvent>) => void;
  onThread: (id: string) => void;
  onSchedule: (thread: Thread) => void;
  onHidden: (keys: string[]) => void;
};

/**
 * The Calendar page: every calendar of every account in one week, day or month view, with a mini
 * month and the calendar list on the left. Plans are created by dragging on the grid, moved by
 * dragging and resized from their lower edge; nothing is saved without an explicit action.
 */
export const Calendar = memo(function Calendar({
  events,
  accounts,
  accountId,
  hidden,
  suggestions,
  busyId,
  paused,
  edit,
  onThread,
  onSchedule,
  onHidden,
}: CalendarProps) {
  const model = useCalendarModel({ events, accounts, accountId, hidden, edit, onThread });
  const { sourceOf, scoped, shown, selected, handlers } = model;
  const [view, setViewState] = useState<CalendarView>(() => {
    const saved = localStorage.getItem(viewStorageKey);
    return saved === 'day' || saved === 'month' ? saved : 'week';
  });
  const [anchor, setAnchor] = useState(todayKey);
  const [narrow, setNarrow] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  const [hour, setHour] = useHourHeight('aplos.calendar.hour', 48);
  // The view that was just left stays on screen for a moment, fading under the new one.
  const [leaving, setLeaving] = useState<{ view: CalendarView; anchor: string; id: number } | null>(
    null,
  );
  const [nowSignal, setNowSignal] = useState(0);
  const page = useRef<HTMLDivElement>(null);
  const railButton = useRef<HTMLButtonElement>(null);
  const slide = useRef<{ direction: number; from?: number } | null>(null);
  const scrollMemo = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = page.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setNarrow(entry.contentRect.width < 880));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(() => setLeaving(null), duration.base + 40);
    return () => clearTimeout(timer);
  }, [leaving]);
  const days = useMemo(() => viewDays(view, anchor), [view, anchor]);
  const busyDays = useMemo(() => {
    const set = new Set<string>();
    for (const e of shown) {
      if (e.allDay) {
        for (
          let d = e.start.slice(0, 10), n = 0;
          (d < e.end.slice(0, 10) || n === 0) && n < 62;
          d = addDays(d, 1), n++
        )
          set.add(d);
      } else set.add(dayKey(e.start));
    }
    return set;
  }, [shown]);
  const [title, year] = rangeTitle(view, days, anchor);

  function setView(next: CalendarView) {
    if (next === view) return;
    if (!reducedMotion()) setLeaving({ view, anchor, id: Date.now() });
    setViewState(next);
    localStorage.setItem(viewStorageKey, next);
    model.setSelection(null);
    model.setDraft(null);
  }
  /** Moves to the period holding `day`; the grid slides in from the side of travel (or from where a swipe left it). */
  function go(day: string, from?: number) {
    const next = viewDays(view, day)[0];
    if (next !== days[0]) slide.current = { direction: next > days[0] ? 1 : -1, from };
    setAnchor(day);
    model.setSelection(null);
    model.setDraft(null);
  }
  const shift = (delta: number, from?: number) => go(shiftAnchor(view, anchor, delta), from);
  function goToday() {
    go(todayKey());
    setNowSignal(n => n + 1);
  }
  function newEvent() {
    const day = days.includes(todayKey()) ? todayKey() : anchor;
    const slot = slotOn(dateOf(day));
    if (view === 'month')
      model.startDraft(
        slot.start,
        slot.end,
        false,
        page.current?.querySelector<HTMLElement>(`[data-cell="${day}"]`) ?? undefined,
      );
    else {
      if (!days.includes(day)) go(day);
      model.startDraft(slot.start, slot.end, false);
    }
  }
  const pageHandlers = useHandlers({
    day: (day: string) => {
      setView('day');
      go(day);
    },
    pick: (day: string) => go(day),
    page: (direction: 1 | -1, offset: number) =>
      shift(
        direction,
        direction * Math.min(160, (page.current?.offsetWidth ?? 800) * 0.25) + offset * 0.2,
      ),
  });
  function toggle(key: string) {
    onHidden(hidden.includes(key) ? hidden.filter(k => k !== key) : [...hidden, key]);
  }
  /** Shows only one calendar of those in view, or everything again when it already is the only one. */
  function only(key: string) {
    const inScope = new Set(scoped.map(s => s.key));
    const rest = hidden.filter(k => !inScope.has(k));
    const alone =
      scoped.every(s => s.key === key || hidden.includes(s.key)) && !hidden.includes(key);
    onHidden(alone ? rest : [...rest, ...scoped.filter(s => s.key !== key).map(s => s.key)]);
  }

  useEffect(() => {
    function keydown(e: KeyboardEvent) {
      if (paused || dialogOpen() || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey)
        return;
      const element = e.target as HTMLElement;
      if (
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) ||
        element.isContentEditable ||
        element.closest?.('.ask-dock')
      )
        return;
      // A focused control keeps Enter, Space and arrows; a focused event keeps Enter for itself.
      if (
        element.closest?.('button,[role=tab],[role=checkbox],[role=button]') &&
        element.matches(':focus-visible') &&
        ['Enter', ' ', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)
      )
        return;
      const keys: Record<string, () => void> = {
        t: goToday,
        d: () => setView('day'),
        w: () => setView('week'),
        m: () => setView('month'),
        j: () => shift(1),
        k: () => shift(-1),
        ArrowRight: () => shift(1),
        ArrowLeft: () => shift(-1),
        n: newEvent,
      };
      if (selected) {
        keys.e = keys.Enter = () => handlers.edit(selected);
        if (!selected.scheduling) keys.Backspace = keys.Delete = () => void model.remove(selected);
      }
      const run = keys[e.key];
      if (run) {
        e.preventDefault();
        run();
      }
    }
    addEventListener('keydown', keydown);
    return () => removeEventListener('keydown', keydown);
  });

  const visibleKeys = new Set(scoped.filter(s => !hidden.includes(s.key)).map(s => s.key));
  const rail = (
    <div className="cal-rail-body">
      <MiniMonth anchor={anchor} range={days} busy={busyDays} onPick={pageHandlers.pick} />
      <CalendarList
        accounts={accounts}
        sources={scoped}
        visible={visibleKeys}
        onToggle={toggle}
        onOnly={only}
      />
      {suggestions.length > 0 && (
        <section className="cal-suggestions" aria-label="Plans found in your mail">
          <h3>From your mail</h3>
          {suggestions.slice(0, 4).map(t => (
            <button
              key={t.id}
              className="cal-suggestion"
              onClick={() => onSchedule(t)}
              disabled={busyId === t.id}
            >
              <span>
                <strong>{t.messages[0]?.fromName || t.subject}</strong>
                <small>{t.summary || t.subject}</small>
              </span>
              {busyId === t.id ? <Spinner size={13} /> : <Plus size={14} />}
            </button>
          ))}
          <p className="cal-rail-note">
            AI reads the email and fills in the event. Nothing is added until you save it.
          </p>
        </section>
      )}
    </div>
  );
  const grid = (v: CalendarView, a: string, copy = false) => {
    const shownDays = copy ? viewDays(v, a) : days;
    const common = {
      days: shownDays,
      events: shown,
      sourceOf,
      selectedId: copy ? undefined : model.selection?.id,
      draft: copy ? null : model.draft,
      draftColor: model.draftColor,
      overlay: model.overlay,
      periodKey: v + shownDays[0],
      slide,
      copy,
      ...handlers,
      day: pageHandlers.day,
      onPage: pageHandlers.page,
    };
    return v === 'month' ? (
      <MonthGrid {...common} anchor={a} />
    ) : (
      <TimeGrid
        {...common}
        hour={hour}
        onHour={setHour}
        scrollMemo={scrollMemo}
        nowSignal={nowSignal}
      />
    );
  };

  return (
    <div ref={page} className={cx('calendar-page', narrow && 'is-narrow')}>
      {!narrow && (
        <aside className="cal-rail" aria-label="Calendars">
          {rail}
        </aside>
      )}
      <section className="cal-main" aria-label="Calendar">
        <header className="cal-header">
          {narrow && (
            <IconButton
              ref={railButton}
              label="Calendars"
              icon={CalendarDays}
              active={railOpen}
              onClick={() => setRailOpen(v => !v)}
            />
          )}
          <h1 className="cal-title" aria-live="polite">
            <strong>{title}</strong> <span>{year}</span>
          </h1>
          <div className="cal-nav">
            <Button
              variant="secondary"
              size="sm"
              className="cal-today"
              tooltip={{ content: 'Today', shortcut: 'T' }}
              onClick={goToday}
            >
              Today
            </Button>
            <IconButton
              size="sm"
              label={`Previous ${view}`}
              shortcut="K"
              icon={ChevronLeft}
              onClick={() => shift(-1)}
            />
            <IconButton
              size="sm"
              label={`Next ${view}`}
              shortcut="J"
              icon={ChevronRight}
              onClick={() => shift(1)}
            />
          </div>
          <div className="cal-header-end">
            <Tabs
              variant="segmented"
              semantics="nav"
              label="Calendar view"
              className="cal-views"
              value={view}
              onChange={setView}
              items={(['day', 'week', 'month'] as CalendarView[]).map(id => ({
                id,
                label: viewLabels[id],
                tooltip: {
                  title: viewLabels[id] + ' view',
                  detail: `Press ${id[0].toUpperCase()}`,
                },
              }))}
            />
            <Button variant="pill" icon={Plus} shortcut="N" className="cal-new" onClick={newEvent}>
              New event
            </Button>
          </div>
        </header>
        <div className="cal-stage">
          {leaving && (
            <div key={leaving.id} className="cal-stage-leaving" aria-hidden="true" inert>
              {grid(leaving.view, leaving.anchor, true)}
            </div>
          )}
          <div key={view} className="cal-stage-current">
            {grid(view, anchor)}
          </div>
        </div>
      </section>
      {narrow && (
        <Popover
          open={railOpen}
          anchor={railButton.current}
          onClose={() => setRailOpen(false)}
          placement="bottom-start"
          className="ui-surface cal-rail-popover"
          label="Calendars"
        >
          {rail}
        </Popover>
      )}
      {model.popovers}
    </div>
  );
});

type GridProps = {
  days: string[];
  events: CalendarEvent[];
  sourceOf: SourceOf;
  selectedId?: string;
  draft: DraftEvent | null;
  draftColor?: string;
  /** A popover is open: a plain click on the grid only closes it. */ overlay: boolean;
  /** Changes whenever the days in view change; the grid slides then, in the direction `slide` holds. */ periodKey: string;
  slide: Slide;
  /** A still copy of the view just left, fading out under the new one. */ copy?: boolean;
  open: (event: CalendarEvent, element: HTMLElement) => void;
  edit: (event: CalendarEvent) => void;
  create: (start: Date | string, end: Date | string, allDay: boolean, where?: HTMLElement) => void;
  change: (event: CalendarEvent, start: string, end: string) => void;
  draftNode: (node: HTMLElement | null) => void;
  day?: (day: string) => void;
  onPage: (direction: 1 | -1, offset: number) => void;
};
type TimeGridProps = GridProps & {
  hour: number;
  onHour: (hour: number) => void;
  scrollMemo: React.RefObject<number | null>;
  nowSignal?: number;
  /** Today in the dock: no day header, a narrower gutter, all-day plans only when there are some. */ compact?: boolean;
  /** A plan found in the open email, drawn as a dashed outline; clashing events are marked. Dragging it (or its
   * lower edge) only changes the time it would be added at; nothing is saved until the user adds it. */
  proposal?: {
    start: string;
    end: string;
    allDay: boolean;
    title: string;
    color?: string;
    open: () => void;
    change?: (start: string, end: string) => void;
  };
  clashIds?: Set<string>;
  focusId?: string;
  /** Scrolls smoothly to this time when it changes. */ revealAt?: string;
};
type Gesture = {
  kind: 'create' | 'move' | 'resize';
  dismiss?: boolean;
  pointer: number;
  x: number;
  y: number;
  moved: boolean;
  index: number;
  day: string;
  start: number;
  end: number;
  origin: number;
  grab: number;
  event?: CalendarEvent;
  element?: HTMLElement;
};
/** The block that follows the pointer. `from` is where it started, for Escape to take it back. */
type Preview = {
  kind: Gesture['kind'];
  id?: string;
  index: number;
  start: number;
  end: number;
  phase: 'drag' | 'return';
  from: { index: number; start: number; end: number };
};

const proposalId = '\u0000proposal';
const eventStyle = (color?: string) => ({ '--c': color ?? 'var(--blue)' }) as React.CSSProperties;

/** Week and day views (and Today in the dock): a sticky row of days and all-day plans over a 24-hour grid. */
const TimeGrid = memo(function TimeGrid({
  days,
  events,
  sourceOf,
  selectedId,
  draft,
  draftColor,
  overlay,
  periodKey,
  slide,
  copy,
  open,
  edit,
  create,
  change,
  day: showDay,
  draftNode,
  onPage,
  hour,
  onHour,
  scrollMemo,
  nowSignal,
  compact,
  proposal,
  clashIds,
  focusId,
  revealAt,
}: TimeGridProps) {
  const now = useNow();
  const today = ymd(now);
  const root = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const sticky = useRef<HTMLDivElement>(null);
  const columns = useRef<HTMLDivElement>(null);
  const allDayRow = useRef<HTMLDivElement>(null);
  const dayTrack = useRef<HTMLDivElement>(null);
  const ghost = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  // A proposal from the open email takes a column of its own beside what it clashes with.
  const placed = useMemo(
    () =>
      days.map(day =>
        layoutDay(
          proposal && !proposal.allDay
            ? [...events, { ...proposal, id: proposalId } as unknown as CalendarEvent]
            : events,
          day,
        ),
      ),
    [days, events, proposal?.start, proposal?.end, proposal?.allDay],
  );
  const { bars, lanes } = useMemo(() => allDayLanes(events, days), [events, days]);
  const proposalEvent = useMemo(
    () =>
      proposal && !proposal.allDay
        ? ({
            id: proposalId,
            accountId: '',
            calendarId: '',
            title: proposal.title,
            start: proposal.start,
            end: proposal.end,
            allDay: false,
            location: '',
            description: '',
            guests: [],
          } as CalendarEvent)
        : undefined,
    [proposal?.title, proposal?.start, proposal?.end, proposal?.allDay],
  );
  const eventOf = (id: string | undefined) =>
    id === proposalId ? proposalEvent : events.find(x => x.id === id);
  const zone = useMemo(zoneName, []);
  const tracks = () =>
    [dayTrack.current, allDayRow.current, columns.current].filter(
      (el): el is HTMLDivElement => !!el,
    );
  usePeriodSlide(periodKey, tracks, slide);
  // Pinch (⌘/ctrl + wheel) changes the hour height and keeps the time under the pointer where it is.
  const zoom = useRef<{ pointerY: number; scrollTop: number; from: number } | null>(null);
  const hourNow = useRef(hour);
  hourNow.current = hour;
  usePeriodSwipe({
    host: root,
    tracks,
    enabled: !copy,
    onCommit: onPage,
    onZoom: (deltaY, clientY) => {
      const el = scroller.current;
      if (!el) return;
      const next = zoomHour(hourNow.current, deltaY);
      if (next === hourNow.current) return;
      zoom.current ??= {
        pointerY: clientY - el.getBoundingClientRect().top,
        scrollTop: el.scrollTop,
        from: hourNow.current,
      };
      hourNow.current = next;
      onHour(next);
    },
  });
  useLayoutEffect(() => {
    const z = zoom.current,
      el = scroller.current;
    zoom.current = null;
    if (!z || !el) return;
    el.scrollTop = zoomScroll({
      scrollTop: z.scrollTop,
      pointerY: z.pointerY,
      bodyTop: sticky.current?.offsetHeight ?? 0,
      from: z.from,
      to: hour,
    });
  }, [hour]);
  // Opening glides from midnight to now, or to the first plan if it is earlier; later visits keep their place.
  const opening = useRef(0);
  const target = (useNowHour: boolean) => {
    const nowHour =
      days.includes(todayKey()) && useNowHour ? now.getHours() + now.getMinutes() / 60 : undefined;
    const starts = placed.flat().map(p => p.start / 60);
    const first = starts.length ? Math.min(...starts) : undefined;
    return openingHour(nowHour, first);
  };
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (scrollMemo.current !== null) {
      el.scrollTop = scrollMemo.current;
      return;
    }
    if (copy) return;
    const top = target(true) * hour;
    scrollMemo.current = top;
    if (reducedMotion()) el.scrollTop = top;
    else opening.current = requestAnimationFrame(() => el.scrollTo({ top, behavior: 'smooth' }));
  }, []);
  useEffect(() => {
    if (!nowSignal) return;
    scroller.current?.scrollTo({
      top: Math.max(0, (now.getHours() + now.getMinutes() / 60 - 1.5) * hour),
      behavior: reducedMotion() ? 'auto' : 'smooth',
    });
  }, [nowSignal]);
  // A plan from the open email wins over the opening glide.
  useEffect(() => {
    if (!revealAt) return;
    const el = scroller.current;
    if (!el) return;
    cancelAnimationFrame(opening.current);
    const at = minutesInto(revealAt, dayKey(revealAt)) / 60;
    el.scrollTo({
      top: Math.max(0, (at - 1.25) * hour),
      behavior: reducedMotion() ? 'auto' : 'smooth',
    });
  }, [revealAt]);
  useEffect(() => {
    function cancel(e: KeyboardEvent) {
      const g = gesture.current;
      if (e.key !== 'Escape' || !g) return;
      e.preventDefault();
      e.stopPropagation();
      gesture.current = null;
      // A cancelled move or resize glides back to where it started, then lets go.
      setPreview(p =>
        p && g.moved && g.kind !== 'create' && !reducedMotion()
          ? { ...p, ...p.from, phase: 'return' }
          : null,
      );
    }
    addEventListener('keydown', cancel, true);
    return () => removeEventListener('keydown', cancel, true);
  }, []);
  useEffect(() => {
    if (preview?.phase !== 'return') return;
    const timer = setTimeout(() => setPreview(null), duration.slow + 20);
    return () => clearTimeout(timer);
  }, [preview?.phase]);
  useEffect(() => {
    if (!draft || draft.allDay) return;
    requestAnimationFrame(() =>
      scroller.current
        ?.querySelector('.cal-draft')
        ?.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' }),
    );
  }, [draft?.start]);

  // FLIP: when the layout of the days in view changes (a drop, a calendar shown or hidden, a save), every event
  // glides from where it was drawn to its new place. A dropped event settles out of the lifted block with a spring.
  const boxes = useRef(new Map<string, Box>());
  const measured = useRef({ placed: null as unknown, period: '', hour: 0 });
  const dropped = useRef<{ id: string; box: Box } | null>(null);
  useLayoutEffect(() => {
    const host = columns.current;
    if (!host || copy) return;
    const drop = dropped.current;
    dropped.current = null;
    const m = measured.current;
    const layoutChanged = m.placed !== placed,
      samePeriod = m.period === periodKey && m.hour === hour;
    if (!layoutChanged && !drop && m.hour === hour) return;
    const next = new Map<string, Box>();
    const animate = samePeriod && m.placed !== null;
    for (const el of host.querySelectorAll<HTMLElement>('.cal-column > [data-event-id]')) {
      const column = el.parentElement!;
      const key = el.dataset.eventId + '|' + el.dataset.day;
      const box = {
        x: column.offsetLeft + column.clientLeft + el.offsetLeft,
        y: el.offsetTop,
        w: el.offsetWidth,
        h: el.offsetHeight,
      };
      next.set(key, box);
      if (drop && drop.id === el.dataset.eventId)
        flip(el, drop.box, box, { spring: true, visual: true });
      else if (animate && layoutChanged) {
        const before = boxes.current.get(key);
        if (before) flip(el, before, box);
        else fadeIn(el);
      }
    }
    boxes.current = next;
    measured.current = { placed, period: periodKey, hour };
  }, [placed, periodKey, hour, preview]);
  useEffect(() => {
    const host = columns.current;
    if (!host) return;
    const observer = new ResizeObserver(() => {
      measured.current = { ...measured.current, period: '' };
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  function point(e: { clientX: number; clientY: number }) {
    const r = columns.current!.getBoundingClientRect();
    const index = Math.max(
      0,
      Math.min(days.length - 1, Math.floor((e.clientX - r.left) / (r.width / days.length))),
    );
    return { index, minutes: Math.max(0, Math.min(1440, ((e.clientY - r.top) / hour) * 60)) };
  }
  function down(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0 || gesture.current || copy) return;
    const target = e.target as HTMLElement;
    if (target.closest('.cal-draft') || (target.closest('.cal-proposal') && !proposal?.change))
      return;
    const block = target.closest<HTMLElement>('[data-event-id]');
    const p = point(e);
    if (block) {
      const event = eventOf(block.dataset.eventId);
      if (!event) return;
      const day = block.dataset.day!;
      const start = Math.max(0, minutesInto(event.start, day)),
        end = Math.min(1440, minutesInto(event.end, day));
      gesture.current = {
        kind: target.closest('.cal-resize') ? 'resize' : 'move',
        pointer: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        moved: false,
        index: days.indexOf(day),
        day,
        start,
        end,
        origin: start,
        grab: p.minutes - start,
        event,
        element: block,
      };
    } else {
      const start = Math.floor(p.minutes / SNAP) * SNAP;
      gesture.current = {
        kind: 'create',
        dismiss: overlay,
        pointer: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        moved: false,
        index: p.index,
        day: days[p.index],
        start,
        end: start + SNAP,
        origin: start,
        grab: 0,
      };
    }
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function move(e: React.PointerEvent<HTMLDivElement>) {
    const g = gesture.current;
    if (!g || g.pointer !== e.pointerId) return;
    const first = !g.moved;
    if (first) {
      if (Math.hypot(e.clientX - g.x, e.clientY - g.y) < 4 || g.event?.scheduling) return;
      g.moved = true;
    }
    const box = scroller.current!.getBoundingClientRect();
    if (e.clientY < box.top + (compact ? 24 : 64)) scroller.current!.scrollTop -= 10;
    else if (e.clientY > box.bottom - 32) scroller.current!.scrollTop += 10;
    const p = point(e);
    const snap = (m: number) => Math.round(m / SNAP) * SNAP;
    const from = {
      index: days.indexOf(g.day),
      start: g.origin,
      end: g.kind === 'create' ? g.origin + SNAP : Math.min(1440, minutesInto(g.event!.end, g.day)),
    };
    if (g.kind === 'create') {
      const at = snap(p.minutes);
      g.start = Math.min(g.origin, at);
      g.end = Math.max(g.origin + SNAP, at);
      if (g.end - g.start < SNAP) g.end = g.start + SNAP;
    } else if (g.kind === 'move') {
      const length = g.end - g.origin;
      g.start = Math.max(0, Math.min(1440 - SNAP, snap(p.minutes - g.grab)));
      g.index = p.index;
      setPreview({
        kind: 'move',
        id: g.event!.id,
        index: g.index,
        start: g.start,
        end: g.start + length,
        phase: 'drag',
        from: { ...from, end: from.start + length },
      });
      return;
    } else g.end = Math.max(g.start + SNAP, Math.min(1440, snap(p.minutes)));
    setPreview({
      kind: g.kind,
      id: g.event?.id,
      index: g.index,
      start: g.start,
      end: g.end,
      phase: 'drag',
      from,
    });
  }
  function up(e: React.PointerEvent<HTMLDivElement>) {
    const g = gesture.current;
    if (!g || g.pointer !== e.pointerId) return;
    gesture.current = null;
    if (g.kind === 'create') {
      setPreview(null);
      // A click makes an hour-long plan; a drag makes exactly what was drawn.
      if (!g.moved && g.dismiss) return;
      const start = g.moved ? g.start : g.origin,
        end = g.moved ? g.end : Math.min(1440, g.origin + 60);
      create(wall(g.day, start), wall(g.day, end), false);
      return;
    }
    const event = g.event!;
    if (!g.moved) {
      setPreview(null);
      if (event.id === proposalId) proposal?.open();
      else open(event, g.element!);
      return;
    }
    // The real event takes over from the lifted block exactly where it is drawn, then settles.
    const lifted = ghost.current?.firstElementChild?.getBoundingClientRect(),
      host = columns.current?.getBoundingClientRect();
    if (lifted && host)
      dropped.current = {
        id: event.id,
        box: {
          x: lifted.left - host.left,
          y: lifted.top - host.top,
          w: lifted.width,
          h: lifted.height,
        },
      };
    setPreview(null);
    const commit = (start: string, end: string) =>
      event.id === proposalId ? proposal?.change?.(start, end) : change(event, start, end);
    if (g.kind === 'resize') {
      if (g.end !== minutesInto(event.end, g.day))
        commit(event.start, wall(g.day, g.end).toISOString());
      return;
    }
    const shift = +wall(days[g.index], g.start) - +wall(g.day, g.origin);
    if (shift)
      commit(
        new Date(+new Date(event.start) + shift).toISOString(),
        new Date(+new Date(event.end) + shift).toISOString(),
      );
  }
  function cancel() {
    const g = gesture.current;
    gesture.current = null;
    setPreview(p =>
      p && g?.moved && g.kind !== 'create' && !reducedMotion()
        ? { ...p, ...p.from, phase: 'return' }
        : null,
    );
  }
  function allDayCreate(e: React.MouseEvent<HTMLDivElement>) {
    if ((e.target as HTMLElement).closest('.cal-bar') || copy) return;
    const r = e.currentTarget.getBoundingClientRect();
    const index = Math.max(
      0,
      Math.min(days.length - 1, Math.floor((e.clientX - r.left) / (r.width / days.length))),
    );
    create(
      days[index],
      addDays(days[index], 1),
      true,
      allDayRow.current?.querySelectorAll<HTMLElement>('.cal-allday-cell')[index],
    );
  }
  const block = (
    e: CalendarEvent,
    day: string,
    box: { top: number; height: number; left: string; width: string },
    extra?: string | false,
  ) => {
    const short = box.height < 34;
    const endsToday = dayKey(new Date(+new Date(e.end) - 1).toISOString()) === day;
    return (
      <div
        key={e.id + day}
        data-event-id={e.id}
        data-day={day}
        role="button"
        tabIndex={copy ? -1 : 0}
        aria-label={`${e.title}, ${timeRange(e)}`}
        className={cx(
          'cal-event',
          short && 'is-short',
          +new Date(e.end) < +now && 'is-past',
          selectedId === e.id && 'is-selected',
          e.scheduling && 'is-locked',
          clashIds?.has(e.id) && 'is-clash',
          focusId === e.id && 'is-focus',
          extra,
        )}
        style={{
          ...eventStyle(sourceOf(e)?.color),
          top: box.top,
          height: box.height,
          left: box.left,
          width: box.width,
        }}
        onKeyDown={k => {
          if (k.key === 'Enter' || k.key === ' ') {
            k.preventDefault();
            k.stopPropagation();
            open(e, k.currentTarget);
          }
        }}
      >
        <strong>{e.title || 'Untitled'}</strong>
        {short ? <span>{shortClock(e.start)}</span> : <span>{shortRange(e)}</span>}
        {!short && box.height >= 64 && e.location && <span>{e.location}</span>}
        {!e.scheduling && endsToday && <i className="cal-resize" aria-hidden="true" />}
      </div>
    );
  };
  const nowTop = ((now.getHours() * 60 + now.getMinutes()) / 60) * hour;
  const todayIndex = days.indexOf(today);
  const dragged = eventOf(preview?.id);
  const draggedColor =
    preview?.id === proposalId ? proposal?.color : dragged ? sourceOf(dragged)?.color : draftColor;
  const showAllDay = !compact || bars.length > 0 || !!draft?.allDay || !!proposal?.allDay;
  return (
    <div
      ref={root}
      className={cx('cal-time', days.length === 1 && 'is-day', compact && 'is-compact')}
      style={{ '--days': days.length, '--hour': hour + 'px' } as React.CSSProperties}
    >
      <div
        className="cal-scroll"
        ref={scroller}
        onScroll={e => {
          if (!copy) scrollMemo.current = e.currentTarget.scrollTop;
        }}
      >
        <div className="cal-sticky" ref={sticky}>
          {!compact && (
            <div className="cal-days">
              <span className="cal-zone">{zone}</span>
              <div className="cal-clip">
                <div className="cal-days-track" ref={dayTrack}>
                  {days.map(day => (
                    <button
                      key={day}
                      className={cx(
                        'cal-dayhead',
                        day === today && 'is-today',
                        day < today && 'is-past',
                      )}
                      onClick={() => showDay?.(day)}
                      aria-label={dayLabel(day, { weekday: 'long', month: 'long', day: 'numeric' })}
                    >
                      <span>{dayLabel(day, { weekday: 'short' })}</span>
                      <strong>{Number(day.slice(8))}</strong>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
          {showAllDay && (
            <div className="cal-allday">
              <span className="cal-gutter-label">All day</span>
              <div className="cal-clip">
                <div
                  className="cal-allday-grid"
                  ref={allDayRow}
                  style={{ '--lanes': Math.max(1, lanes) } as React.CSSProperties}
                  onDoubleClick={allDayCreate}
                >
                  {days.map((day, i) => (
                    <span key={day} className="cal-allday-cell" style={{ gridColumn: i + 1 }}>
                      {draft?.allDay && draft.start === day && (
                        <span
                          className="cal-bar cal-draft"
                          style={eventStyle(draftColor)}
                          ref={draftNode}
                        >
                          New event
                        </span>
                      )}
                      {proposal?.allDay && proposal.start.slice(0, 10) === day && (
                        <button
                          className="cal-bar cal-proposal"
                          style={eventStyle(proposal.color)}
                          onClick={proposal.open}
                        >
                          {proposal.title || 'Proposed plan'}
                        </button>
                      )}
                    </span>
                  ))}
                  {bars.map(({ event: e, from, to, lane }) => (
                    <button
                      key={e.id}
                      className={cx(
                        'cal-bar',
                        selectedId === e.id && 'is-selected',
                        e.end.slice(0, 10) <= today && 'is-past',
                        focusId === e.id && 'is-focus',
                      )}
                      style={{
                        ...eventStyle(sourceOf(e)?.color),
                        gridColumn: `${from + 1} / ${to + 2}`,
                        gridRow: lane + 1,
                      }}
                      onClick={ev => open(e, ev.currentTarget)}
                      onDoubleClick={ev => {
                        ev.stopPropagation();
                        edit(e);
                      }}
                    >
                      {e.title || 'Untitled'}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
        <div className="cal-body" style={{ height: 24 * hour }}>
          <div className="cal-gutter" aria-hidden="true">
            {Array.from({ length: 23 }, (_, i) => (
              <span key={i} style={{ top: (i + 1) * hour }}>
                {hourLabel(i + 1)}
              </span>
            ))}
            {todayIndex >= 0 && (
              <time className="cal-now-label" style={{ top: nowTop }}>
                {clock(now.toISOString())}
              </time>
            )}
          </div>
          <div className="cal-clip">
            <div
              className="cal-columns"
              ref={columns}
              onPointerDown={down}
              onPointerMove={move}
              onPointerUp={up}
              onPointerCancel={cancel}
              onDoubleClick={e => {
                const el = (e.target as HTMLElement).closest<HTMLElement>('[data-event-id]');
                const event = el && events.find(x => x.id === el.dataset.eventId);
                if (event) edit(event);
              }}
            >
              {todayIndex >= 0 && <div className="cal-now-faint" style={{ top: nowTop }} />}
              {days.map((day, i) => (
                <div key={day} className={cx('cal-column', day === today && 'is-today')}>
                  {placed[i].map(p => {
                    const dragging =
                      preview && preview.id === p.event.id && preview.kind !== 'create';
                    // Overlapping plans cascade: each reaches into its neighbour's column, and later ones sit on top.
                    const last = p.column + p.span >= p.columns || days.length === 1;
                    const width = last
                      ? p.span / p.columns
                      : Math.min((p.columns - p.column) / p.columns, (p.span * 1.7) / p.columns);
                    const box = {
                      top: (p.start / 60) * hour + 1,
                      height: Math.max(18, ((p.end - p.start) / 60) * hour - 2),
                      left: `calc(${(p.column / p.columns) * 100}% + 1px)`,
                      width: `calc(${width * 100}% - ${last ? 6 : 3}px)`,
                    };
                    // A pointer press is handled by the grid (click to edit, drag to move); the click event is for the keyboard.
                    if (p.event.id === proposalId && proposal)
                      return (
                        <button
                          key="proposal"
                          data-event-id={proposalId}
                          data-day={day}
                          className={cx(
                            'cal-proposal',
                            !!dragging && 'is-origin',
                            !!proposal.change && 'is-movable',
                          )}
                          style={{
                            ...eventStyle(proposal.color),
                            ...box,
                            width: `calc(${(p.span / p.columns) * 100}% - 6px)`,
                          }}
                          onClick={e => {
                            if (!proposal.change || e.detail === 0) proposal.open();
                          }}
                          aria-label={`Proposed: ${proposal.title}, ${timeRange(proposal)}. Open the editor`}
                        >
                          <strong>{proposal.title || 'Proposed plan'}</strong>
                          <span>{shortRange(proposal)}</span>
                          {proposal.change && <i className="cal-resize" aria-hidden="true" />}
                        </button>
                      );
                    return block(p.event, day, box, !!dragging && 'is-origin');
                  })}
                  {draft &&
                    !draft.allDay &&
                    dayKey(draft.start) === day &&
                    !preview &&
                    (() => {
                      const start = minutesInto(draft.start, day),
                        end = Math.min(1440, minutesInto(draft.end, day));
                      return (
                        <div
                          ref={draftNode}
                          className="cal-event cal-draft"
                          style={{
                            ...eventStyle(draftColor),
                            top: (start / 60) * hour + 1,
                            height: Math.max(18, ((end - start) / 60) * hour - 2),
                            left: '1px',
                            width: 'calc(100% - 6px)',
                          }}
                        >
                          <strong>New event</strong>
                          <span>{shortRange(draft)}</span>
                        </div>
                      );
                    })()}
                  {day === today && <div className="cal-now" style={{ top: nowTop }} />}
                </div>
              ))}
              {preview &&
                (() => {
                  // One block follows the pointer across days; it snaps to quarter hours and glides between them.
                  const span = {
                    start: wall(days[preview.index], preview.start).toISOString(),
                    end: wall(days[preview.index], preview.end).toISOString(),
                    allDay: false,
                  };
                  return (
                    <div
                      ref={ghost}
                      aria-hidden="true"
                      className={cx(
                        'cal-ghost',
                        preview.kind === 'create' ? 'is-drawing' : 'is-lifted',
                        preview.phase === 'return' && 'is-returning',
                        preview.id === proposalId && 'is-proposal',
                      )}
                      style={{
                        ...eventStyle(draggedColor),
                        height: Math.max(18, ((preview.end - preview.start) / 60) * hour - 2),
                        transform: `translate(${preview.index * 100}%,${(preview.start / 60) * hour + 1}px)`,
                      }}
                    >
                      <div className="cal-event is-dragging">
                        <strong>{dragged?.title || 'New event'}</strong>
                        <span>{shortRange(span)}</span>
                      </div>
                    </div>
                  );
                })()}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});

/** Month view: six weeks of days, each with as many plans as fit and a count of the rest. */
const MonthGrid = memo(function MonthGrid({
  days,
  anchor,
  events,
  sourceOf,
  selectedId,
  draft,
  draftColor,
  periodKey,
  slide,
  copy,
  open,
  create,
  day: showDay,
  draftNode,
  onPage,
}: GridProps & { anchor: string }) {
  const root = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const [rowHeight, setRowHeight] = useState(110);
  const today = todayKey();
  const tracks = () => (grid.current ? [grid.current] : []);
  usePeriodSlide(periodKey, tracks, slide);
  usePeriodSwipe({ host: root, tracks, enabled: !copy, onCommit: onPage });
  useLayoutEffect(() => {
    const el = grid.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setRowHeight(entry.contentRect.height / 6));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const fit = Math.max(1, Math.floor((rowHeight - 30) / 21));
  const month = anchor.slice(0, 7);
  return (
    <div className="cal-month" ref={root}>
      <div className="cal-month-head">
        {days.slice(0, 7).map(day => (
          <span key={day}>{dayLabel(day, { weekday: 'short' })}</span>
        ))}
      </div>
      <div className="cal-clip cal-month-clip">
        <div className="cal-month-grid" ref={grid}>
          {days.map(day => {
            const list = eventsOnDay(events, day);
            const visible = list.length > fit ? list.slice(0, fit - 1) : list;
            const more = list.length - visible.length;
            const first = day.endsWith('-01');
            return (
              <div
                key={day}
                data-cell={day}
                className={cx(
                  'cal-cell',
                  day.slice(0, 7) !== month && 'is-outside',
                  day === today && 'is-today',
                  day < today && 'is-past',
                )}
                onDoubleClick={e => {
                  if ((e.target as HTMLElement).closest('.cal-chip,.cal-more')) return;
                  const slot = slotOn(dateOf(day));
                  create(slot.start, slot.end, false, e.currentTarget);
                }}
              >
                <button
                  className="cal-cell-day"
                  aria-label={dayLabel(day, { weekday: 'long', month: 'long', day: 'numeric' })}
                  onClick={() => showDay?.(day)}
                >
                  {first ? dayLabel(day, { month: 'short', day: 'numeric' }) : Number(day.slice(8))}
                </button>
                {visible.map(e => (
                  <button
                    key={e.id}
                    className={cx(
                      'cal-chip',
                      e.allDay && 'is-allday',
                      selectedId === e.id && 'is-selected',
                    )}
                    style={eventStyle(sourceOf(e)?.color)}
                    onClick={ev => open(e, ev.currentTarget)}
                  >
                    {!e.allDay && <i />}
                    <span>{e.title || 'Untitled'}</span>
                    {!e.allDay && <time>{shortClock(e.start)}</time>}
                  </button>
                ))}
                {draft && dayKey(draft.start) === day && (
                  <span
                    ref={draftNode}
                    className="cal-chip is-allday cal-draft"
                    style={eventStyle(draftColor)}
                  >
                    <span>New event</span>
                  </span>
                )}
                {more > 0 && (
                  <button className="cal-more" onClick={() => showDay?.(day)}>
                    {more} more
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
});

type TodayProps = {
  events: CalendarEvent[];
  accounts: Account[];
  accountId: string;
  hidden: string[];
  /** The email open in the reader, if any; its plans steer the day shown. */ thread?: Thread;
  finding: boolean;
  /** Space or "Add to calendar" on this email: Today shows the plan (the chosen one first) and focus moves to Add. */
  review?: { threadId: string; plan?: Partial<CalendarEvent>; n: number };
  edit: (event: Partial<CalendarEvent>) => void;
  onThread: (id: string) => void;
  onFind: (thread: Thread) => void;
};

/**
 * Today in the dock: one day of every visible calendar, beside the mail. It follows the open email: a plan
 * found in it shows as a dashed outline on its day, with clashes marked, and a card to confirm it. The outline
 * can be dragged to another time first; nothing is saved until the user presses Add.
 */
export const TodayPanel = memo(function TodayPanel({
  events,
  accounts,
  accountId,
  hidden,
  thread,
  finding,
  review,
  edit,
  onThread,
  onFind,
}: TodayProps) {
  const model = useCalendarModel({ events, accounts, accountId, hidden, edit, onThread });
  const [day, setDay] = useState(todayKey);
  const [picking, setPicking] = useState(false);
  const [hour, setHour] = useHourHeight('aplos.today.hour', 44);
  const slide = useRef<{ direction: number; from?: number } | null>(null);
  const scrollMemo = useRef<number | null>(null);
  const dateButton = useRef<HTMLButtonElement>(null);
  const entry = usePlans(thread?.id);
  // Plans added from here, so one whose title or time was changed before adding does not come back.
  const [added, setAdded] = useState<ReadonlySet<string>>(() => new Set());
  // The plan the user chose to add comes first, so an email with several plans shows that one.
  const plans = useMemo(
    () => plansToReview(entry, review?.plan, added),
    [entry, review?.plan, added],
  );
  const context = useMemo(
    () => emailContext(thread?.id, model.shown, plans),
    [thread?.id, model.shown, plans],
  );
  const days = useMemo(() => [day], [day]);
  function go(next: string, from?: number) {
    if (next === day) return;
    slide.current = { direction: next > day ? 1 : -1, from };
    setDay(next);
    model.setSelection(null);
    model.setDraft(null);
  }
  // An email with a plan moves Today to that day; the plan or its saved event scrolls into view.
  useEffect(() => {
    if (context) go(context.day);
  }, [thread?.id, context?.day, review?.n]);
  // Changes made before adding (time, title, calendar) belong to this one plan.
  const found = context?.proposal;
  const key = found && thread ? thread.id + '|' + planKey(found) : '';
  const [changes, setChanges] = useState<{
    key: string;
    start?: string;
    end?: string;
    title?: string;
    calendar?: string;
  }>({ key: '' });
  const own = changes.key === key ? changes : ({ key } as typeof changes);
  const change = (patch: Omit<typeof changes, 'key'>) =>
    setChanges(c => ({ ...(c.key === key ? c : { key }), ...patch }));
  const proposal = found && {
    ...found,
    start: own.start ?? found.start,
    end: own.end ?? found.end,
  };
  const title = own.title ?? found?.title ?? '';
  const calendar = own.calendar ?? (thread ? model.defaultCalendar(thread.accountId) : undefined);
  const source = model.sources.find(s => s.key === calendar);
  const clashing = useMemo(
    () => (proposal ? clashes(proposal, model.shown) : []),
    [proposal?.start, proposal?.end, proposal?.allDay, model.shown],
  );
  const clashIds = useMemo(() => new Set(clashing.map(e => e.id)), [clashing]);
  const filled = (): Partial<CalendarEvent> | undefined =>
    proposal &&
    thread && {
      ...proposal,
      title,
      accountId: source?.accountId ?? thread.accountId,
      calendarId: source?.id,
      threadId: thread.id,
    };
  // Asked for with Space or "Add to calendar": focus moves to Add, and goes back where it was once settled.
  const addButton = useRef<HTMLButtonElement>(null);
  const titleField = useRef<HTMLInputElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!review) return;
    const active = document.activeElement;
    returnFocus.current =
      active instanceof HTMLElement && active !== document.body && !active.closest('.today-panel')
        ? active
        : null;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => addButton.current?.focus({ preventScroll: true }));
    });
    return () => cancelAnimationFrame(frame);
  }, [review?.n]);
  function giveBack() {
    const el = returnFocus.current;
    returnFocus.current = null;
    if (el?.isConnected && document.activeElement?.closest('.today-panel'))
      el.focus({ preventScroll: true });
  }
  const [saving, setSaving] = useState(false);
  async function add() {
    const event = filled();
    if (!event || !found || !thread || saving) return;
    if (!title.trim()) {
      titleField.current?.focus();
      return;
    }
    if (!source) {
      toast.show({ text: 'Connect a calendar in Settings → Accounts first.' });
      return;
    }
    setSaving(true);
    try {
      const saved = await invoke<CalendarEvent>('calendar.save', {
        event: {
          ...event,
          id: uid(),
          title: title.trim(),
          allDay: !!event.allDay,
          location: event.location ?? '',
          description: event.description ?? '',
          guests: event.guests ?? [],
        },
      });
      const done = planKey(found);
      setAdded(a => new Set(a).add(done));
      giveBack();
      toast.show({
        text: `Added “${saved.title}” to ${source.name}`,
        action: {
          label: 'Undo',
          run: () => {
            void invoke('calendar.delete', { id: saved.id })
              .then(() =>
                setAdded(a => {
                  const next = new Set(a);
                  next.delete(done);
                  return next;
                }),
              )
              .catch(e => toast.show({ tone: 'error', text: (e as Error).message }));
          },
        },
      });
    } catch (e) {
      toast.show({ tone: 'error', text: (e as Error).message });
    } finally {
      setSaving(false);
    }
  }
  function notNow() {
    if (!thread) return;
    dismissPlans(thread.id);
    giveBack();
  }
  const editPlan = () => {
    const event = filled();
    if (event) edit(event);
  };
  const handlers = useHandlers({
    page: (direction: 1 | -1, offset: number) =>
      go(addDays(day, direction), direction * 90 + offset * 0.2),
    open: () => editPlan(),
    move: (start: string, end: string) => change({ start, end }),
  });
  const isToday = day === todayKey();
  const mayHavePlan =
    thread && !context && !entry?.dismissed && liveAction(thread)?.kind === 'calendar';
  return (
    <section
      className="today-panel"
      aria-label="Today"
      onKeyDown={e => {
        const el = e.target as HTMLElement;
        if (
          ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) ||
          e.metaKey ||
          e.ctrlKey ||
          e.altKey
        )
          return;
        const step: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1 };
        if (e.key in step && !el.closest('.cal-event,[role=tab]')) {
          e.preventDefault();
          e.stopPropagation();
          go(addDays(day, step[e.key]));
        } else if (e.key === 't') {
          e.stopPropagation();
          go(todayKey());
        }
      }}
    >
      <header className="today-head">
        <button
          ref={dateButton}
          className="today-date"
          aria-haspopup="dialog"
          aria-expanded={picking}
          onClick={() => setPicking(v => !v)}
        >
          <strong>{isToday ? 'Today' : dayLabel(day, { weekday: 'long' })}</strong>
          <span>
            {dayLabel(
              day,
              isToday
                ? { weekday: 'long', month: 'short', day: 'numeric' }
                : { month: 'short', day: 'numeric' },
            )}
          </span>
        </button>
        <span className="actions">
          {!isToday && (
            <Button variant="text" size="sm" onClick={() => go(todayKey())}>
              Today
            </Button>
          )}
          <IconButton
            size="sm"
            label="Previous day"
            shortcut="←"
            icon={ChevronLeft}
            onClick={() => go(addDays(day, -1))}
          />
          <IconButton
            size="sm"
            label="Next day"
            shortcut="→"
            icon={ChevronRight}
            onClick={() => go(addDays(day, 1))}
          />
        </span>
      </header>
      <Popover
        open={picking}
        anchor={dateButton.current}
        onClose={() => setPicking(false)}
        placement="bottom-start"
        className="ui-surface today-picker"
        label="Choose a day"
      >
        <MiniMonth
          anchor={day}
          range={days}
          busy={new Set()}
          onPick={next => {
            go(next);
            setPicking(false);
          }}
        />
      </Popover>
      {proposal && thread && (
        <div
          key={key}
          className={cx('today-context', 'today-confirm', clashing.length > 0 && 'has-clash')}
          role="group"
          aria-label="Add this plan to your calendar"
          onKeyDown={e => {
            // The card keeps its keys: Enter adds from the title, Escape is "Not now", and nothing reaches the mail list behind.
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              notNow();
              return;
            }
            if (
              e.key === 'Enter' &&
              e.target === titleField.current &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              void add();
            }
            if ([' ', 'Enter', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key))
              e.stopPropagation();
          }}
        >
          <p className="today-context-title">
            <CalendarDays size={14} />
            <span>From this email</span>
          </p>
          <input
            ref={titleField}
            className="today-confirm-title"
            aria-label="Event title"
            placeholder="Event title"
            value={title}
            onChange={e => change({ title: e.target.value })}
          />
          <p className="cal-card-line today-confirm-when">
            <Clock size={14} />
            <span>
              {dayLabel(
                dayKey(
                  proposal.start.length === 10 ? proposal.start + 'T00:00:00' : proposal.start,
                ),
                { weekday: 'short', month: 'short', day: 'numeric' },
              )}{' '}
              · {timeRange({ ...proposal, allDay: !!proposal.allDay })}
            </span>
          </p>
          <div className="cal-card-line cal-quick-calendar">
            <span className="cal-swatch is-on" style={eventStyle(source?.color)} />
            <Select
              label="Calendar"
              value={calendar ?? ''}
              options={model.scoped.map(
                s =>
                  [
                    s.key,
                    calendarLabel(
                      s,
                      accounts.find(a => a.id === s.accountId),
                    ),
                  ] as [string, string],
              )}
              onChange={next => change({ calendar: next })}
            />
          </div>
          {!!proposal.guests?.length && (
            <p className="cal-card-line">
              <Users size={14} />
              <span>
                Invites {proposal.guests.slice(0, 3).join(', ')}
                {proposal.guests.length > 3 ? ` and ${proposal.guests.length - 3} more` : ''}
              </span>
            </p>
          )}
          <p className="today-context-note">
            {clashing.length ? (
              <>Clashes with {clashing.map(e => e.title).join(', ')}</>
            ) : proposal.allDay ? (
              'An all-day plan'
            ) : (
              'You’re free then'
            )}
          </p>
          {!proposal.allDay && (
            <p className="today-confirm-hint">Drag the outline to try another time.</p>
          )}
          <footer>
            <Button variant="text" size="sm" onClick={notNow}>
              Not now
            </Button>
            <span className="actions">
              <Button variant="text" size="sm" onClick={editPlan}>
                Edit…
              </Button>
              <Button
                ref={addButton}
                variant="primary"
                size="sm"
                shortcut="↵"
                loading={saving}
                onClick={() => void add()}
              >
                Add
              </Button>
            </span>
          </footer>
        </div>
      )}
      {context?.saved && !proposal && (
        <p className="today-context is-saved">
          <CalendarDays size={14} />
          <span>
            This email’s plan is on your calendar: <strong>{context.saved.title}</strong>
          </span>
        </p>
      )}
      {thread && entry?.dismissed && (
        <div className="today-context is-quiet">
          <span>This email’s plan is hidden.</span>
          <Button variant="text" size="sm" onClick={() => dismissPlans(thread.id, false)}>
            Show
          </Button>
        </div>
      )}
      {mayHavePlan && (
        <div className="today-context is-quiet">
          <span>This email mentions a plan.</span>
          <Button
            variant="text"
            size="sm"
            loading={finding}
            onClick={() => thread && onFind(thread)}
          >
            Find it
          </Button>
        </div>
      )}
      <TimeGrid
        compact
        days={days}
        events={model.shown}
        sourceOf={model.sourceOf}
        selectedId={model.selection?.id}
        draft={model.draft}
        draftColor={model.draftColor}
        overlay={model.overlay}
        periodKey={day}
        slide={slide}
        {...model.handlers}
        onPage={handlers.page}
        hour={hour}
        onHour={setHour}
        scrollMemo={scrollMemo}
        proposal={
          proposal && {
            ...proposal,
            allDay: !!proposal.allDay,
            title: title || 'Proposed plan',
            color: source?.color,
            open: handlers.open,
            change: handlers.move,
          }
        }
        clashIds={clashIds}
        focusId={context?.saved?.id}
        revealAt={
          context && context.day === day
            ? found?.allDay
              ? undefined
              : (found?.start ?? (context.saved?.allDay ? undefined : context.saved?.start))
            : undefined
        }
      />
      {model.popovers}
    </section>
  );
});

/** The small month on the left: picks a day for the main view and marks the days in view. */
const MiniMonth = memo(function MiniMonth({
  anchor,
  range,
  busy,
  onPick,
}: {
  anchor: string;
  range: string[];
  busy: Set<string>;
  onPick: (day: string) => void;
}) {
  const [month, setMonth] = useState(anchor.slice(0, 7) + '-01');
  useEffect(() => setMonth(anchor.slice(0, 7) + '-01'), [anchor]);
  const grid = useRef<HTMLDivElement>(null);
  const keyed = useRef(false);
  const days = viewDays('month', month);
  const today = todayKey();
  const from = range[0],
    to = range[range.length - 1];
  useEffect(() => {
    if (!keyed.current) return;
    keyed.current = false;
    grid.current?.querySelector<HTMLElement>(`[data-day="${anchor}"]`)?.focus();
  }, [anchor, month]);
  function keys(e: React.KeyboardEvent) {
    const step: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -7,
      ArrowDown: 7,
    };
    if (!(e.key in step)) return;
    e.preventDefault();
    e.stopPropagation();
    keyed.current = true;
    onPick(addDays(anchor, step[e.key]));
  }
  return (
    <div className="cal-mini">
      <header>
        <strong>{dayLabel(month, { month: 'long', year: 'numeric' })}</strong>
        <span className="actions">
          <IconButton
            size="xs"
            label="Previous month"
            icon={ChevronLeft}
            onClick={() => setMonth(shiftAnchor('month', month, -1))}
          />
          <IconButton
            size="xs"
            label="Next month"
            icon={ChevronRight}
            onClick={() => setMonth(shiftAnchor('month', month, 1))}
          />
        </span>
      </header>
      <div
        className="cal-mini-grid"
        ref={grid}
        onKeyDown={keys}
        role="grid"
        aria-label="Choose a day"
      >
        {days.slice(0, 7).map(day => (
          <span key={'h' + day} className="cal-mini-dow" aria-hidden="true">
            {dayLabel(day, { weekday: 'narrow' })}
          </span>
        ))}
        {days.map(day => (
          <button
            key={day}
            data-day={day}
            tabIndex={day === anchor ? 0 : -1}
            aria-current={day === today ? 'date' : undefined}
            aria-label={dayLabel(day, { weekday: 'long', month: 'long', day: 'numeric' })}
            className={cx(
              day.slice(0, 7) !== month.slice(0, 7) && 'is-outside',
              day >= from && day <= to && range.length === 7 && 'in-range',
              range.length === 7 && day === from && 'range-start',
              range.length === 7 && day === to && 'range-end',
              day === anchor && 'is-anchor',
              day === today && 'is-today',
            )}
            onClick={() => onPick(day)}
          >
            {Number(day.slice(8))}
            {busy.has(day) && <i aria-hidden="true" />}
          </button>
        ))}
      </div>
    </div>
  );
});

/** Calendars grouped by account, each with its colour. Click to show or hide; "Only" isolates one. */
const CalendarList = memo(function CalendarList({
  accounts,
  sources,
  visible,
  onToggle,
  onOnly,
}: {
  accounts: Account[];
  sources: CalendarSource[];
  visible: Set<string>;
  onToggle: (key: string) => void;
  onOnly: (key: string) => void;
}) {
  const groups = accounts
    .map(account => ({ account, list: sources.filter(s => s.accountId === account.id) }))
    .filter(g => g.list.length);
  if (!groups.length)
    return (
      <p className="cal-rail-note">
        No calendars yet. Connect an account with Calendar in Settings → Accounts.
      </p>
    );
  return (
    <div className="cal-list">
      {groups.map(({ account, list }) => (
        <section key={account.id} aria-label={accountLabel(account)}>
          <h3>
            <span className="account-dot" style={{ background: account.color }} />
            {accountLabel(account)}
            {account.provider === 'demo' && <small>{account.email}</small>}
          </h3>
          {list.map(s => {
            const on = visible.has(s.key);
            const alone = on && visible.size === 1;
            return (
              <div key={s.key} className={cx('cal-source', !on && 'is-off')}>
                <button
                  role="checkbox"
                  aria-checked={on}
                  className="cal-source-toggle"
                  style={eventStyle(s.color)}
                  onClick={e => {
                    if (e.altKey) onOnly(s.key);
                    else onToggle(s.key);
                  }}
                >
                  <span className="cal-swatch">{on && <Check size={10} />}</span>
                  <span className="cal-source-name">{s.name}</span>
                </button>
                <button className="cal-only" onClick={() => onOnly(s.key)}>
                  {alone ? 'Show all' : 'Only'}
                </button>
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
});

/** The quick editor for a plan drawn on the grid: a title and a calendar, or the full editor. */
function QuickCreate({
  draft,
  sources,
  accounts,
  onCalendar,
  onClose,
  onMore,
}: {
  draft: DraftEvent;
  sources: CalendarSource[];
  accounts: Account[];
  onCalendar: (key: string) => void;
  onClose: () => void;
  onMore: (event: Partial<CalendarEvent>) => void;
}) {
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // The popover stays hidden until it is placed, and a hidden field cannot take focus, so focus once it shows.
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => field.current?.focus({ preventScroll: true }));
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  const source = sources.find(s => s.key === draft.calendar);
  const value = (): Partial<CalendarEvent> => ({
    id: uid(),
    accountId: source?.accountId,
    calendarId: source?.id,
    title: title.trim(),
    start: draft.start,
    end: draft.end,
    allDay: draft.allDay,
    location: '',
    description: '',
    guests: [],
  });
  async function save() {
    if (!title.trim()) {
      setError('Give this event a title.');
      return;
    }
    if (!source) return;
    setBusy(true);
    setError('');
    try {
      await invoke('calendar.save', { event: value() });
      localStorage.setItem(lastCalendarKey, source.key);
      toast.show({ text: `Added to ${source.name}` });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const day = dayKey(draft.start);
  return (
    <div
      className="cal-quick"
      onKeyDown={e => {
        if (
          e.key === 'Enter' &&
          !e.nativeEvent.isComposing &&
          (e.target as HTMLElement).tagName === 'INPUT'
        ) {
          e.preventDefault();
          void save();
        }
      }}
    >
      <input
        ref={field}
        className="cal-quick-title"
        aria-label="Event title"
        placeholder="New event"
        aria-invalid={!!error || undefined}
        value={title}
        onChange={e => {
          setTitle(e.target.value);
          setError('');
        }}
      />
      <p className="cal-card-line">
        <Clock size={14} />
        <span>
          {dayLabel(day, { weekday: 'short', month: 'short', day: 'numeric' })} · {timeRange(draft)}
        </span>
      </p>
      <div className="cal-card-line cal-quick-calendar">
        <span className="cal-swatch is-on" style={eventStyle(source?.color)} />
        <Select
          label="Calendar"
          value={draft.calendar}
          options={sources.map(
            s =>
              [
                s.key,
                calendarLabel(
                  s,
                  accounts.find(a => a.id === s.accountId),
                ),
              ] as [string, string],
          )}
          onChange={key => {
            onCalendar(key);
            localStorage.setItem(lastCalendarKey, key);
          }}
        />
      </div>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <footer>
        <Button variant="text" size="sm" onClick={() => onMore(value())}>
          More options
        </Button>
        <Button variant="primary" size="sm" shortcut="↵" loading={busy} onClick={() => void save()}>
          Save
        </Button>
      </footer>
    </div>
  );
}

/** An event's details beside it, with edit, delete and the email it came from. */
function EventCard({
  event,
  source,
  account,
  onEdit,
  onDelete,
  onThread,
  onClose,
}: {
  event: CalendarEvent;
  source?: CalendarSource;
  account?: Account;
  onEdit: () => void;
  onDelete: () => void;
  onThread: (id: string) => void;
  onClose: () => void;
}) {
  const locked = !!event.scheduling;
  const day = event.allDay ? event.start.slice(0, 10) : dayKey(event.start);
  const host =
    account?.provider === 'google'
      ? 'Google Calendar'
      : account?.provider === 'microsoft'
        ? 'Outlook'
        : 'your calendar';
  return (
    <div className="cal-card">
      <header>
        <span className="cal-swatch is-on" style={eventStyle(source?.color)} />
        <span className="cal-card-calendar">
          {source?.name ?? 'Calendar'}
          {accountLabel(account) !== source?.name && <small>{accountLabel(account)}</small>}
        </span>
        <span className="actions">
          {!locked && (
            <IconButton
              size="sm"
              label="Edit event"
              shortcut="E"
              icon={SquarePen}
              onClick={onEdit}
            />
          )}
          {!locked && (
            <IconButton
              size="sm"
              label="Delete event"
              shortcut="⌫"
              icon={Trash2}
              onClick={onDelete}
            />
          )}
          <IconButton size="sm" label="Close" shortcut="Esc" icon={X} onClick={onClose} />
        </span>
      </header>
      <h3>{event.title || 'Untitled'}</h3>
      <p className="cal-card-when">
        {dayLabel(day, { weekday: 'long', month: 'long', day: 'numeric' })}
        <span>{timeRange(event)}</span>
      </p>
      {event.location && (
        <p className="cal-card-line">
          <MapPin size={14} />
          <span>{event.location}</span>
        </p>
      )}
      {event.guests.length > 0 && (
        <p className="cal-card-line">
          <Users size={14} />
          <span>
            {event.guests.slice(0, 3).join(', ')}
            {event.guests.length > 3 ? ` and ${event.guests.length - 3} more` : ''}
          </span>
        </p>
      )}
      {event.description && <p className="cal-card-notes">{event.description}</p>}
      {locked && (
        <p className="cal-card-note">
          A meeting with guests. Change it in {host}, so they hear about it.
        </p>
      )}
      {(event.threadId || event.url) && (
        <footer>
          {event.threadId && (
            <Button
              variant="tinted"
              size="sm"
              icon={Mail}
              onClick={() => {
                onClose();
                onThread(event.threadId!);
              }}
            >
              View email
            </Button>
          )}
          {event.url && (
            <Button
              variant="text"
              size="sm"
              iconRight={ExternalLink}
              onClick={() =>
                void openUrl(event.url!).catch(e => toast.show({ tone: 'error', text: e.message }))
              }
            >
              Open in {host}
            </Button>
          )}
        </footer>
      )}
    </div>
  );
}
