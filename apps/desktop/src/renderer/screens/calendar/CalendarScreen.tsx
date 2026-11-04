/**
 * The Calendar screen (DESIGN 7.8): the data-bound container the shell mounts. It reads `renderer/data` hooks
 * (`useView` for the events and plans windows, `api.calendar.get` for the legend), feeds `calendar.model.ts`, runs
 * the reducer's effects through `effects.ts`, and attaches the catalog's `calendar.*` commands to the shell's one
 * registry. Every key, click and drag goes through `update` first (state on keydown, DESIGN 5 rule 1); the contract
 * call runs next.
 *
 * REQUESTs to other lanes (see the lane report): a sidebar slot for the MiniMonth and Calendars list
 * (`calendarSidebar` produces their props; `CalendarSidebar` in `CalendarStates.tsx` draws them for shots), the
 * screen mount in `App.tsx`'s `renderScreen`, `api.event.hide` on the data surface, and a shell open-url port.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CommandContext } from '../../commands';
import {
  api,
  toIsoDate,
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
  useCommandTarget,
  usePaneHeaderPart,
  useRegisterCommands,
  useShellKeyLayer,
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
  EMPTY_OVERLAY,
  entriesFor,
  initialState,
  inviteOpen,
  overlayWith,
  overlayWithout,
  periodOf,
  plansSpec,
  shownView,
  update,
  viewModel,
  weekStartsOnFor,
  type CalendarAction,
  type CalendarCommandId,
  type CalendarContext,
  type CalendarEffect,
  type CalendarState,
  type OptimisticChange,
  type Overlay,
} from './calendar.model';
import { CalendarView, CALENDAR_PANE_TOOLS, type FocusRequest } from './CalendarView';
import { createTurnGate, ladderTakesEscape, ownsSideArrows, type ElementLike } from './keys';
import {
  hideAvailable,
  livePorts,
  runCalendarEffect,
  type EffectPorts,
  type EffectUi,
} from './effects';
import { calendarSidebar, type CalendarSidebar } from './sidebar';

export interface CalendarScreenProps {
  /** One account, or absent for all accounts (the account scope). */
  readonly accountId?: AccountId;
  /** The shell's polite live region. */
  readonly announce?: Announce;
  /** The sidebar's MiniMonth and Calendars list, until the shell grows a slot for them (REQUEST). */
  readonly renderSidebar?: (sidebar: CalendarSidebar) => void;
}

/** An overlay entry stays until a window frame reaches the write's state (ARCH 9.2), or until it fails or is undone. */
interface Settling {
  readonly id: string;
  readonly at: State | null;
}

const reached = (window: State | null, at: State | null): boolean =>
  window !== null && at !== null && window.dbEpoch === at.dbEpoch && window.seq >= at.seq;

const focused = (): ElementLike | null =>
  typeof document === 'undefined' ? null : (document.activeElement as ElementLike | null);

/** The period commands rest while focus is in a widget that moves with ←/→ itself (keys.ts, review1 4c). */
const PERIOD_COMMANDS: ReadonlySet<CalendarCommandId> = new Set([
  'calendar.nextPeriod',
  'calendar.previousPeriod',
]);

/** The calendar list: one `Calendar/get`, re-read after bursts of engine state changes (a toggle and its undo included). */
function useCalendars(
  accountId: AccountId | undefined,
  touched: string,
): readonly Calendar[] | undefined {
  const [list, setList] = useState<readonly Calendar[] | undefined>(undefined);
  const get = useCallback(() => {
    api.calendar.get(accountId ? { accountId } : {}).then(
      result => setList(result.list),
      () => undefined,
    );
  }, [accountId]);
  useEffect(get, [get]);
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
      if (!ladderTakesEscape(event, active, inScreen)) return;
      if (!dispatch({ type: 'escape' })) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [dispatch]);
}

function CalendarBody({ accountId, announce, renderSidebar }: CalendarScreenProps) {
  const now = useNow({ granularity: 'minute' });
  const settings = useSettings();
  const [state, setState] = useState<CalendarState>(() => initialState(toIsoDate(now)));
  const [overlay, setOverlay] = useState<Overlay>(EMPTY_OVERLAY);
  const [settling, setSettling] = useState<readonly Settling[]>([]);
  const [focus, setFocus] = useState<FocusRequest | null>(null);
  const [shownOverride, setShownOverride] = useState<ReadonlyMap<string, boolean>>(new Map());

  const weekStartsOn = weekStartsOnFor(
    settings?.ui.calendar.weekStart,
    typeof navigator === 'undefined' ? undefined : navigator.language,
  );
  const period = periodOf(shownView(state), state.anchor, weekStartsOn);
  const { from: periodFrom, to: periodTo } = period;

  const eventsWindow = useView({ kind: 'events', from: periodFrom, to: periodTo });
  const plansWindow = useView(plansSpec(period));
  const touched = eventsWindow.state
    ? `${eventsWindow.state.dbEpoch}:${eventsWindow.state.seq}`
    : '';
  const loaded = useCalendars(accountId, touched);
  const calendars = useMemo(
    () =>
      (loaded ?? []).map(c =>
        shownOverride.has(c.id) ? { ...c, shown: shownOverride.get(c.id)! } : c,
      ),
    [loaded, shownOverride],
  );

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
  const defaultId = defaultCalendarId(calendars, settings?.calendar.defaultCalendarId);
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
      defaultCalendarId: defaultId,
      canHide: hideAvailable(),
    }),
    [now, weekStartsOn, entries, events, plans, calendars, defaultId],
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
  const ui: EffectUi = useMemo(
    () => ({
      optimistic: (change: OptimisticChange) => setOverlay(o => overlayWith(o, change)),
      settle: (id: string, at: State | null) => setSettling(list => [...list, { id, at }]),
      rollback: (id: string) => setOverlay(o => overlayWithout(o, id)),
      shown: (id: string, shown: boolean) => setShownOverride(m => new Map(m).set(id, shown)),
      focus: (target: 'grid' | 'rail') => setFocus(f => ({ target, seq: (f?.seq ?? 0) + 1 })),
    }),
    [],
  );

  const run = useCallback((fx: CalendarEffect) => runCalendarEffect(fx, ports, ui), [ports, ui]);
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
              if (id === 'calendar.open' && command.trigger && !returnGate.claim()) return;
              apply(actionForCommand(id));
            },
          },
        ]),
      ),
    [apply, returnGate],
  );
  useRegisterCommands(handlers);
  useEscapeLadder(apply);

  useShellKeyLayer({ conditions: { invite: inviteOpen(state, ctx) } });
  useCommandTarget(commandTarget(state, ctx));
  const headerPart = useMemo(() => ({ tools: CALENDAR_PANE_TOOLS }), []);
  usePaneHeaderPart(headerPart);
  useEffect(() => {
    renderSidebar?.(
      calendarSidebar({ state, calendars, entries, today: toIsoDate(now), weekStartsOn, dispatch }),
    );
  });

  if (eventsWindow.status === 'failed') return <ListFailed />;
  if (eventsWindow.status === 'opening' && events.length === 0) return null;
  return (
    <CalendarView
      vm={viewModel(state, ctx)}
      dispatch={dispatch}
      announce={announce}
      focus={focus}
    />
  );
}

export function CalendarScreen(props: CalendarScreenProps) {
  return (
    <Reopenable>
      <CalendarBody {...props} />
    </Reopenable>
  );
}
