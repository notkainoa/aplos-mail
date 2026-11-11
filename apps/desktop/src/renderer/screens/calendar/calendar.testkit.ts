/** Shared helpers for the calendar screen's node tests (calendar.test.ts, calendar.review1.test.ts). */
import { createFixtureEngine, defaultNow } from '@aplos/contract-fixture';
import { connectDataLayer } from '../../data/connect';
import { createManualScheduler, createManualTimers } from '../../data/scheduler';
import { api, setClock, type Account, type Calendar, type Event } from '../../data';
import { harnessClock } from '../../data/clock';
import type { CalendarEventData } from '../../ui/props';
import {
  entriesFor,
  eventsRange,
  initialState,
  periodOf,
  shownView,
  type CalendarContext,
  type CalendarState,
  type EditorDraft,
  type OptimisticChange,
} from './calendar.model';
import { releaseHeldWrites, type EffectPorts, type EffectUi, type WatchedWrite } from './effects';
import { demoWorld } from './CalendarStates';

export const NOW = Date.UTC(2026, 9, 29, 17, 0, 0); // the harness's 2026-10-29T10:00 in America/Los_Angeles
export const THU = '2026-10-29';

export function ctxFor(
  events = demoWorld.events,
  plans = demoWorld.plans,
  calendars = demoWorld.calendars,
  state?: CalendarState,
  accounts: readonly Account[] = demoWorld.accounts,
): CalendarContext {
  const period = periodOf('week', THU, 0);
  const entries = entriesFor({
    events,
    plans,
    calendars,
    solo: state?.solo ?? null,
    period,
    planCalendarId: 'work',
  });
  return {
    now: NOW,
    weekStartsOn: 0,
    entries,
    events: new Map(events.map(e => [e.id, e])),
    plans: new Map(plans.map(p => [p.id, p])),
    calendars,
    accounts,
    loadedThrough: eventsRange(period, NOW).to,
    defaultCalendarId: 'work',
    calendarsReady: true,
    windowReady: true,
  };
}

/** A context built for the state's own period, as the container builds it. */
export function ctxAt(
  state: CalendarState,
  events: readonly Event[] = demoWorld.events,
  calendars: readonly Calendar[] = demoWorld.calendars,
  accounts: readonly Account[] = demoWorld.accounts,
): CalendarContext {
  const period = periodOf(shownView(state), state.anchor, 0);
  const entries = entriesFor({
    events,
    plans: [],
    calendars,
    solo: state.solo,
    period,
    planCalendarId: 'work',
  });
  return {
    now: NOW,
    weekStartsOn: 0,
    entries,
    events: new Map(events.map(e => [e.id, e])),
    plans: new Map(),
    calendars,
    accounts,
    loadedThrough: eventsRange(period, NOW).to,
    defaultCalendarId: 'work',
    calendarsReady: true,
    windowReady: true,
  };
}

export const S = (patch: Partial<CalendarState> = {}): CalendarState => ({
  ...initialState(THU),
  ...patch,
});

// ---------------------------------------------------------------------------
// Writes against the real data layer: opIds, Undo and refusals
// ---------------------------------------------------------------------------

export const nextTask = () => new Promise<void>(resolve => setImmediate(resolve));

export async function boot() {
  // A fresh screen: the container releases held-target marks on unmount — a test leaking one
  // would make a later write refuse itself `calendar.holdPending` (review15).
  releaseHeldWrites();
  const engine = createFixtureEngine({ scenario: 'demo', clock: defaultNow });
  const scheduler = createManualScheduler();
  const connection = connectDataLayer({
    session: engine.connect(),
    scheduler,
    timers: createManualTimers(defaultNow),
  });
  setClock(harnessClock);
  await settle(scheduler.flush);
  const flush = async () => settle(scheduler.flush);
  return { connection, flush, engine };
}

export async function settle(flush: () => void) {
  for (let i = 0; i < 20; i++) {
    await nextTask();
    flush();
  }
}

export const calRef = (c: { id: string; name: string }) => ({
  id: c.id,
  name: c.name,
  color: 'sky' as const,
});
export const newEvent = (id: string, calendarId: string): Event =>
  ({
    id,
    rev: 1,
    accountId: 'acct',
    calendarId,
    recurring: false,
    exception: false,
    title: id,
    start: { type: 'date', date: '2026-10-30' },
    end: { type: 'date', date: '2026-10-31' },
    allDay: true,
    attendees: [],
    status: 'confirmed',
    can: { edit: true, move: true, delete: true, rsvp: false, editGuests: true },
    sync: 'synced',
  }) as Event;

export function testUi(): EffectUi & {
  applied: string[];
  dropped: string[];
  overrides: Map<string, boolean>;
  settled: string[];
  failed: string[];
  reopened: Array<{ id: string; note: string }>;
  /** Whether `reopenEditor` reports the editor opened; false makes a conflict fall back to the toast. */
  reopenOpens: boolean;
  /** The drafts `restoreEditor` was asked to bring back, with each refusal's sentence. */
  restored: Array<{ draft: EditorDraft; note: string }>;
  /** Whether `restoreEditor` reports the editor opened; false makes a times refusal fall back to the toast. */
  restoreOpens: boolean;
  /** The event ids `closeDetail` was asked to close. */
  closedFor: string[];
  closed: number;
  /** Every write handed to `ui.watch` (accepted receipts the tests then drive by hand). */
  watched: WatchedWrite[];
  /** The optimistic layers in flight, keyed by writeId like the container's map (review15). */
  layers: Map<string, OptimisticChange>;
  /** The merged patch every live layer would show for `id` (a second write never sees another's rolled back). */
  patchFor(id: string): Partial<CalendarEventData> | undefined;
  /** Writes a `synced` op left waiting for the next window frame (review15): `frame` delivers one. */
  pendingFrame: Map<string, readonly string[]>;
  /** A window frame newer than the `synced` one landed: the container drops the waiting layers. */
  frame(): void;
} {
  const applied: string[] = [];
  const dropped: string[] = [];
  const layers = new Map<string, OptimisticChange>();
  const pendingFrame = new Map<string, readonly string[]>();
  const overrides = new Map<string, boolean>();
  const settled: string[] = [];
  const failed: string[] = [];
  const reopened: Array<{ id: string; note: string }> = [];
  const restored: Array<{ draft: EditorDraft; note: string }> = [];
  const closedFor: string[] = [];
  const watched: WatchedWrite[] = [];
  let closed = 0;
  const self = {
    applied,
    dropped,
    overrides,
    settled,
    failed,
    reopened,
    reopenOpens: true,
    restored,
    restoreOpens: true,
    closedFor,
    watched,
    layers,
    pendingFrame,
    frame() {
      for (const [writeId, entryIds] of pendingFrame) {
        layers.delete(writeId);
        applied.push(...entryIds);
      }
      pendingFrame.clear();
    },
    patchFor(id: string) {
      let merged: Partial<CalendarEventData> | undefined;
      for (const layer of layers.values())
        for (const change of [layer, ...(layer.more ?? [])])
          if (change.id === id && change.patch !== undefined)
            merged = { ...merged, ...change.patch };
      return merged;
    },
    get closed() {
      return closed;
    },
    optimistic: (change: OptimisticChange, writeId: string) => void layers.set(writeId, change),
    settle: (_writeId: string, entryIds: readonly string[]) => applied.push(...entryIds),
    settleAfterFrame: (writeId: string, entryIds: readonly string[]) =>
      void pendingFrame.set(writeId, entryIds),
    rollback: (writeId: string, entryIds: readonly string[]) => {
      layers.delete(writeId);
      dropped.push(...entryIds);
    },
    shown: (id: string, shown: boolean) => void overrides.set(id, shown),
    shownSettled: (id: string) => settled.push(id),
    shownFailed: (id: string) => {
      overrides.delete(id);
      failed.push(id);
    },
    focus: () => undefined,
    reopenEditor: (eventId: string, note: string) => {
      reopened.push({ id: eventId, note });
      return self.reopenOpens;
    },
    restoreEditor: (draft: EditorDraft, note: string) => {
      restored.push({ draft, note });
      return self.restoreOpens;
    },
    closeDetail: (eventId: string) => {
      closedFor.push(eventId);
      closed += 1;
    },
    watch: (write: WatchedWrite) => watched.push(write),
  };
  return self;
}

export function ports(): EffectPorts {
  return {
    eventSet: args => api.event.set(args),
    eventRsvp: args => api.event.rsvp(args),
    calendarSet: args => api.calendar.set(args),
    planConfirm: args => api.plan.confirm(args),
    planDismiss: args => api.plan.dismiss(args),
    eventHide: args => api.event.hide(args),
    enableEditing: () => Promise.resolve(),
    reconnect: () => undefined,
    operationUndo: opId => api.operation.undo({ opId }),
    openThread: () => undefined,
    openUrl: () => undefined,
    copyText: () => undefined,
  };
}
