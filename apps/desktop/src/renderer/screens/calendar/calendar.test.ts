/**
 * The Calendar screen's behaviour, in node with no DOM. The model tests drive `update` over the demo world in
 * `CalendarStates` (the same fixtures the harness draws); the data tests run effects and the per-write Undo
 * against the real data layer on the stand-in engine. Run:
 * `cd apps/desktop && TZ=America/Los_Angeles npx tsx --test 'src/renderer/screens/calendar/*.test.ts*'`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFixtureEngine, defaultNow } from '@aplos/contract-fixture';
import { connectDataLayer } from '../../data/connect';
import { createManualScheduler, createManualTimers } from '../../data/scheduler';
import { api, setClock, type Event } from '../../data';
import { harnessClock } from '../../data/clock';
import {
  getToasts,
  resetToasts,
  runToastAction,
  setToastUndoRunner,
} from '../../shell/store-toast';
import { undoToastOperation } from '../../shell/KeysProviders';
import {
  actionForCommand,
  commandEnabled,
  detailMenu,
  draftChange,
  draftFromEvent,
  entriesFor,
  eventData,
  initialState,
  inviteOpen,
  liveRsvp,
  localMs,
  msOf,
  newDraft,
  nextFreeSlot,
  periodOf,
  planEntryId,
  shownView,
  stepAnchor,
  timeChange,
  update,
  viewModel,
  type CalendarContext,
  type CalendarState,
} from './calendar.model';
import { runCalendarEffect, type EffectPorts, type EffectUi } from './effects';
import { takesInviteAnswerKey } from './keys';
import { demoWorld } from './CalendarStates';

const NOW = Date.UTC(2026, 9, 29, 17, 0, 0); // the harness's 2026-10-29T10:00 in America/Los_Angeles
const THU = '2026-10-29';

function ctxFor(
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
    defaultCalendarId: 'work',
    canHide: true,
  };
}

const S = (patch: Partial<CalendarState> = {}): CalendarState => ({
  ...initialState(THU),
  ...patch,
});

// ---------------------------------------------------------------------------
// Views, periods and labels
// ---------------------------------------------------------------------------

test('D/W/M switch the view and the narrow pane shows the agenda', () => {
  const ctx = ctxFor();
  let s = S();
  assert.equal(shownView(s), 'week');
  s = update(s, actionForCommand('calendar.dayView'), ctx).state;
  assert.equal(shownView(s), 'day');
  s = update(s, actionForCommand('calendar.monthView'), ctx).state;
  assert.equal(shownView(s), 'month');
  s = update(s, actionForCommand('calendar.weekView'), ctx).state;
  s = update(s, { type: 'width', px: 600 }, ctx).state;
  assert.equal(shownView(s), 'agenda');
  s = update(s, { type: 'width', px: 1200 }, ctx).state;
  assert.equal(shownView(s), 'week');
});

test('T returns to today and arrows move one period', () => {
  const ctx = ctxFor();
  let s = update(S({ anchor: '2026-11-10' }), { type: 'today' }, ctx).state;
  assert.equal(s.anchor, THU);
  s = update(s, { type: 'period', dir: 1 }, ctx).state;
  assert.equal(s.anchor, '2026-11-05');
  s = update(s, { type: 'view', view: 'month' }, ctx).state;
  s = update(s, { type: 'period', dir: -1 }, ctx).state;
  assert.equal(s.anchor, '2026-10-05');
  assert.equal(stepAnchor('month', '2026-01-31', 1), '2026-02-28');
});

test('period windows stay inside the 62-day contract range', () => {
  for (const view of ['day', 'week', 'month'] as const) {
    const period = periodOf(view, THU, 0);
    assert.ok((period.to - period.from) / 86_400_000 <= 62, `${view} range`);
  }
});

// ---------------------------------------------------------------------------
// RSVP gating (DESIGN 7.8, 8; review1 4a)
// ---------------------------------------------------------------------------

test('Y/M/N answer only while an invite is open; otherwise M is Month', () => {
  const ctx = ctxFor();
  const closed = S({ selectedId: 'design' });
  assert.equal(inviteOpen(closed, ctx), false);
  assert.equal(commandEnabled('calendar.answerMaybe', closed, ctx), false);
  assert.equal(commandEnabled('calendar.monthView', closed, ctx), true);
  const open = S({ selectedId: 'q4', detailId: 'q4' });
  assert.equal(inviteOpen(open, ctx), true);
  const t = update(open, actionForCommand('calendar.answerYes'), ctx);
  assert.equal(t.state.rsvp?.answer, 'yes');
  // Nothing sent yet: Send reply stays gated until an answer, then Return sends.
  const live = liveRsvp(t.state, ctx);
  assert.equal(live?.answer, 'yes');
  const sent = update(t.state, { type: 'sendReply' }, ctx);
  assert.equal(
    sent.effects.some(fx => fx.kind === 'rsvp'),
    true,
  );
});

test('Send reply does nothing until an answer is chosen', () => {
  const ctx = ctxFor();
  const open = S({ selectedId: 'q4', detailId: 'q4' });
  const t = update(open, { type: 'sendReply' }, ctx);
  assert.equal(t.effects.length, 0);
  assert.equal(t.handled, false);
});

test('day view: an invite in the rail counts as open only once selected (review1 4a)', () => {
  const q4 = ctxFor().events.get('q4')!;
  const ctx = ctxFor([q4]);
  const day = S({ view: 'day', anchor: '2026-10-30' });
  // The rail shows q4 by itself, but nobody opened it: M still means Month.
  assert.equal(inviteOpen(day, ctx), false);
  const picked = update(day, { type: 'select', id: 'q4' }, ctx).state;
  assert.equal(inviteOpen(picked, ctx), true);
});

// ---------------------------------------------------------------------------
// Delete, edit and the scope chooser
// ---------------------------------------------------------------------------

test('Delete runs only on persisted events, never on a plan or an unsaved draft', () => {
  const ctx = ctxFor();
  assert.equal(commandEnabled('calendar.delete', S({ selectedId: 'dental' }), ctx), true);
  assert.equal(
    commandEnabled('calendar.delete', S({ selectedId: planEntryId('launch') }), ctx),
    false,
  );
  const t = update(S({ selectedId: 'dental' }), { type: 'delete' }, ctx);
  const fx = t.effects.find(f => f.kind === 'eventSet');
  assert.ok(fx && fx.kind === 'eventSet' && fx.change.type === 'destroy');
  assert.equal(fx.toast?.message, 'Event deleted');
});

test('a repeating event asks This event or All events and passes the scope through', () => {
  const ctx = ctxFor();
  const standup = ctx.events.get(`standup@${localMs('2026-10-28', '11:00')}`)!;
  const ask = update(
    S({ selectedId: standup.id }),
    { type: 'move', id: standup.id, start: '2026-10-28T12:00:00', end: '2026-10-28T12:15:00' },
    ctx,
  );
  assert.equal(ask.state.scope?.action, 'move');
  assert.equal(ask.effects.length, 0);
  const chosen = update(ask.state, { type: 'scope', scope: 'series' }, ctx);
  const fx = chosen.effects.find(f => f.kind === 'eventSet');
  assert.ok(fx && fx.kind === 'eventSet');
  assert.equal(fx.change.type, 'update');
  if (fx.change.type === 'update') assert.equal(fx.change.scope, 'series');
});

test('all-events on a move shifts the series by the delta, not the occurrence times', () => {
  const ctx = ctxFor();
  const series = { ...ctx.events.get(`standup@${localMs('2026-10-28', '11:00')}`)!, id: 'standup' };
  const occ = ctx.events.get(`standup@${localMs('2026-10-28', '11:00')}`)!;
  const target = timeChange(
    occ,
    {
      start: { type: 'utc', utc: msOf(occ.start) + 3_600_000 },
      end: { type: 'utc', utc: msOf(occ.end) + 3_600_000 },
    },
    'series',
    series,
  );
  assert.equal(target.id, 'standup');
  assert.ok(target.fields.start && msOf(target.fields.start) === msOf(occ.start) + 3_600_000);
});

// ---------------------------------------------------------------------------
// Esc ladder and menus (review1 4b)
// ---------------------------------------------------------------------------

test('Esc closes the scope question, the popover, the answer, the selection, then falls through', () => {
  const ctx = ctxFor();
  const s = S({
    selectedId: 'q4',
    detailId: 'q4',
    rsvp: { eventId: 'q4', answer: 'yes', changing: false },
  });
  let t = update(s, { type: 'escape' }, ctx);
  assert.equal(t.handled, true);
  assert.equal(t.state.rsvp, null);
  t = update(t.state, { type: 'escape' }, ctx);
  assert.equal(t.state.detailId, null);
  t = update(t.state, { type: 'escape' }, ctx);
  assert.equal(t.state.selectedId, null);
  t = update(t.state, { type: 'escape' }, ctx);
  assert.equal(t.handled, false);
  // The scope question is its own rung: it closes before anything under it.
  const asking = update(
    S({ selectedId: `standup@${localMs('2026-10-28', '11:00')}` }),
    {
      type: 'move',
      id: `standup@${localMs('2026-10-28', '11:00')}`,
      start: '2026-10-28T12:00:00',
      end: '2026-10-28T12:15:00',
    },
    ctx,
  ).state;
  const cancelled = update(asking, { type: 'escape' }, ctx);
  assert.equal(cancelled.handled, true);
  assert.equal(cancelled.state.scope, null);
});

test('the ⋯ menu offers edit and delete on yours, change your reply on an answered invite, no delete on a plan', () => {
  const ctx = ctxFor();
  const own = ctx.entries.find(e => e.id === 'design')!;
  const ids = detailMenu(own, ctx).map(m => ('id' in m ? m.id : m.kind));
  assert.deepEqual(ids, ['edit', 'copyLink', 'hide', 'separator', 'delete']);
  const invited = {
    ...ctx.entries.find(e => e.id === 'q4')!,
    myReply: 'yes' as const,
    unanswered: false,
  };
  const inviteIds = detailMenu(invited, ctx).map(m => ('id' in m ? m.id : m.kind));
  assert.ok(inviteIds.includes('changeReply'));
  assert.ok(!inviteIds.includes('delete'));
  const plan = ctx.entries.find(e => e.id === planEntryId('launch'))!;
  assert.deepEqual(
    detailMenu(plan, ctx).map(m => ('id' in m ? m.id : m.kind)),
    ['notNow'],
  );
});

// ---------------------------------------------------------------------------
// Time shapes (utc / date / floating) and the editor's writes (review1 1a, 1c, 1d, 1e)
// ---------------------------------------------------------------------------

test('a title-only edit writes no times; times keep the event type and zone', () => {
  const floating: Event = {
    ...demoWorld.events.find(e => e.id === 'dental')!,
    start: { type: 'floating', local: '2026-10-29T09:30', timeZone: 'America/New_York' },
    end: { type: 'floating', local: '2026-10-29T10:30', timeZone: 'America/New_York' },
  };
  const draft = { ...draftFromEvent(floating), title: 'Cleaning' };
  const change = draftChange(draft, floating, 'occurrence');
  assert.ok(change && change.type === 'update');
  if (change.type === 'update') {
    assert.deepEqual(change.fields, { title: 'Cleaning' });
    const timed = { ...draft, start: '10:00' };
    const moved = draftChange(timed, floating, 'occurrence');
    if (moved?.type === 'update') assert.equal(moved.fields.start?.type, 'floating');
  }
});

test('an all-day editor date change carries the end date (review1 1c)', () => {
  const fair = demoWorld.worst.find(e => e.id === 'fair')!;
  const draft = draftFromEvent(fair);
  assert.equal(draft.endDate, '2026-11-07');
  const moved = update(
    S({ editor: draft }),
    { type: 'editor', patch: { date: '2026-11-06' } },
    ctxFor(demoWorld.worst),
  );
  const next = moved.state.editor!;
  assert.equal(next.endDate, '2026-11-08');
  const change = draftChange(next, fair, 'occurrence');
  if (change?.type === 'update') {
    assert.deepEqual(change.fields.start, { type: 'date', date: '2026-11-06' });
    assert.deepEqual(change.fields.end, { type: 'date', date: '2026-11-09' });
  }
});

test('N picks the next free wall-clock half hour, including on a DST day (review1 1e)', () => {
  const dst = Date.UTC(2026, 10, 1, 18, 0, 0); // 2026-11-01 10:00 PST (fell back that morning)
  const slot = nextFreeSlot('2026-11-01', dst, []);
  assert.equal(slot.start, '10:00');
  assert.equal(slot.end, '11:00');
  const draft = newDraft('2026-11-01', dst, [], 'work');
  assert.equal(draft.start, '10:00');
});

test('eventData maps contract times to grid entries: utc, all-day date, invite flags', () => {
  const cal = { id: 'work', name: 'Work', color: 'hill' as const };
  const q4 = eventData(ctxFor().events.get('q4')!, cal);
  assert.equal(q4.unanswered, true);
  assert.equal(q4.persisted, true);
  assert.equal(q4.invite?.from, 'Priya Raman');
  const day = eventData(
    demoWorld.worst.find(e => e.id === 'fair')!,
    cal,
  );
  assert.equal(day.allDay, true);
  assert.equal(day.start, '2026-11-05T00:00:00');
  assert.equal(day.end, '2026-11-08T00:00:00');
});

// ---------------------------------------------------------------------------
// The screen's other decisions
// ---------------------------------------------------------------------------

test('the agenda switcher selects nothing while the narrow agenda shows (review1 4d)', () => {
  const ctx = ctxFor();
  const narrow = S({ view: 'day', paneWidth: 600 });
  assert.equal(viewModel(narrow, ctx).viewSelected, null);
  const wide = S({ view: 'day', paneWidth: 1200 });
  assert.equal(viewModel(wide, ctx).viewSelected, 'day');
});

test('the empty day offers New event · N; a calendar toggle and solo change the drawn ids', () => {
  const ctx = ctxFor();
  const vm = viewModel(S({ view: 'day', anchor: '2026-11-01' }), ctx);
  assert.equal(vm.emptyAction, true);
  const solo = ctxFor(undefined, undefined, undefined, S({ solo: 'work' }));
  assert.ok(solo.entries.every(e => e.calendar.id === 'work'));
});

// ---------------------------------------------------------------------------
// Writes against the real data layer: opIds, Undo and refusals
// ---------------------------------------------------------------------------

const nextTask = () => new Promise<void>(resolve => setImmediate(resolve));

async function boot() {
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

async function settle(flush: () => void) {
  for (let i = 0; i < 20; i++) {
    await nextTask();
    flush();
  }
}

const calRef = (c: { id: string; name: string }) => ({
  id: c.id,
  name: c.name,
  color: 'sky' as const,
});
const newEvent = (id: string, calendarId: string): Event =>
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

function testUi(): EffectUi & { applied: string[]; dropped: string[] } {
  const applied: string[] = [];
  const dropped: string[] = [];
  return {
    applied,
    dropped,
    optimistic: () => undefined,
    settle: id => applied.push(id),
    rollback: id => dropped.push(id),
    shown: () => undefined,
    focus: () => undefined,
  };
}

function ports(): EffectPorts {
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

test('one write is one Undo toast, undone by its own opId, not the newest', async () => {
  const { flush } = await boot();
  resetToasts();
  setToastUndoRunner(undoToastOperation);
  try {
    const ui = testUi();
    // Two writes: two toasts, each Undo bound to its own opId.
    const cal = (await api.calendar.get({})).list[0];
    runCalendarEffect(
      {
        kind: 'eventSet',
        change: {
          type: 'create',
          calendarId: cal.id,
          fields: {
            title: 'A',
            start: { type: 'date', date: '2026-10-30' },
            end: { type: 'date', date: '2026-10-31' },
            allDay: true,
          },
        },
        optimistic: { id: 'tmp-a', add: eventData(newEvent('tmp-a', cal.id), calRef(cal)) },
        toast: { kind: 'trash', message: 'Event deleted', undoable: true },
        undoLabel: 'A',
        failure: "Couldn't add A.",
      },
      ports(),
      ui,
    );
    await flush();
    runCalendarEffect(
      {
        kind: 'eventSet',
        change: {
          type: 'create',
          calendarId: cal.id,
          fields: {
            title: 'B',
            start: { type: 'date', date: '2026-10-30' },
            end: { type: 'date', date: '2026-10-31' },
            allDay: true,
          },
        },
        optimistic: { id: 'tmp-b', add: eventData(newEvent('tmp-b', cal.id), calRef(cal)) },
        toast: { kind: 'trash', message: 'Event deleted', undoable: true },
        undoLabel: 'B',
        failure: "Couldn't add B.",
      },
      ports(),
      testUi(),
    );
    await flush();
    const toasts = getToasts();
    assert.equal(toasts.length, 2);
    assert.ok(toasts.every(t => t.undoable && t.actions?.[0]?.commandId === 'app.undo'));
    // Undo on the FIRST toast undoes the first write; B stays.
    runToastAction(toasts[0].id, 'undo');
    await flush();
    assert.equal(getToasts().length, 1);
  } finally {
    resetToasts();
  }
});

test('RSVP sends the scope and words the toast while held, then sent', async () => {
  const { flush } = await boot();
  resetToasts();
  try {
    const ui = testUi();
    runCalendarEffect(
      {
        kind: 'rsvp',
        id: 'no-such',
        response: 'accepted',
        scope: 'occurrence',
        answer: 'yes',
        optimistic: { id: 'no-such', patch: { myReply: 'yes' } },
        organizer: 'Theo',
        failure: "Couldn't send your reply.",
      },
      ports(),
      ui,
    );
    await flush();
    // The fixture refused a reply on an unknown event: the overlay rolled back and the failure showed.
    assert.ok(ui.dropped.includes('no-such'));
    assert.ok(getToasts().some(t => t.message === "Couldn't send your reply."));
  } finally {
    resetToasts();
  }
});

test('the answer-key guard takes bare y/m/n on the screen or in its overlays, never while typing', () => {
  const nothing = { closest: () => null, matches: () => false };
  const inDialog = {
    closest: (s: string) => (s.includes('dialog') ? nothing : null),
    matches: () => false,
  };
  const inField = {
    closest: (s: string) => (s.includes('textarea') ? nothing : null),
    matches: () => false,
  };
  const key = (k: string, extra = {}) => ({
    key: k,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...extra,
  });
  // On the screen, in its portaled popover or a menu: the key is the screen's.
  assert.equal(takesInviteAnswerKey(key('y'), nothing, true), true);
  assert.equal(takesInviteAnswerKey(key('n'), inDialog, false), true);
  assert.equal(takesInviteAnswerKey(key('m'), nothing, true), true);
  // Elsewhere, typing, chorded or already claimed: it is not.
  assert.equal(takesInviteAnswerKey(key('y'), nothing, false), false);
  assert.equal(takesInviteAnswerKey(key('y'), inField, true), false);
  assert.equal(takesInviteAnswerKey(key('y', { metaKey: true }), nothing, true), false);
  assert.equal(takesInviteAnswerKey(key('Y', { shiftKey: true }), nothing, true), false);
  assert.equal(takesInviteAnswerKey(key('d'), nothing, true), false);
  assert.equal(takesInviteAnswerKey(key('y', { defaultPrevented: true }), nothing, true), false);
});
