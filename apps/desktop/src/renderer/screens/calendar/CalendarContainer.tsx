/**
 * The Calendar screen's container (thin): reads `renderer/data` hooks, feeds `calendar.model.ts`, runs the effects the
 * reducer returns, and attaches the catalog's `calendar.*` commands to the registry. Every key, click and drag goes
 * through `update` first (state on keydown, DESIGN 5 rule 1), then the contract call runs optimistically.
 *
 * What `renderer/data` and `renderer/shell` don't offer yet comes in through `CalendarPorts` (REQUESTs to ui-shell):
 * the `Calendar/get` list, `Event/set|rsvp|hide`, `Calendar/set`, `Plan/confirm|dismiss`, the `invite` key condition,
 * the sidebar slot, opening a thread or a link, and the clipboard. It cannot run until ui-shell lands the data layer.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Registry } from '../../commands';
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
  type Receipt,
  type State,
} from '../../data';
import { dismissToast, pushToast, updateToast, useCommandTarget } from '../../shell';
import type { Announce } from '../../ui/props';
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
  type CalendarContext,
  type CalendarEffect,
  type CalendarState,
  type OptimisticChange,
  type Overlay,
} from './calendar.model';
import { CalendarScreen, type FocusRequest } from './CalendarScreen';
import { calendarSidebar, type CalendarSidebar } from './sidebar';

/** A contract command through a port: the caller mints the `opId`. */
type PortCall<M extends 'Event/set' | 'Event/rsvp' | 'Event/hide' | 'Calendar/set' | 'Plan/confirm' | 'Plan/dismiss'> = (
  args: CommandArgs<M> & { readonly opId: string },
) => Promise<Output<M>>;

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
const UNDO_ACTION = [{ id: 'undo', label: 'Undo', commandId: 'app.undo' }] as const;

/** An overlay entry stays until a window frame reaches the write's state (ARCH 9.2), or until it fails or is undone. */
interface Settling {
  readonly id: string;
  readonly at: State | null;
}

const reached = (window: State | null, at: State | null): boolean =>
  window !== null && at !== null && window.dbEpoch === at.dbEpoch && window.seq >= at.seq;

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
  const entries = useMemo(
    () => entriesFor({ events, plans, calendars, solo: state.solo, period, planCalendarId: defaultId, overlay }),
    // The period by its bounds, so a new object for the same range does not recompute.
    [events, plans, calendars, state.solo, period.from, period.to, defaultId, overlay],
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
    const done = settling.filter(s => reached(eventsWindow.state, s.at));
    if (done.length === 0) return;
    setOverlay(o => done.reduce((acc, s) => overlayWithout(acc, s.id), o));
    setSettling(list => list.filter(s => !done.includes(s)));
  }, [eventsWindow.state, settling]);

  // The reducer reads the newest state and context even when several keys land in one frame.
  const stateRef = useRef(state);
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  stateRef.current = state;

  const optimistic = useCallback((change: OptimisticChange) => setOverlay(o => overlayWith(o, change)), []);
  const rollback = useCallback((id: string) => setOverlay(o => overlayWithout(o, id)), []);
  const settle = useCallback((id: string, at: State | null) => setSettling(list => [...list, { id, at }]), []);

  /** Pushes Z's entry for an engine write: cancel while held, else the inverse (`Operation/undo` decides). */
  const undoable = useCallback(
    (opId: string, label: string, id: string) =>
      undoStack.push({
        label,
        undo: async () => {
          dismissToast(opId);
          await api.operation.undo({ opId }).receipt;
          rollback(id);
        },
      }),
    [rollback],
  );

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

  const run = useCallback(
    (fx: CalendarEffect): void => {
      switch (fx.kind) {
        case 'eventSet': {
          const opId = newOpId();
          optimistic(fx.optimistic);
          if (fx.toast)
            pushToast({ id: opId, kind: fx.toast.kind, message: fx.toast.message, actions: UNDO_ACTION, undoable: true });
          const handle = undoable(opId, fx.undoLabel, fx.optimistic.id);
          ports.event.set({ opId, change: fx.change }).then(
            out => settle(fx.optimistic.id, out.receipt.appliedState),
            () => {
              handle.forget();
              failed(opId, fx.optimistic.id, fx.failure, () => run(fx));
            },
          );
          return;
        }
        case 'rsvp': {
          const opId = newOpId();
          optimistic(fx.optimistic);
          pushToast({
            id: opId,
            kind: 'done',
            message: rsvpMessage(fx.answer, fx.organizer, 'held'),
            actions: UNDO_ACTION,
            undoable: true,
          });
          const handle = undoable(opId, rsvpMessage(fx.answer, fx.organizer, 'held'), fx.id);
          ports.event.rsvp({ opId, id: fx.id, response: fx.response, scope: fx.scope }).then(
            (receipt: Receipt) => {
              settle(fx.id, receipt.appliedState);
              // Sent at once (no hold): the toast says so.
              if (receipt.undoUntil === undefined || receipt.undoUntil <= getNow())
                updateToast(opId, { message: rsvpMessage(fx.answer, fx.organizer, 'sent') });
            },
            () => {
              handle.forget();
              failed(opId, fx.id, fx.failure, () => run(fx));
            },
          );
          return;
        }
        case 'calendarSet': {
          setShownOverride(m => new Map(m).set(fx.id, fx.shown));
          ports.calendar.set({ opId: newOpId(), id: fx.id, shown: fx.shown }).then(
            () => setShownOverride(m => {
              const next = new Map(m);
              next.delete(fx.id);
              return next;
            }),
            () => setShownOverride(m => {
              const next = new Map(m);
              next.delete(fx.id);
              return next;
            }),
          );
          return;
        }
        case 'planConfirm': {
          const opId = newOpId();
          optimistic(fx.optimistic);
          const handle = undoable(opId, 'Added to Calendar', fx.optimistic.id);
          ports.plan
            .confirm({ opId, id: fx.planId, ...(fx.calendarId ? { calendarId: fx.calendarId } : {}) })
            .then(
              out => settle(fx.optimistic.id, out.receipt.appliedState),
              () => {
                handle.forget();
                failed(opId, fx.optimistic.id, "Couldn't add it to the calendar.", () => run(fx));
              },
            );
          return;
        }
        case 'planDismiss': {
          const opId = newOpId();
          optimistic(fx.optimistic);
          const handle = undoable(opId, 'Not added', fx.optimistic.id);
          ports.plan.dismiss({ opId, ids: [fx.planId] }).then(
            receipt => settle(fx.optimistic.id, receipt.appliedState),
            () => {
              handle.forget();
              rollback(fx.optimistic.id);
            },
          );
          return;
        }
        case 'eventHide': {
          const opId = newOpId();
          optimistic(fx.optimistic);
          pushToast({ id: opId, kind: fx.toast.kind, message: fx.toast.message, actions: UNDO_ACTION, undoable: true });
          const handle = undoable(opId, fx.toast.message, fx.id);
          ports.event.hide({ opId, ids: [fx.id], hidden: true }).then(
            receipt => settle(fx.id, receipt.appliedState),
            () => {
              handle.forget();
              failed(opId, fx.id, "Couldn't hide it.", () => run(fx));
            },
          );
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
    [ports, optimistic, undoable, settle, failed, rollback],
  );

  const dispatch = useCallback(
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

  // The catalog's calendar commands: keys, the palette and menus all land in the same reducer.
  useEffect(() => {
    const detach = CALENDAR_COMMAND_IDS.map(id =>
      ports.registry.attach(id, {
        when: () => commandEnabled(id, stateRef.current, ctxRef.current),
        run: () => {
          dispatch(actionForCommand(id));
        },
      }),
    );
    return () => detach.forEach(off => off());
  }, [ports.registry, dispatch]);

  ports.useInviteCondition(inviteOpen(state, ctx));
  useCommandTarget(commandTarget(state, ctx));
  ports.useSidebar(
    calendarSidebar({ state, calendars, entries, today: toIsoDate(now), weekStartsOn, dispatch }),
  );

  return (
    <CalendarScreen
      vm={viewModel(state, ctx)}
      dispatch={dispatch}
      announce={announce}
      focus={focus}
    />
  );
}
