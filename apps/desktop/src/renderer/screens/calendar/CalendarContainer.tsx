/**
 * The Calendar screen's container (thin): reads `renderer/data` hooks, feeds `calendar.model.ts`, runs the effects the
 * reducer returns, and attaches the catalog's `calendar.*` commands to the registry. Every key, click and drag goes
 * through `update` first (state on keydown, DESIGN 5 rule 1), then the contract call runs optimistically.
 *
 * What `renderer/data` and `renderer/shell` don't offer yet comes in through `CalendarPorts` (REQUESTs to ui-shell):
 * the `Calendar/get` list, `Event/set|rsvp|hide`, `Calendar/set`, `Plan/confirm|dismiss`, the `invite` key condition,
 * the sidebar slot, opening a thread or a link, and the clipboard. It cannot run until ui-shell lands the data layer.
 * Undoable writes go through `writes.ts`; the interim key guards (←/→, Esc, Return) are in `keys.ts`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CommandContext, Registry } from '../../commands';
import {
  api,
  getNow,
  toIsoDate,
  undoStack,
  useNow,
  useSettings,
  useView,
  type Calendar,
  type CommandArgs,
  type Event,
  type Output,
  type Plan,
  type State,
} from '../../data';
import { dismissToast, pushToast, updateToast, useCommandTarget } from '../../shell';
import type { Announce, ToastKind } from '../../ui/props';
import {
  actionForCommand,
  CALENDAR_COMMAND_IDS,
  commandEnabled,
  commandTarget,
  defaultCalendarId,
  EMPTY_OVERLAY,
  entriesFor,
  eventsSpec,
  initialState,
  inviteOpen,
  overlayWith,
  overlayWithout,
  periodOf,
  plansSpec,
  rsvpMessage,
  shownView,
  update,
  viewModel,
  visibleCalendarIds,
  weekStartsOnFor,
  type CalendarAction,
  type CalendarCommandId,
  type CalendarContext,
  type CalendarEffect,
  type CalendarState,
  type OptimisticChange,
  type Overlay,
} from './calendar.model';
import { CalendarScreen, type FocusRequest } from './CalendarScreen';
import { createTurnGate, ladderTakesEscape, ownsSideArrows, type ElementLike } from './keys';
import { calendarSidebar, type CalendarSidebar } from './sidebar';
import { createWrites, type Writes } from './writes';

/** A contract command through a port: the caller mints the `opId`. */
type PortCall<
  M extends 'Event/set' | 'Event/rsvp' | 'Event/hide' | 'Calendar/set' | 'Plan/confirm' | 'Plan/dismiss',
> = (args: CommandArgs<M> & { readonly opId: string }) => Promise<Output<M>>;

/** What the Calendar container needs that `renderer/data` and `renderer/shell` don't offer yet (REQUESTs to ui-shell). */
export interface CalendarPorts {
  /** The app's command registry, to attach the `calendar.*` handlers. */
  readonly registry: Registry;
  /** `Calendar/get`, live (re-read on a `state` frame for type `Calendar`); undefined until known. */
  readonly useCalendars: () => readonly Calendar[] | undefined;
  /** Puts `invite` in every `CommandContext.conditions` while true, so Y/M/N answer and M means Month otherwise. */
  readonly useInviteCondition: (open: boolean) => void;
  /** Hands the sidebar's MiniMonth and CalendarList props to the shell while Calendar is the route. */
  readonly useSidebar: (sidebar: CalendarSidebar | null) => void;
  readonly event: {
    readonly set: PortCall<'Event/set'>;
    readonly rsvp: PortCall<'Event/rsvp'>;
    readonly hide: PortCall<'Event/hide'>;
  };
  readonly calendar: { readonly set: PortCall<'Calendar/set'> };
  readonly plan: { readonly confirm: PortCall<'Plan/confirm'>; readonly dismiss: PortCall<'Plan/dismiss'> };
  /**
   * True when these writes join the undo stack by themselves, as the data layer's `api.*` writes do; the container then
   * pushes no entry of its own, so one write is one Z.
   */
  readonly writesJoinUndo?: boolean;
  /** Opens a thread in the reader (an invite email, a plan's source). */
  readonly openThread: (threadId: string) => void;
  /** `Shell/open`: a meeting link in the browser. */
  readonly openUrl: (url: string) => void;
  readonly copyText: (text: string) => void;
}

export interface CalendarContainerProps {
  readonly ports: CalendarPorts;
  readonly announce?: Announce;
}

const newOpId = (): string => crypto.randomUUID();

/**
 * A toast's Undo undoes its own write, so it has no `commandId`: with one, the shell would run `app.undo`, which undoes
 * the newest change instead (review1 3). Z still undoes the newest.
 */
const UNDO_ACTION = [{ id: 'undo', label: 'Undo' }] as const;

/** An overlay entry stays until a window frame reaches the write's state (ARCH 9.2), or until it fails or is undone. */
interface Settling {
  readonly id: string;
  readonly at: State | null;
}

const reached = (window: State | null, at: State | null): boolean =>
  window !== null && at !== null && window.dbEpoch === at.dbEpoch && window.seq >= at.seq;

const focused = (): ElementLike | null =>
  typeof document === 'undefined' ? null : (document.activeElement as ElementLike | null);

/** The period commands rest while focus is in a widget that moves with ←/→ itself (keys.ts). */
const PERIOD_COMMANDS: ReadonlySet<CalendarCommandId> = new Set(['calendar.nextPeriod', 'calendar.previousPeriod']);

function useUndoToast(writes: Writes) {
  return useCallback(
    (opId: string, kind: ToastKind, message: string) =>
      pushToast({
        id: opId,
        kind,
        message,
        actions: UNDO_ACTION,
        undoable: true,
        onAction: actionId => {
          if (actionId === 'undo') void writes.undo(opId);
        },
      }),
    [writes],
  );
}

/** Runs the model's Esc ladder from a capture listener and takes the key only when a rung handled it (keys.ts). */
function useEscapeLadder(dispatch: (action: CalendarAction) => boolean) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const root = document.querySelector('.cal-screen');
      const active = document.activeElement;
      const inScreen = active === null || active === document.body || (root?.contains(active) ?? false);
      if (!ladderTakesEscape(event, active, inScreen)) return;
      if (!dispatch({ type: 'escape' })) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [dispatch]);
}

export function CalendarContainer({ ports, announce }: CalendarContainerProps) {
  const now = useNow({ granularity: 'minute' });
  const settings = useSettings();
  const loaded = ports.useCalendars();
  const [shownOverride, setShownOverride] = useState<ReadonlyMap<string, boolean>>(new Map());
  const calendars = useMemo(
    () => (loaded ?? []).map(c => (shownOverride.has(c.id) ? { ...c, shown: shownOverride.get(c.id)! } : c)),
    [loaded, shownOverride],
  );
  const weekStartsOn = weekStartsOnFor(
    settings?.ui.calendar.weekStart,
    typeof navigator === 'undefined' ? undefined : navigator.language,
  );

  const [state, setState] = useState<CalendarState>(() => initialState(toIsoDate(now)));
  const [overlay, setOverlay] = useState<Overlay>(EMPTY_OVERLAY);
  const [settling, setSettling] = useState<readonly Settling[]>([]);
  const [focus, setFocus] = useState<FocusRequest | null>(null);

  const period = periodOf(shownView(state), state.anchor, weekStartsOn);
  const { from: periodFrom, to: periodTo } = period;
  const visible = visibleCalendarIds(calendars, state.solo);
  const eventsWindow = useView(eventsSpec(period, visible));
  const plansWindow = useView(plansSpec(period));
  const events = useMemo(
    () => eventsWindow.ids.map(id => eventsWindow.rows.get(id)).filter((e): e is Event => e !== undefined),
    [eventsWindow.ids, eventsWindow.rows],
  );
  const plans = useMemo(
    () => plansWindow.ids.map(id => plansWindow.rows.get(id)).filter((p): p is Plan => p !== undefined),
    [plansWindow.ids, plansWindow.rows],
  );
  const defaultId = defaultCalendarId(calendars, settings?.calendar.defaultCalendarId);
  // The period by its bounds, so a new object for the same range does not recompute.
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

  const optimistic = useCallback((change: OptimisticChange) => setOverlay(o => overlayWith(o, change)), []);
  const rollback = useCallback((id: string) => setOverlay(o => overlayWithout(o, id)), []);
  const settle = useCallback((id: string, at: State | null) => setSettling(list => [...list, { id, at }]), []);

  const failed = useCallback(
    (opId: string, id: string, message: string, retry: () => void) => {
      rollback(id);
      dismissToast(opId);
      pushToast({
        id: `${opId}:failed`,
        kind: 'info',
        message,
        actions: [{ id: 'retry', label: 'Retry' }],
        undoable: false,
        onAction: actionId => {
          if (actionId === 'retry') retry();
        },
      });
    },
    [rollback],
  );

  const joinsUndo = ports.writesJoinUndo === true;
  const writes = useMemo(
    () =>
      createWrites({
        undoOperation: opId => api.operation.undo({ opId }).receipt,
        rollback,
        settle,
        dismissToast,
        failed,
        ...(joinsUndo
          ? {}
          : { pushUndo: (label: string, undo: () => Promise<void>) => undoStack.push({ label, undo }) }),
      }),
    [rollback, settle, failed, joinsUndo],
  );
  const undoToast = useUndoToast(writes);

  const run = useCallback(
    (fx: CalendarEffect): void => {
      const retry = () => run(fx);
      switch (fx.kind) {
        case 'eventSet': {
          const opId = newOpId();
          optimistic(fx.optimistic);
          if (fx.toast) undoToast(opId, fx.toast.kind, fx.toast.message);
          writes.start({
            opId,
            entryId: fx.optimistic.id,
            label: fx.undoLabel,
            call: () => ports.event.set({ opId, change: fx.change }).then(out => out.receipt.appliedState),
            failure: fx.failure,
            retry,
          });
          return;
        }
        case 'rsvp': {
          const opId = newOpId();
          const held = rsvpMessage(fx.answer, fx.organizer, 'held');
          optimistic(fx.optimistic);
          undoToast(opId, 'done', held);
          writes.start({
            opId,
            entryId: fx.id,
            label: held,
            call: () =>
              ports.event.rsvp({ opId, id: fx.id, response: fx.response, scope: fx.scope }).then(receipt => {
                // Sent at once (no hold): the toast says so.
                if (receipt.undoUntil === undefined || receipt.undoUntil <= getNow())
                  updateToast(opId, { message: rsvpMessage(fx.answer, fx.organizer, 'sent') });
                return receipt.appliedState;
              }),
            failure: fx.failure,
            retry,
          });
          return;
        }
        case 'calendarSet': {
          const clear = () =>
            setShownOverride(m => {
              const next = new Map(m);
              next.delete(fx.id);
              return next;
            });
          setShownOverride(m => new Map(m).set(fx.id, fx.shown));
          ports.calendar.set({ opId: newOpId(), id: fx.id, shown: fx.shown }).then(clear, clear);
          return;
        }
        case 'planConfirm': {
          const opId = newOpId();
          optimistic(fx.optimistic);
          writes.start({
            opId,
            entryId: fx.optimistic.id,
            label: 'Added to Calendar',
            call: () =>
              ports.plan
                .confirm({ opId, id: fx.planId, ...(fx.calendarId ? { calendarId: fx.calendarId } : {}) })
                .then(out => out.receipt.appliedState),
            failure: "Couldn't add it to the calendar.",
            retry,
          });
          return;
        }
        case 'planDismiss': {
          const opId = newOpId();
          optimistic(fx.optimistic);
          writes.start({
            opId,
            entryId: fx.optimistic.id,
            label: 'Not added',
            call: () => ports.plan.dismiss({ opId, ids: [fx.planId] }).then(receipt => receipt.appliedState),
            retry,
          });
          return;
        }
        case 'eventHide': {
          const opId = newOpId();
          optimistic(fx.optimistic);
          undoToast(opId, fx.toast.kind, fx.toast.message);
          writes.start({
            opId,
            entryId: fx.id,
            label: fx.toast.message,
            call: () => ports.event.hide({ opId, ids: [fx.id], hidden: true }).then(r => r.appliedState),
            failure: "Couldn't hide it.",
            retry,
          });
          return;
        }
        case 'openThread':
          ports.openThread(fx.threadId);
          return;
        case 'openUrl':
          ports.openUrl(fx.url);
          return;
        case 'copy':
          ports.copyText(fx.text);
          pushToast({ id: newOpId(), kind: fx.toast.kind, message: fx.toast.message, undoable: false });
          return;
        case 'notice':
          pushToast({ id: newOpId(), kind: 'info', message: fx.message, undoable: false });
          return;
        case 'focus':
          setFocus(f => ({ target: fx.target, seq: (f?.seq ?? 0) + 1 }));
          return;
      }
    },
    [ports, optimistic, writes, undoToast],
  );

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

  // Return: CalendarGrid opens its selection itself and the registry's calendar.open runs on the same key; the first
  // of the two in one turn acts (keys.ts). A double-click is its own turn.
  const returnGate = useMemo(() => createTurnGate(), []);
  const dispatch = useCallback(
    (action: CalendarAction): boolean => {
      if (action.type === 'open' && action.id !== undefined && !returnGate.claim()) return true;
      return apply(action);
    },
    [apply, returnGate],
  );

  // The catalog's calendar commands: keys, the palette and menus all land in the same reducer.
  useEffect(() => {
    const detach = CALENDAR_COMMAND_IDS.map(id =>
      ports.registry.attach(id, {
        when: () =>
          commandEnabled(id, stateRef.current, ctxRef.current) &&
          !(PERIOD_COMMANDS.has(id) && ownsSideArrows(focused())),
        run: (command: CommandContext) => {
          if (id === 'calendar.open' && command.trigger && !returnGate.claim()) return;
          apply(actionForCommand(id));
        },
      }),
    );
    return () => detach.forEach(off => off());
  }, [ports.registry, apply, returnGate]);

  useEscapeLadder(apply);

  ports.useInviteCondition(inviteOpen(state, ctx));
  useCommandTarget(commandTarget(state, ctx));
  ports.useSidebar(
    calendarSidebar({ state, calendars, entries, today: toIsoDate(now), weekStartsOn, dispatch }),
  );

  return <CalendarScreen vm={viewModel(state, ctx)} dispatch={dispatch} announce={announce} focus={focus} />;
}
