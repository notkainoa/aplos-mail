/**
 * The review1 regression tests (see calendar.test.ts for the shared suite): each names the bug it guards.
 * Run: `cd apps/desktop && TZ=America/Los_Angeles npx tsx --test 'src/renderer/screens/calendar/*.test.ts*'`.
 */
import './calendar.tz';
import test from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../../data';
import { getToasts, resetToasts } from '../../shell/store-toast';
import {
  actionForCommand,
  draftFromEvent,
  entriesFor,
  localMs,
  newDraft,
  periodOf,
  reached,
  reconcileShown,
  update,
  viewModel,
  type ShownOverride,
} from './calendar.model';
import { runCalendarEffect } from './effects';
import {
  inCalendarSurface,
  ladderTakesEscape,
  ownsReturn,
  stackDomMatch,
  takesInviteAnswerKey,
} from './keys';
import { calendarSidebar } from './sidebar';
import { demoWorld } from './CalendarStates';
import { boot, ctxAt, ctxFor, NOW, ports, S, testUi, THU } from './calendar.testkit';

// The review1 seriesAlone tests were replaced by calendar.review5.test.ts: the engine DECIDED on 2026-11-04 that
// scope 'series' carries the occurrence id and the fields the user sees, so "All events" is always offered.

test('review1: a non-time edit on an occurrence still offers All events', () => {
  const ctx = ctxFor();
  const occ = ctx.events.get(`standup@${localMs('2026-10-28', '11:00')}`)!;
  const draft = { ...draftFromEvent(occ), title: 'Standup renamed' };
  const ask = update(S({ editor: draft, selectedId: occ.id }), { type: 'editorSave' }, ctx);
  assert.equal(ask.state.scope?.action, 'change');
  const chosen = update(ask.state, { type: 'scope', scope: 'series' }, ctx);
  const fx = chosen.effects.find(f => f.kind === 'eventSet');
  assert.ok(fx && fx.kind === 'eventSet' && fx.change.type === 'update');
  if (fx.kind === 'eventSet' && fx.change.type === 'update') {
    assert.equal(fx.change.scope, 'series');
    assert.equal(fx.change.id, occ.id);
    assert.deepEqual(fx.change.fields, { title: 'Standup renamed' });
    // The engine copies the text fields to the whole series (DECISIONS 2026-11-04, #290): every loaded
    // occurrence's title is patched at once, so the settled window never disagrees with the overlay.
    const standups = [...ctx.events.values()].filter(
      e => e.seriesId === 'standup' && e.id !== occ.id,
    );
    assert.equal(fx.optimistic.more?.length, standups.length);
    for (const m of fx.optimistic.more ?? []) assert.equal(m.patch?.title, 'Standup renamed');
  }
});

test('review1: the Esc ladder stays out while a grid drag is under way', () => {
  const nothing = { closest: () => null, matches: () => false };
  const esc = { key: 'Escape', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };
  // A rung open or not, Esc during a drag belongs to TimeGrid's cancel, never to the ladder.
  assert.equal(ladderTakesEscape(esc, nothing, true, true), false);
  assert.equal(ladderTakesEscape(esc, nothing, true, false), true);
  assert.equal(ladderTakesEscape(esc, nothing, true), true);
});

test('review1: cancelling the scope question returns to the editor with the draft intact', () => {
  const ctx = ctxFor();
  const occ = ctx.events.get(`standup@${localMs('2026-10-28', '11:00')}`)!;
  const draft = { ...draftFromEvent(occ), title: 'Renamed standup' };
  const ask = update(S({ editor: draft }), { type: 'editorSave' }, ctx);
  assert.equal(ask.state.scope?.action, 'change');
  assert.equal(ask.state.editor, null);
  for (const cancel of [{ type: 'scopeCancel' } as const, { type: 'escape' } as const]) {
    const back = update(ask.state, cancel, ctx);
    assert.equal(back.state.scope, null);
    assert.equal(back.state.editor?.title, 'Renamed standup');
  }
});

test('review1: two identical pending creates get distinct temp ids', () => {
  const ctx = ctxFor();
  const draft = { ...newDraft(THU, NOW, [], 'work'), title: 'Focus' };
  const first = update(S({ editor: draft }), { type: 'editorSave' }, ctx);
  const second = update(S({ editor: draft }), { type: 'editorSave' }, ctx);
  const idOf = (t: typeof first) =>
    t.effects.find((f): f is Extract<typeof f, { kind: 'eventSet' }> => f.kind === 'eventSet')
      ?.optimistic.id;
  assert.ok(idOf(first));
  assert.notEqual(idOf(first), idOf(second));
});

test('review1: switching view re-syncs the sidebar month to the anchor', () => {
  const ctx = ctxFor();
  const paged = S({ view: 'week', miniMonth: '2026-12' });
  const t = update(paged, actionForCommand('calendar.monthView'), ctx);
  assert.equal(t.state.miniMonth, null);
});

test('review1: entries lock a no-move event and anything on a read-only calendar', () => {
  const ctx = ctxFor();
  // Q4 review is an invite: can.move is false, so the grid draws it locked (no cursor, no handles).
  assert.equal(ctx.entries.find(e => e.id === 'q4')?.locked, true);
  assert.equal(ctx.entries.find(e => e.id === 'dental')?.locked, undefined);
  const readOnlyCal = {
    ...demoWorld.calendars.find(c => c.id === 'personal')!,
    id: 'ro',
    readOnly: true,
  };
  const onRo = { ...ctx.events.get('dental')!, id: 'ro1', calendarId: 'ro' };
  const ctxRo = ctxFor([onRo], demoWorld.plans, [...demoWorld.calendars, readOnlyCal]);
  assert.equal(ctxRo.entries.find(e => e.id === 'ro1')?.locked, true);
});

test('review1: a calendar toggle plans its write with one Undo toast', () => {
  const ctx = ctxFor();
  const t = update(S(), { type: 'toggleCalendar', id: 'personal' }, ctx);
  const fx = t.effects.find(f => f.kind === 'calendarSet');
  assert.ok(fx && fx.kind === 'calendarSet');
  assert.equal(fx.shown, false);
  assert.equal(fx.toast?.undoable, true);
  assert.equal(fx.toast?.message, 'Personal hidden');
});

test('review1: an overlay entry settles when the window reaches it or the epoch resets', () => {
  const at = { dbEpoch: 'one', seq: 5 };
  assert.equal(reached(null, at), false);
  assert.equal(reached({ dbEpoch: 'one', seq: 4 }, at), false);
  assert.equal(reached({ dbEpoch: 'one', seq: 5 }, at), true);
  // After an engine reset the epoch differs: the write's old seq is meaningless, so the overlay drops.
  assert.equal(reached({ dbEpoch: 'two', seq: 0 }, at), true);
});

test('review1: a shown override clears once Calendar/get reflects it or the write settled', () => {
  const work = demoWorld.calendars[0];
  const pending: ReadonlyMap<string, ShownOverride> = new Map([
    [work.id, { shown: false, settled: false }],
  ]);
  // A get that still shows the old value while the write is in flight keeps the override.
  assert.equal(reconcileShown(pending, demoWorld.calendars).get(work.id)?.shown, false);
  // One that reflects it clears it.
  const hidden = demoWorld.calendars.map(c => (c.id === work.id ? { ...c, shown: false } : c));
  assert.equal(reconcileShown(pending, hidden).size, 0);
  // After the write settled the get is authoritative, so an engine-side change comes through.
  const settled: ReadonlyMap<string, ShownOverride> = new Map([
    [work.id, { shown: false, settled: true }],
  ]);
  assert.equal(reconcileShown(settled, demoWorld.calendars).size, 0);
});

test('review1: Send reply stays disabled while the chosen answer is the one already sent', () => {
  const answered = { ...ctxFor().events.get('q4')!, myResponse: 'accepted' as const };
  const ctx = ctxFor([answered]);
  const same = S({
    selectedId: 'q4',
    detailId: 'q4',
    rsvp: { eventId: 'q4', answer: 'yes', changing: true },
  });
  // Re-picking the reply already sent leaves nothing to send: answer reads null, the button disables.
  assert.equal(viewModel(same, ctx).reply?.answer, null);
  const other = S({
    selectedId: 'q4',
    detailId: 'q4',
    rsvp: { eventId: 'q4', answer: 'maybe', changing: true },
  });
  assert.equal(viewModel(other, ctx).reply?.answer, 'maybe');
});

test('review1: a calendar toggle pushes its Undo toast and settles the override', async () => {
  const { flush } = await boot();
  resetToasts();
  try {
    const ui = testUi();
    const cal = (await api.calendar.get({})).list[0];
    runCalendarEffect(
      {
        kind: 'calendarSet',
        id: cal.id,
        shown: !cal.shown,
        toast: {
          kind: 'info',
          message: `${cal.name} ${cal.shown ? 'hidden' : 'shown'}`,
          undoable: true,
        },
      },
      ports(),
      ui,
    );
    assert.equal(ui.overrides.get(cal.id), !cal.shown);
    await flush();
    assert.ok(ui.settled.includes(cal.id));
    assert.equal(ui.failed.length, 0);
    const toast = getToasts().find(t => t.undoable);
    assert.ok(toast && toast.actions?.[0]?.keysFrom === 'app.undo');
  } finally {
    resetToasts();
  }
});

test('review1: RSVP sends the scope and words the toast while held, then sent', async () => {
  resetToasts();
  try {
    const ui = testUi();
    const sent: Array<{ opId: string; id: string; scope: 'occurrence' | 'series' }> = [];
    // A hold: the reply stays undoable until undoUntil, so the toast keeps the held wording.
    const heldUntil = Date.now() + 60_000;
    runCalendarEffect(
      {
        kind: 'rsvp',
        id: 'q4',
        response: 'accepted',
        scope: 'series',
        answer: 'yes',
        optimistic: { id: 'q4', patch: { myReply: 'yes' } },
        organizer: 'Theo',
        failure: "Couldn't send your reply.",
      },
      {
        ...ports(),
        eventRsvp: args => {
          sent.push({ opId: args.opId, id: args.id, scope: args.scope });
          return Promise.resolve({
            opId: args.opId,
            appliedState: { dbEpoch: 'one', seq: 1 },
            undoUntil: heldUntil,
          });
        },
      },
      ui,
    );
    assert.equal(sent[0]?.scope, 'series');
    assert.ok(getToasts().some(t => t.message === 'Replying Yes to Theo'));
    await new Promise(resolve => setImmediate(resolve));
    // Still held: the toast has not switched to the sent wording yet.
    assert.equal(
      getToasts().some(t => t.message === 'Replied Yes to Theo'),
      false,
    );
    // With no hold left the receipt's wording lands: the toast reads sent. A different event —
    // a second reply on the held one would be refused `calendar.holdPending` (review15).
    runCalendarEffect(
      {
        kind: 'rsvp',
        id: 'sync',
        response: 'accepted',
        scope: 'occurrence',
        answer: 'yes',
        optimistic: { id: 'sync', patch: { myReply: 'yes' } },
        organizer: 'Theo',
        failure: "Couldn't send your reply.",
      },
      {
        ...ports(),
        eventRsvp: () =>
          Promise.resolve({ opId: 'second', appliedState: { dbEpoch: 'one', seq: 1 } }),
      },
      ui,
    );
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(getToasts().some(t => t.message === 'Replied Yes to Theo'));
  } finally {
    resetToasts();
  }
});

test('review1: y/m/n never answers inside another dialog or sheet, only the calendar’s own surfaces', () => {
  const nothing = { closest: () => null, matches: () => false };
  const key = { key: 'n', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };
  // A foreign role=dialog (the shortcut sheet) over an open invite: the key is not the calendar's.
  const sheet = {
    closest: (s: string) => (s.includes('dialog') || s === '.ui-popover' ? nothing : null),
    matches: () => false,
  };
  assert.equal(inCalendarSurface(sheet), false);
  assert.equal(takesInviteAnswerKey(key, sheet, false), false);
  // Inside the event detail popover's own content or on the shell popover that wraps it.
  const inOwn = {
    closest: (s: string) => (s.includes('cal-screen__popover') ? nothing : null),
    matches: () => false,
  };
  const shell = {
    closest: (s: string) => (s === '.ui-popover' ? ownShell : null),
    matches: () => false,
  };
  const ownShell = {
    closest: (s: string) => (s === '.ui-popover' ? ownShell : null),
    matches: () => false,
    querySelector: (s: string) => (s.includes('cal-screen__popover') ? nothing : null),
  };
  assert.equal(inCalendarSurface(inOwn), true);
  assert.equal(inCalendarSurface(shell), true);
  assert.equal(takesInviteAnswerKey(key, inOwn, true), true);
  // One of the calendar's own menus (cal-menu- id).
  const inMenu = {
    closest: (s: string) => (s.includes('cal-menu-') ? nothing : null),
    matches: () => false,
  };
  assert.equal(inCalendarSurface(inMenu), true);
});

test('review1: the MiniMonth marks come from the loaded window, not the drawn period', () => {
  const ctx = ctxFor();
  const period = periodOf('week', THU, 0);
  // 'lease' (Nov 4) is outside the week but inside the watched events window.
  assert.equal(
    ctx.entries.some(e => e.id === 'lease'),
    false,
  );
  const windowEntries = entriesFor({
    events: [...ctx.events.values()],
    plans: [],
    calendars: ctx.calendars,
    solo: null,
    period: { from: period.from, to: ctx.loadedThrough },
    planCalendarId: 'work',
  });
  const sidebar = calendarSidebar({
    state: S(),
    calendars: ctx.calendars,
    entries: windowEntries,
    today: THU,
    weekStartsOn: 0,
    dispatch: () => undefined,
    accounts: [],
    accountsLoaded: true,
    calendarsLoaded: true,
    onAccessAction: () => undefined,
  });
  assert.ok(sidebar.miniMonth.marks?.includes('2026-11-04'));
});

test('review1: a month-view stack anchor matches the day:id DOM id MonthGrid renders', () => {
  assert.equal(stackDomMatch(['e1', 'e2'], ['ui-stack-e1']), 'ui-stack-e1');
  assert.equal(stackDomMatch(['e1'], ['ui-stack-2026-10-29_3a_e1']), 'ui-stack-2026-10-29_3a_e1');
  assert.equal(stackDomMatch(['e1'], ['ui-stack-other']), null);
});

test('review1: Return on a button belongs to the button, not to calendar.open', () => {
  const nothing = { closest: () => null, matches: () => false };
  const onButton = {
    closest: (s: string) => (s === 'button' || s.includes('button') ? nothing : null),
    matches: () => false,
  };
  assert.equal(ownsReturn(onButton), true);
  assert.equal(ownsReturn(nothing), false);
  assert.equal(ownsReturn(null), false);
});

test('review1: calendars still loading is never an empty calendar', () => {
  const state = S({ view: 'day', anchor: '2026-11-01' });
  const vm = viewModel(state, { ...ctxAt(state), calendarsReady: false });
  assert.equal(vm.empty, null);
  assert.equal(vm.emptyAction, false);
  const ready = viewModel(state, ctxAt(state));
  assert.equal(ready.empty?.sentence, 'Nothing on Sunday, November 1');
});
