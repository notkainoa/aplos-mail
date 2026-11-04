/** Shared helpers for the calendar screen's node tests (calendar.test.ts, calendar.review1.test.ts). */
import { createFixtureEngine, defaultNow } from '@aplos/contract-fixture';
import { connectDataLayer } from '../../data/connect';
import { createManualScheduler, createManualTimers } from '../../data/scheduler';
import { api, setClock, type Event } from '../../data';
import { harnessClock } from '../../data/clock';
import {
  entriesFor,
  eventsRange,
  initialState,
  periodOf,
  shownView,
  type CalendarContext,
  type CalendarState,
} from './calendar.model';
import type { EffectPorts, EffectUi } from './effects';
import { demoWorld } from './CalendarStates';

export const NOW = Date.UTC(2026, 9, 29, 17, 0, 0); // the harness's 2026-10-29T10:00 in America/Los_Angeles
export const THU = '2026-10-29';

export function ctxFor(
  events = demoWorld.events,
  plans = demoWorld.plans,
  calendars = demoWorld.calendars,
  state?: CalendarState,
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
    loadedThrough: eventsRange(period, NOW).to,
    defaultCalendarId: 'work',
    canHide: true,
    calendarsReady: true,
    windowReady: true,
  };
}

/** A context built for the state's own period, as the container builds it. */
export function ctxAt(
  state: CalendarState,
  events: readonly Event[] = demoWorld.events,
  calendars = demoWorld.calendars,
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
    loadedThrough: eventsRange(period, NOW).to,
    defaultCalendarId: 'work',
    canHide: true,
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
  return { connection, flush };
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
} {
  const applied: string[] = [];
  const dropped: string[] = [];
  const overrides = new Map<string, boolean>();
  const settled: string[] = [];
  const failed: string[] = [];
  return {
    applied,
    dropped,
    overrides,
    settled,
    failed,
    optimistic: () => undefined,
    settle: id => applied.push(id),
    rollback: id => dropped.push(id),
    shown: (id, shown) => void overrides.set(id, shown),
    shownSettled: id => settled.push(id),
    shownFailed: id => {
      overrides.delete(id);
      failed.push(id);
    },
    focus: () => undefined,
  };
}

export function ports(): EffectPorts {
  return {
    eventSet: args => api.event.set(args),
    eventRsvp: args => api.event.rsvp(args),
    calendarSet: args => api.calendar.set(args),
    planConfirm: args => api.plan.confirm(args),
    planDismiss: args => api.plan.dismiss(args),
    openThread: () => undefined,
    openUrl: () => undefined,
    copyText: () => undefined,
  };
}
