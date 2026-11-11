/**
 * The Calendar screen (DESIGN 7.8): the data-bound container the shell mounts. It reads `renderer/data` hooks
 * (`useView` for the events and plans windows, `api.calendar.get` for the legend), feeds `calendar.model.ts`, runs
 * the reducer's effects through `effects.ts`, and attaches the catalog's `calendar.*` commands to the shell's one
 * registry. Every key, click and drag goes through `update` first (state on keydown, DESIGN 5 rule 1); the contract
 * call runs next.
 *
 * The screen publishes its sidebar block through the shell's `useSidebarSlot` (`calendarSidebar` produces the props)
 * and hides events through `api.event.hide`. Meeting links open through `api.shell.open` (main's external() gate).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CommandContext } from '../../commands';
import {
  api,
  toIsoDate,
  useAccounts,
  useAccountsLoaded,
  useNow,
  useSettings,
  useView,
  type AccountId,
  type Calendar,
  type Event,
  type Plan,
  type State,
} from '../../data';
import {
  openSheet,
  useCommandTarget,
  usePaneHeaderPart,
  useRegisterCommands,
  useShellKeyLayer,
  useSidebarSlot,
  type CommandHandlerTable,
} from '../../shell';
import { Reopenable } from '../lists/Reopenable';
import { ListFailed } from '../lists/ListStates';
import type { Announce } from '../../ui/props';
import {
  actionForCommand,
  CALENDAR_COMMAND_IDS,
  commandEnabled,
  commandTarget,
  defaultCalendarId,
  detailIsFor,
  EMPTY_OVERLAY,
  entriesFor,
  eventsRange,
  initialState,
  inviteOpen,
  overlayWith,
  overlayWithout,
  periodOf,
  plansSpec,
  reached,
  reconcileShown,
  shownView,
  update,
  viewModel,
  weekStartsOnFor,
  type CalendarAction,
  type CalendarCommandId,
  type CalendarContext,
  type CalendarEffect,
  type CalendarState,
  type EditorDraft,
  type OptimisticChange,
  type Overlay,
  type ShownOverride,
} from './calendar.model';
import { CalendarView, CALENDAR_PANE_TOOLS, type FocusRequest } from './CalendarView';
import { useOpenPlanTarget } from './useOpenPlanTarget';
import {
  createTurnGate,
  inCalendarSurface,
  INVITE_ANSWER_KEYS,
  ladderTakesEscape,
  ownsReturn,
  ownsSideArrows,
  takesInviteAnswerKey,
  type ElementLike,
} from './keys';
import {
  cancelPendingRetries,
  livePorts,
  runCalendarEffect,
  type EffectPorts,
  type EffectUi,
  type WatchedWrite,
} from './effects';
import { HeldWrites } from './HeldWrites';
import { calendarSidebar } from './sidebar';
import { calendarListedKey } from './accountCalendarState';

export interface CalendarScreenProps {
  /** One account, or absent for all accounts (the account scope). */
  readonly accountId?: AccountId;
  /** The shell's polite live region. */
  readonly announce?: Announce;
}

/** An overlay entry stays until a window frame reaches the write's state (ARCH 9.2), or until it fails or is undone. */
interface Settling {
  readonly id: string;
  readonly at: State | null;
}

const focused = (): ElementLike | null =>
  typeof document === 'undefined' ? null : (document.activeElement as ElementLike | null);

/** The period commands rest while focus is in a widget that moves with ←/→ itself (keys.ts, review1 4c). */
const PERIOD_COMMANDS: ReadonlySet<CalendarCommandId> = new Set([
  'calendar.nextPeriod',
  'calendar.previousPeriod',
]);

/**
 * The calendar list: one `Calendar/get`, re-read after bursts of engine state changes (a toggle and its undo
 * included) and when `listedKey` says an account's calendar list was read — a first list commits rows plus
 * the stamp in one engine commit that touches no events window, so without the key the sidebar would say
 * "No calendars" beside calendars that now exist.
 */
function useCalendars(
  accountId: AccountId | undefined,
  touched: string,
  listedKey: string,
): readonly Calendar[] | undefined {
  const [list, setList] = useState<readonly Calendar[] | undefined>(undefined);
  const get = useCallback(() => {
    api.calendar.get(accountId ? { accountId } : {}).then(
      result => setList(result.list),
      () => undefined,
    );
  }, [accountId]);
  useEffect(get, [get, listedKey]);
  useEffect(() => {
    if (touched === '') return undefined;
    const timer = setTimeout(get, 400);
    return () => clearTimeout(timer);
  }, [get, touched]);
  return list;
}

/** Runs the model's Esc ladder from a capture listener and takes the key only when a rung handled it (keys.ts). */
function useEscapeLadder(dispatch: (action: CalendarAction) => boolean) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const root = document.querySelector('.cal-screen');
      const active = document.activeElement;
      const inScreen =
        active === null || active === document.body || (root?.contains(active) ?? false);
      // A ghost track exists only while a drag is under way (TimeGrid); Esc cancels it before the ladder.
      const dragging = root?.querySelector('.ui-calendar-grid__drag') != null;
      if (!ladderTakesEscape(event, active, inScreen, dragging)) return;
      if (!dispatch({ type: 'escape' })) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [dispatch]);
}

/**
 * Answers an open invite on Y/M/N from a capture listener (keys.ts): the detail popover's role=dialog is a modal
 * context over `calendar`, so the registry's answer keys end there and never reach the handler. The key is taken only
 * while the model's answer is live, so M and N still mean Month and New event the rest of the time.
 */
function useInviteAnswerKeys(dispatch: (action: CalendarAction) => boolean) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const root = document.querySelector('.cal-screen');
      const active = document.activeElement;
      const inScreen =
        active === null || active === document.body || (root?.contains(active) ?? false);
      // Only the screen or its own popover/menus — never another dialog, sheet or palette (review1 11).
      if (!takesInviteAnswerKey(event, active, inScreen || inCalendarSurface(active))) return;
      const answer = INVITE_ANSWER_KEYS[event.key];
      if (!answer || !dispatch({ type: 'answer', answer })) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [dispatch]);
}

function CalendarBody({ accountId, announce }: CalendarScreenProps) {
  const now = useNow({ granularity: 'minute' });
  const settings = useSettings();
  const [state, setState] = useState<CalendarState>(() => initialState(toIsoDate(now)));
  const [overlay, setOverlay] = useState<Overlay>(EMPTY_OVERLAY);
  const [settling, setSettling] = useState<readonly Settling[]>([]);
  // Accepted writes whose operations are still being followed through the provider queue (HeldWrites).
  const [watched, setWatched] = useState<readonly WatchedWrite[]>([]);
  const [focus, setFocus] = useState<FocusRequest | null>(null);
  const [shownOverride, setShownOverride] = useState<ReadonlyMap<string, ShownOverride>>(new Map());

  const weekStartsOn = weekStartsOnFor(
    settings?.ui.calendar.weekStart,
    typeof navigator === 'undefined' ? undefined : navigator.language,
  );
  const period = periodOf(shownView(state), state.anchor, weekStartsOn);
  const { from: periodFrom, to: periodTo } = period;

  // The window reaches today plus the two-week lookahead, so an empty period can still say what comes next
  // (DESIGN 7.14) without a second watch; `eventsRange` falls back to the plain period past the 62-day cap.
  const range = eventsRange(period, now);
  const eventsWindow = useView({ kind: 'events', from: range.from, to: range.to });
  const plansWindow = useView(plansSpec(period));
  const touched = eventsWindow.state
    ? `${eventsWindow.state.dbEpoch}:${eventsWindow.state.seq}`
    : '';
  // The sidebar's accounts block reads the accounts this view draws from — scoped when the screen is — and
  // their list stamps trigger a re-read of the once-fetched calendar list.
  const accounts = useAccounts();
  const accountsLoaded = useAccountsLoaded();
  const loaded = useCalendars(accountId, touched, calendarListedKey(accounts));
  const calendars = useMemo(
    () =>
      (loaded ?? []).map(c =>
        shownOverride.has(c.id) ? { ...c, shown: shownOverride.get(c.id)!.shown } : c,
      ),
    [loaded, shownOverride],
  );

  // Drop an override once a resolved `Calendar/get` reflects it or the write settled; a refused write is rolled
  // back by `shownFailed` (review1 5). Later engine-side changes then flow through again.
  useEffect(() => {
    if (loaded !== undefined) setShownOverride(m => reconcileShown(m, loaded));
  }, [loaded]);

  const events = useMemo(
    () =>
      eventsWindow.ids
        .map(id => eventsWindow.rows.get(id))
        .filter((e): e is Event => e !== undefined),
    [eventsWindow.ids, eventsWindow.rows],
  );
  const plans = useMemo(
    () =>
      plansWindow.ids.map(id => plansWindow.rows.get(id)).filter((p): p is Plan => p !== undefined),
    [plansWindow.ids, plansWindow.rows],
  );
  const defaultId = defaultCalendarId(calendars, settings?.calendar.defaultCalendarId, state.solo);
  const entries = useMemo(
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
  const ctx: CalendarContext = useMemo(
    () => ({
      now,
      weekStartsOn,
      entries,
      events: new Map(events.map(e => [e.id, e])),
      plans: new Map(plans.map(p => [p.id, p])),
      calendars,
      accounts,
      loadedThrough: range.to,
      defaultCalendarId: defaultId,
      calendarsReady: loaded !== undefined,
      // Same conditions the render gates use below: while the pane draws nothing, no command may run.
      windowReady:
        eventsWindow.status !== 'failed' &&
        (eventsWindow.status !== 'opening' || events.length > 0),
    }),
    [
      now,
      weekStartsOn,
      entries,
      events,
      plans,
      calendars,
      accounts,
      range.to,
      defaultId,
      loaded,
      eventsWindow.status,
    ],
  );

  // Drop overlay entries once the events window has caught up with their writes.
  useEffect(() => {
    const caughtUp = settling.filter(s => reached(eventsWindow.state, s.at));
    if (caughtUp.length === 0) return;
    setOverlay(o => caughtUp.reduce((acc, s) => overlayWithout(acc, s.id), o));
    setSettling(list => list.filter(s => !caughtUp.includes(s)));
  }, [eventsWindow.state, settling]);

  // The reducer reads the newest state and context even when several keys land in one frame.
  const stateRef = useRef(state);
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  stateRef.current = state;

  const ports: EffectPorts = useMemo(livePorts, []);
  // `apply` is defined below (run → ui → apply would be circular); the ref is assigned each render.
  const applyRef = useRef<(action: CalendarAction) => boolean>(() => false);
  const ui: EffectUi = useMemo(
    () => ({
      optimistic: (change: OptimisticChange) => setOverlay(o => overlayWith(o, change)),
      settle: (id: string, at: State | null) => setSettling(list => [...list, { id, at }]),
      rollback: (id: string) => setOverlay(o => overlayWithout(o, id)),
      shown: (id: string, shown: boolean) =>
        setShownOverride(m => new Map(m).set(id, { shown, settled: false })),
      shownSettled: (id: string) =>
        setShownOverride(m => {
          const o = m.get(id);
          return o === undefined || o.settled ? m : new Map(m).set(id, { ...o, settled: true });
        }),
      shownFailed: (id: string) =>
        setShownOverride(m => {
          if (!m.has(id)) return m;
          const next = new Map(m);
          next.delete(id);
          return next;
        }),
      focus: (target: 'grid' | 'rail') => setFocus(f => ({ target, seq: (f?.seq ?? 0) + 1 })),
      reopenEditor: (eventId: string, note: string) =>
        applyRef.current({ type: 'reopenEditor', eventId, note }),
      restoreEditor: (draft: EditorDraft, note: string) =>
        applyRef.current({ type: 'restoreEditor', draft, note }),
      closeDetail: (eventId: string) => {
        if (detailIsFor(stateRef.current, eventId)) applyRef.current({ type: 'close' });
      },
      watch: (write: WatchedWrite) => setWatched(list => [...list, write]),
    }),
    [],
  );
  const unwatch = useCallback(
    (write: WatchedWrite) => setWatched(list => list.filter(w => w !== write)),
    [],
  );

  const run = useCallback((fx: CalendarEffect) => runCalendarEffect(fx, ports, ui), [ports, ui]);
  // A delayed retry waiting out retryAfterMs dies with the screen: no surprise write fires later (review7 9).
  useEffect(() => cancelPendingRetries, []);
  const apply = useCallback(
    (action: CalendarAction): boolean => {
      const t = update(stateRef.current, action, ctxRef.current);
      if (t.state !== stateRef.current) {
        stateRef.current = t.state;
        setState(t.state);
      }
      t.effects.forEach(run);
      return t.handled;
    },
    [run],
  );
  applyRef.current = apply;
  useOpenPlanTarget(apply, entries);

  // Return: CalendarGrid opens its selection itself and the registry's calendar.open runs on the same key; the
  // first of the two in one turn acts (keys.ts). A double-click is its own turn.
  const returnGate = useMemo(() => createTurnGate(), []);
  const dispatch = useCallback(
    (action: CalendarAction): boolean => {
      if (action.type === 'open' && action.id !== undefined && !returnGate.claim()) return true;
      return apply(action);
    },
    [apply, returnGate],
  );

  // The catalog's calendar commands: keys, the palette and menus all land in the same reducer.
  const handlers = useMemo<CommandHandlerTable>(
    () =>
      Object.fromEntries(
        CALENDAR_COMMAND_IDS.map(id => [
          id,
          {
            when: () =>
              commandEnabled(id, stateRef.current, ctxRef.current) &&
              !(PERIOD_COMMANDS.has(id) && ownsSideArrows(focused())),
            run: (command: CommandContext) => {
              // Return on a focused "+N" or any button activates the button itself; the command defers (review1 13).
              if (id === 'calendar.open' && command.trigger) {
                if (ownsReturn(focused())) return;
                if (!returnGate.claim()) return;
              }
              apply(actionForCommand(id));
            },
          },
        ]),
      ),
    [apply, returnGate],
  );
  useRegisterCommands(handlers);
  useEscapeLadder(apply);
  useInviteAnswerKeys(apply);

  useShellKeyLayer({ conditions: { invite: inviteOpen(state, ctx) } });
  useCommandTarget(commandTarget(state, ctx));
  const headerPart = useMemo(() => ({ tools: CALENDAR_PANE_TOOLS }), []);
  usePaneHeaderPart(headerPart);

  // The sidebar's busy marks read the whole loaded events window on the visible calendars, not the drawn
  // period (review1 7); the props are memoized so the slot re-renders only when they change (review1 14).
  const windowEntries = useMemo(
    () =>
      entriesFor({
        events,
        plans,
        calendars,
        solo: state.solo,
        period: { from: range.from, to: range.to },
        planCalendarId: defaultId,
        overlay,
      }),
    [events, plans, calendars, state.solo, range.from, range.to, defaultId, overlay],
  );
  const today = toIsoDate(now);
  const shownAccounts = useMemo(
    () => (accountId ? accounts.filter(a => a.id === accountId) : accounts),
    [accounts, accountId],
  );
  // "Allow calendar access" and "Sign in again" open the shell's one reconnect sheet (grant vs reconnect).
  const accessAction = useCallback(
    (id: string, mode: 'reconnect' | 'grant') => openSheet('reconnect', { accountId: id, mode }),
    [],
  );
  // The shell's sidebar slot (PR #271): MiniMonth, the Calendars list and the accounts block under the place
  // groups. Null while the pane draws nothing (opening, or the failed window), and the hook clears it when the
  // screen unmounts.
  const sidebar = useMemo(
    () =>
      ctx.windowReady
        ? calendarSidebar({
            state,
            calendars,
            entries: windowEntries,
            today,
            weekStartsOn,
            dispatch,
            accounts: shownAccounts,
            accountsLoaded,
            calendarsLoaded: loaded !== undefined,
            onAccessAction: accessAction,
          })
        : null,
    [
      ctx.windowReady,
      state,
      calendars,
      windowEntries,
      today,
      weekStartsOn,
      dispatch,
      shownAccounts,
      accountsLoaded,
      loaded,
      accessAction,
    ],
  );
  useSidebarSlot(sidebar);

  // The watchers read the window's own id list so a held create's tmp entry drops the moment its
  // real row lands (HeldWrites).
  const eventIds = useMemo(() => new Set(eventsWindow.ids), [eventsWindow.ids]);

  if (eventsWindow.status === 'failed') return <ListFailed errorType={eventsWindow.error?.type} />;
  if (eventsWindow.status === 'opening' && events.length === 0) return null;
  return (
    <>
      <CalendarView
        vm={viewModel(state, ctx)}
        dispatch={dispatch}
        announce={announce}
        focus={focus}
      />
      <HeldWrites watches={watched} eventIds={eventIds} ui={ui} ports={ports} unwatch={unwatch} />
    </>
  );
}

export function CalendarScreen(props: CalendarScreenProps) {
  return (
    <Reopenable>
      <CalendarBody {...props} />
    </Reopenable>
  );
}
