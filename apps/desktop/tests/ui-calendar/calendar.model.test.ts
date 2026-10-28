// Run: cd apps/desktop && TZ=America/Los_Angeles npx tsx --test tests/ui-calendar/*.test.ts*
// The Calendar screen's pure model (DESIGN 7.8, 7.14, 8; plan 30 U7 acceptance 6). Test names follow
// tests/ui-calendar/pending.test.ts where one matches; the rest name the model rule they cover.
import './tz';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Calendar, Event } from '../../src/renderer/data';
import { HARNESS_NOW_MS } from '../../src/renderer/data';
import { createAppRegistry } from '../../src/renderer/commands';
import { context, keydown, wiredRegistry } from '../../src/renderer/commands/testing';
import { copyProblem } from '../../src/renderer/commands/internal';
import { hoursOf } from '../../src/renderer/ui/calendar/dates';
import {
  actionForCommand,
  CALENDAR_COMMAND_IDS,
  calendarInfos,
  canSendReply,
  commandEnabled,
  defaultCalendarId,
  detailMenu,
  draftChange,
  draftFromEvent,
  draftProblem,
  editorShowsDelete,
  entriesFor,
  eventData,
  eventsSpec,
  gridLabel,
  hashTag,
  initialState,
  inviteOpen,
  MAX_RANGE_DAYS,
  newDraft,
  nextFreeSlot,
  overlayWith,
  periodDays,
  periodOf,
  planEntryId,
  rsvpMessage,
  shownView,
  shownViewFor,
  stepAnchor,
  tagFor,
  topLabel,
  undoMode,
  holdPhase,
  update,
  viewModel,
  visibleCalendarIds,
  walk,
  weekStartsOnFor,
  type CalendarAction,
  type CalendarContext,
  type CalendarEffect,
  type CalendarState,
} from '../../src/renderer/screens/calendar/calendar.model';
import { demoWorld } from '../../src/renderer/screens/calendar/preview/states';

const THU = '2026-10-29';
const { calendars, events, plans, worst, holidays, halloween } = demoWorld;

function ctxFor(
  state: CalendarState,
  over: { events?: readonly Event[]; calendars?: readonly Calendar[]; now?: number } = {},
): CalendarContext {
  const evs = over.events ?? events;
  const cals = over.calendars ?? calendars;
  const period = periodOf(shownView(state), state.anchor, 0);
  const def = defaultCalendarId(cals);
  return {
    now: over.now ?? HARNESS_NOW_MS,
    weekStartsOn: 0,
    entries: entriesFor({ events: evs, plans, calendars: cals, solo: state.solo, period, planCalendarId: def }),
    events: new Map(evs.map(e => [e.id, e])),
    plans: new Map(plans.map(p => [p.id, p])),
    calendars: cals,
    defaultCalendarId: def,
  };
}

/** Runs actions in order, rebuilding the context each step as the container does; returns the end state and every effect. */
function run(state: CalendarState, actions: readonly CalendarAction[], over: Parameters<typeof ctxFor>[1] = {}) {
  let s = state;
  const effects: CalendarEffect[] = [];
  for (const a of actions) {
    const t = update(s, a, ctxFor(s, over));
    s = t.state;
    effects.push(...t.effects);
  }
  return { state: s, effects };
}

const week = (over: Partial<CalendarState> = {}): CalendarState => ({ ...initialState(THU), ...over });
const standupOn = (day: string) => events.find(e => e.title === 'Standup' && e.start.type === 'utc' && new Date(e.start.utc).toISOString().startsWith(day))!;

describe('ui-calendar: periods, ranges and labels', () => {
  test('week renders 7 columns Sun-Sat with today tinted – the period is Sunday to Saturday around today', () => {
    const p = periodOf('week', THU, 0);
    assert.deepEqual(p.days, ['2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28', THU, '2026-10-30', '2026-10-31']);
    assert.equal(p.start, '2026-10-25');
    assert.equal(p.from, new Date(2026, 9, 25).getTime());
    assert.equal(p.to, new Date(2026, 10, 1).getTime());
    assert.deepEqual(periodOf('week', THU, 1).days[0], '2026-10-26');
  });

  test('month covers six weeks from the first weekday and the events window stays within 62 days', () => {
    const p = periodOf('month', THU, 0);
    assert.equal(p.days.length, 42);
    assert.equal(p.start, '2026-10-01');
    assert.equal(p.days[0], '2026-09-27');
    assert.ok(periodDays(p) <= MAX_RANGE_DAYS);
    const spec = eventsSpec(p, ['work', 'family']);
    assert.deepEqual(spec, { kind: 'events', from: p.from, to: p.to, calendarIds: ['family', 'work'] });
    assert.throws(() => eventsSpec({ ...p, to: p.from + 63 * 86_400_000 }, []), /62 days/);
  });

  test('day title carries the comma and year – live region "Sunday, November 1, 2026. Nothing scheduled." (U7 acc. 6, comma in day titles)', () => {
    const p = periodOf('day', '2026-11-01', 0);
    assert.equal(gridLabel('day', p, '2026-11-01', 0), 'Sunday, November 1, 2026. Nothing scheduled.');
    assert.equal(gridLabel('day', periodOf('day', THU, 0), THU, 3), 'Thursday, October 29, 2026. 3 events.');
    assert.equal(gridLabel('week', periodOf('week', THU, 0), THU, 0), 'Week of Sunday, October 25, 2026');
  });

  test('the top row is a month label with the range: within a month, across months, across years, a day, a month', () => {
    assert.deepEqual(topLabel('week', periodOf('week', THU, 0), THU), { label: 'October 2026', range: 'October 25 – 31' });
    assert.deepEqual(topLabel('week', periodOf('week', '2026-11-01', 1), '2026-11-01'), {
      label: 'Oct – Nov 2026',
      range: 'Oct 26 – Nov 1',
    });
    assert.deepEqual(topLabel('week', periodOf('week', '2026-12-31', 0), '2026-12-31'), {
      label: 'Dec 2026 – Jan 2027',
      range: 'Dec 27 – Jan 2',
    });
    assert.deepEqual(topLabel('day', periodOf('day', THU, 0), THU), { label: 'October 2026', range: 'Thursday, October 29' });
    assert.equal(topLabel('month', periodOf('month', THU, 0), THU, 1).range, '1 event');
    assert.equal(topLabel('month', periodOf('month', THU, 0), THU, 0).range, 'No events');
    assert.equal(topLabel('month', periodOf('month', THU, 0), THU, 1204).range, '1,204 events');
  });

  test('DST: the day of 2026-11-01 is 25 hours long and the week still has seven days', () => {
    const day = periodOf('day', '2026-11-01', 0);
    assert.equal(day.to - day.from, 25 * 3_600_000);
    const w = periodOf('week', '2026-11-01', 0);
    assert.equal(periodDays(w), 7);
    assert.equal(w.days.length, 7);
  });

  test('DST event keeps its wall time – an 11:00 weekly event stays at 11:00 across 2026-11-01', () => {
    const cal = { id: 'work', name: 'Work', color: 'hill' as const };
    for (const day of ['2026-10-29', '2026-11-05']) {
      const entry = eventData(standupOn(day), cal);
      assert.equal(hoursOf(entry.start), 11, day);
      assert.equal(hoursOf(entry.end), 11.25, day);
    }
    const before = standupOn('2026-10-29');
    const after = standupOn('2026-11-05');
    assert.ok(before.start.type === 'utc' && after.start.type === 'utc');
    assert.equal(after.start.utc - before.start.utc, 7 * 86_400_000 + 3_600_000);
  });

  test('narrow pane under 720 px shows the agenda list – an unmeasured pane keeps the chosen view', () => {
    assert.equal(shownViewFor('week', 719), 'agenda');
    assert.equal(shownViewFor('day', 400), 'agenda');
    assert.equal(shownViewFor('week', 720), 'week');
    assert.equal(shownViewFor('month', 0), 'month');
  });

  test('week start follows the setting, else the locale', () => {
    assert.equal(weekStartsOnFor(1, 'en-US'), 1);
    assert.equal(weekStartsOnFor(0, 'en-GB'), 0);
    assert.equal(weekStartsOnFor(undefined, 'en-GB'), 1);
    assert.equal(weekStartsOnFor(undefined, 'en-US'), 0);
    assert.equal(weekStartsOnFor(6, 'en-US'), 0);
    assert.equal(weekStartsOnFor(undefined, 'not a locale'), 0);
  });
});

describe('ui-calendar: contract rows to grid entries', () => {
  test('all-day dates draw from local midnight to the exclusive end; 24 hours or more goes to the all-day strip', () => {
    const cal = { id: 'holidays', name: 'Holidays', color: 'dusk' as const };
    const h = eventData(halloween, cal);
    assert.equal(h.allDay, true);
    assert.equal(h.start, '2026-10-31T00:00:00');
    assert.equal(h.end, '2026-11-01T00:00:00');
    const marathon = eventData(worst.find(e => e.id === 'marathon')!, cal);
    assert.equal(marathon.allDay, true, 'a 36-hour event is drawn in the strip');
    const zero = eventData(worst.find(e => e.id === 'dst-zero')!, cal);
    assert.equal(zero.start, zero.end);
    assert.equal(zero.allDay, undefined);
  });

  test('an invite is unanswered until you reply, your own event is not an invite, and only stored rows are persisted', () => {
    const cal = { id: 'work', name: 'Work', color: 'hill' as const };
    const q4 = eventData(events.find(e => e.id === 'q4')!, cal);
    assert.equal(q4.unanswered, true);
    assert.equal(q4.myReply, null);
    assert.equal(q4.isOrganizer, false);
    assert.deepEqual(q4.invite, { from: 'Priya Raman', threadId: 'thread-q4' });
    assert.equal(q4.video, 'meet.example.com/q4-review');
    assert.equal(q4.guests?.[0].name, 'Priya Raman', 'the organizer is listed first');
    const design = eventData(events.find(e => e.id === 'design')!, cal);
    assert.equal(design.unanswered, undefined);
    assert.equal(design.myReply, undefined);
    assert.equal(design.isOrganizer, true);
    assert.equal(design.persisted, true);
    assert.equal(eventData({ ...events.find(e => e.id === 'design')!, sync: 'localOnly' }, cal).persisted, false);
  });

  test('entries leave out hidden calendars, Aplos-hidden and cancelled events, and keep open plans dashed', () => {
    const p = periodOf('week', THU, 0);
    const base = { events, plans, calendars, solo: null, period: p, planCalendarId: 'work' };
    const all = entriesFor(base);
    assert.ok(all.some(e => e.id === planEntryId('launch') && e.kind === 'plan' && e.persisted === false));
    const noFamily = entriesFor({ ...base, calendars: calendars.map(c => (c.id === 'family' ? { ...c, shown: false } : c)) });
    assert.ok(!noFamily.some(e => e.calendar.id === 'family'));
    const hidden = entriesFor({ ...base, events: events.map(e => (e.id === 'brunch' ? { ...e, hidden: true } : e.id === 'garden' ? { ...e, status: 'cancelled' } : e)) });
    assert.ok(!hidden.some(e => e.id === 'brunch' || e.id === 'garden'));
    const dismissed = entriesFor({ ...base, plans: plans.map(pl => ({ ...pl, state: 'dismissed' })) });
    assert.ok(!dismissed.some(e => e.kind === 'plan'));
  });

  test('dense month stays complete – 300 occurrences in November all reach the grid (no 200 cut)', () => {
    const many: Event[] = Array.from({ length: 300 }, (_, i) => ({
      ...events[0],
      id: `dense-${i}`,
      start: { type: 'utc', utc: new Date(2026, 10, 1 + (i % 30), 8 + (i % 10)).getTime() },
      end: { type: 'utc', utc: new Date(2026, 10, 1 + (i % 30), 9 + (i % 10)).getTime() },
    }));
    const p = periodOf('month', '2026-11-15', 0);
    const out = entriesFor({ events: many, plans: [], calendars, solo: null, period: p, planCalendarId: null });
    assert.equal(out.length, 300);
  });

  test('worst-case data: a 200-character title, non-Latin titles and 12 overlapping events survive intact', () => {
    const p = periodOf('week', '2026-11-02', 0);
    const out = entriesFor({ events: worst, plans: [], calendars, solo: null, period: p, planCalendarId: null });
    const long = out.find(e => e.id === 'long')!;
    assert.ok(long.title.length >= 200);
    assert.ok(out.some(e => e.title === '週次の振り返りミーティングと来期の計画について'));
    assert.ok(out.some(e => e.title === 'اجتماع مراجعة التصميم مع الفريق'));
    assert.equal(out.filter(e => e.id.startsWith('crowd-')).length, 12);
    assert.ok(out.every(e => new Date(e.end).getTime() >= new Date(e.start).getTime()));
  });

  test('colour tag follows hash with override – colorTag wins, else a stable hash, twins split by account', () => {
    const named = (name: string, extra: Partial<Calendar> = {}): Calendar => ({ ...calendars[0], id: name, name, colorTag: undefined, ...extra });
    const a = named('Book club');
    assert.equal(tagFor(a, [a]), hashTag('book club'));
    assert.equal(tagFor(a, [a]), tagFor({ ...a, name: 'BOOK CLUB' }, [a]), 'case does not change the colour');
    assert.equal(tagFor({ ...a, colorTag: 'stamp' }, [a]), 'stamp');
    assert.equal(tagFor({ ...a, colorTag: 'purple' }, [a]), hashTag('book club'), 'an unknown tag falls back to the hash');
    const b = named('Calendar', { id: 'x', accountId: 'one' });
    const c = named('Calendar', { id: 'y', accountId: 'two' });
    assert.equal(tagFor(b, [b, c]), hashTag('calendar\u0000one'));
    assert.equal(tagFor(c, [b, c]), hashTag('calendar\u0000two'));
  });
});

describe('ui-calendar: the reducer (keys, flows, effects)', () => {
  test('T D W M J K ← → switch views and periods – each changes the label and range; M means Month when no invite is open', () => {
    let s = week({ anchor: '2026-11-20' });
    const step = (id: (typeof CALENDAR_COMMAND_IDS)[number]) => {
      s = update(s, actionForCommand(id), ctxFor(s)).state;
      return s;
    };
    assert.equal(step('calendar.today').anchor, THU);
    assert.equal(step('calendar.nextPeriod').anchor, '2026-11-05');
    assert.equal(step('calendar.previousPeriod').anchor, THU);
    assert.equal(step('calendar.dayView').view, 'day');
    assert.equal(step('calendar.nextPeriod').anchor, '2026-10-30');
    assert.equal(step('calendar.monthView').view, 'month');
    assert.equal(step('calendar.nextPeriod').anchor, '2026-11-30');
    assert.equal(step('calendar.weekView').view, 'week');
    assert.equal(stepAnchor('month', '2027-01-31', 1), '2027-02-28', 'a month step keeps the day or the month’s last');
    assert.equal(viewModel(s, ctxFor(s)).head.label, 'Nov – Dec 2026', 'the week of November 29 crosses into December');
  });

  test('Y M N answer only while an unanswered invite is open – with the popover closed, M switches to Month', () => {
    const closed = week();
    assert.equal(inviteOpen(closed, ctxFor(closed)), false);
    assert.equal(update(closed, { type: 'answer', answer: 'maybe' }, ctxFor(closed)).handled, false);
    const open = run(closed, [{ type: 'open', id: 'q4' }]).state;
    assert.equal(inviteOpen(open, ctxFor(open)), true);
    // The registry routes M and N by the `invite` condition the container reports.
    const registry = wiredRegistry();
    assert.equal(registry.resolve(keydown('m'), context(['calendar']))?.commandId, 'calendar.monthView');
    assert.equal(registry.resolve(keydown('m'), context(['calendar'], { conditions: { invite: true } }))?.commandId, 'calendar.answerMaybe');
    assert.equal(registry.resolve(keydown('n'), context(['calendar']))?.commandId, 'calendar.newEvent');
    assert.equal(registry.resolve(keydown('n'), context(['calendar'], { conditions: { invite: true } }))?.commandId, 'calendar.answerNo');
    // An answered event (your own) never opens the block.
    const own = run(closed, [{ type: 'open', id: 'design' }]).state;
    assert.equal(inviteOpen(own, ctxFor(own)), false);
    assert.ok(createAppRegistry());
  });

  test('rsvp starts with nothing chosen and Send reply disabled – no answer until one is chosen (acc. 6)', () => {
    const s = run(week(), [{ type: 'open', id: 'q4' }]).state;
    const vm = viewModel(s, ctxFor(s));
    assert.deepEqual(vm.reply, { answer: null, canSend: false });
    assert.equal(update(s, { type: 'sendReply' }, ctxFor(s)).effects.length, 0);
    const chosen = run(s, [{ type: 'answer', answer: 'yes' }]).state;
    assert.deepEqual(viewModel(chosen, ctxFor(chosen)).reply, { answer: 'yes', canSend: true });
  });

  test('choosing an answer enables Send reply; Return sends once – exactly one Event/rsvp call with response', () => {
    const { state, effects } = run(week(), [
      { type: 'open', id: 'q4' },
      { type: 'answer', answer: 'no' },
      { type: 'return' },
    ]);
    const rsvps = effects.filter(e => e.kind === 'rsvp');
    assert.equal(rsvps.length, 1);
    const fx = rsvps[0];
    assert.ok(fx.kind === 'rsvp');
    assert.equal(fx.response, 'declined');
    assert.equal(fx.scope, 'occurrence');
    assert.equal(fx.organizer, 'Priya');
    assert.equal(fx.optimistic.patch?.unanswered, false);
    assert.equal(state.rsvp, null);
    // With the optimistic answer applied the invite is answered, so a second Return sends nothing.
    const answered = events.map(e => (e.id === 'q4' ? { ...e, myResponse: 'declined' as const } : e));
    const again = update(state, { type: 'return' }, ctxFor(state, { events: answered }));
    assert.equal(again.effects.filter(e => e.kind === 'rsvp').length, 0);
  });

  test('RSVP on a repeating invite offers occurrence or series – the scope chooser comes first, never `following`', () => {
    const series = events.map(e => (e.id === 'q4' ? { ...e, recurring: true, seriesId: 'q4s' } : e));
    const asked = run(week(), [{ type: 'open', id: 'q4' }, { type: 'answer', answer: 'yes' }, { type: 'sendReply' }], { events: series });
    assert.equal(asked.state.scope?.action, 'reply');
    assert.equal(asked.effects.filter(e => e.kind === 'rsvp').length, 0);
    const sent = run(asked.state, [{ type: 'scope', scope: 'series' }], { events: series });
    const fx = sent.effects.find(e => e.kind === 'rsvp');
    assert.ok(fx && fx.kind === 'rsvp' && fx.scope === 'series');
  });

  test('changing a reply starts on your answer and Send reply waits for a different one', () => {
    const answered = events.map(e => (e.id === 'q4' ? { ...e, myResponse: 'accepted' as const } : e));
    const s = run(week(), [{ type: 'open', id: 'q4' }, { type: 'menu', item: 'changeReply' }], { events: answered }).state;
    const ctx = ctxFor(s, { events: answered });
    assert.equal(s.rsvp?.answer, 'yes');
    assert.equal(canSendReply(s.rsvp, ctx.entries.find(e => e.id === 'q4')), false);
    assert.equal(inviteOpen(s, ctx), true, 'Y/M/N answer while the block shows');
    const changed = run(s, [{ type: 'answer', answer: 'maybe' }], { events: answered }).state;
    assert.equal(canSendReply(changed.rsvp, ctx.entries.find(e => e.id === 'q4')), true);
  });

  test('held replies and deletes read as pending, and undo cancels them until undoUntil – nothing reaches Google before it', () => {
    const now = HARNESS_NOW_MS;
    const receipt = { undoUntil: now + 8000, undoable: true };
    assert.equal(undoMode(receipt, now + 7900), 'cancel');
    assert.equal(undoMode(receipt, now + 8100), 'inverse');
    assert.equal(undoMode({ undoable: false }, now), 'none');
    assert.equal(holdPhase(receipt, now + 7900), 'held');
    assert.equal(holdPhase(receipt, now + 8000), 'sent');
    assert.equal(rsvpMessage('yes', 'Priya', 'held'), 'Replying Yes to Priya');
    assert.equal(rsvpMessage('no', undefined, 'sent'), 'Replied No');
  });

  test('delete is undoable for 8 s – ⌫ removes the event at once with "Event deleted" and Undo, and the selection moves on', () => {
    const { state, effects } = run(week({ selectedId: 'design' }), [{ type: 'delete' }]);
    const fx = effects.find(e => e.kind === 'eventSet');
    assert.ok(fx && fx.kind === 'eventSet');
    assert.deepEqual(fx.change, { type: 'destroy', id: 'design', scope: 'occurrence' });
    assert.equal(fx.optimistic.remove, true);
    assert.deepEqual(fx.toast, { kind: 'trash', message: 'Event deleted', undoable: true });
    assert.equal(state.selectedId, 'climb', 'focus never lost: the next event in time order');
    assert.ok(effects.some(e => e.kind === 'focus'));
  });

  test('no Delete on an unsaved event – the draft has no Delete; a stored event has it in ⋯ (acc. 6)', () => {
    const s = week();
    const ctx = ctxFor(s);
    assert.equal(editorShowsDelete(newDraft(THU, HARNESS_NOW_MS, ctx.entries, 'work')), false);
    const stored = draftFromEvent(events.find(e => e.id === 'design')!);
    assert.equal(editorShowsDelete(stored), true);
    assert.equal(editorShowsDelete({ ...stored, persisted: false }), false);
    const ids = (entryId: string, c = ctx) =>
      detailMenu(c.entries.find(e => e.id === entryId)!, c).flatMap(m => (m.kind === 'item' ? [m.id] : []));
    assert.ok(ids('design').includes('delete'));
    assert.ok(!ids('q4').includes('delete'), 'not your event');
    const local = events.map(e => (e.id === 'design' ? { ...e, sync: 'localOnly' as const } : e));
    const lctx = ctxFor(s, { events: local });
    assert.ok(!ids('design', lctx).includes('delete'));
    assert.equal(update(week({ selectedId: 'design' }), { type: 'delete' }, lctx).effects.length, 0, '⌫ on an unsaved event does nothing');
    assert.equal(commandEnabled('calendar.delete', week({ selectedId: 'design' }), lctx), false);
  });

  test('moving a locked event does nothing – a move on an invite you do not organise writes nothing and says why', () => {
    const { effects } = run(week(), [{ type: 'move', id: 'q4', start: '2026-10-30T13:00:00', end: '2026-10-30T14:00:00' }]);
    assert.equal(effects.filter(e => e.kind === 'eventSet').length, 0);
    assert.deepEqual(effects, [{ kind: 'notice', message: 'Only Priya can change this event.' }]);
    const ro = run(week({ selectedId: 'halloween' }), [{ type: 'edit' }], { events: [...events, halloween], calendars: [...calendars, holidays] });
    assert.equal(ro.state.editor, null);
    assert.match((ro.effects[0] as { message: string }).message, /Holidays is read-only/);
  });

  test('repeating event move asks This event / All events; following hidden – two options, then one write with the scope', () => {
    const standup = standupOn(THU);
    const asked = run(week(), [{ type: 'move', id: standup.id, start: '2026-10-29T11:30:00', end: '2026-10-29T11:45:00' }]);
    assert.equal(asked.state.scope?.action, 'move');
    assert.equal(asked.effects.length, 0);
    const done = run(asked.state, [{ type: 'scope', scope: 'series' }]);
    const fx = done.effects.find(e => e.kind === 'eventSet');
    assert.ok(fx && fx.kind === 'eventSet' && fx.change.type === 'update');
    assert.equal(fx.change.scope, 'series');
    assert.ok(fx.change.fields.start?.type === 'utc');
    const all = JSON.stringify([...asked.effects, ...done.effects]);
    assert.doesNotMatch(all, /following/);
    assert.equal(run(asked.state, [{ type: 'escape' }]).state.scope, null);
  });

  test('a plain move writes only start and end, optimistically, and a resize keeps the start', () => {
    const moved = run(week(), [{ type: 'move', id: 'design', start: '2026-10-29T15:00:00', end: '2026-10-29T15:30:00' }]);
    const fx = moved.effects[0];
    assert.ok(fx.kind === 'eventSet' && fx.change.type === 'update');
    assert.deepEqual(Object.keys(fx.change.fields).sort(), ['end', 'start']);
    assert.match(fx.optimistic.patch?.start ?? '', /^2026-10-29T15:00:00/);
    assert.equal(fx.failure, "Couldn't move Design review with Mina and Jordan.");
    const resized = run(week(), [{ type: 'resize', id: 'design', end: '2026-10-29T15:00:00' }]);
    const rf = resized.effects[0];
    assert.ok(rf.kind === 'eventSet' && rf.change.type === 'update');
    assert.deepEqual(Object.keys(rf.change.fields), ['end']);
  });

  test('↑/↓ move the selection through events in time order – it wraps at neither end', () => {
    const s = week({ view: 'day' });
    const day = ctxFor(s).entries.filter(e => e.start.startsWith(THU));
    const ids = day.map(e => e.id);
    assert.equal(walk(day, null, 1), ids[0]);
    assert.equal(walk(day, null, -1), ids[ids.length - 1]);
    assert.equal(walk(day, ids[0], 1), ids[1]);
    assert.equal(walk(day, ids[ids.length - 1], 1), null);
    assert.equal(walk(day, ids[0], -1), null);
  });

  test('N opens a new event on the default calendar – at the next free half hour, 9 AM on other days', () => {
    const { state } = run(week(), [{ type: 'newEvent' }]);
    assert.equal(state.editor?.calendarId, 'work', 'the primary writable calendar');
    assert.equal(state.editor?.date, THU);
    assert.equal(state.editor?.start, '11:30', 'past Dental (to 10:30) and Standup (11:00)');
    assert.equal(state.editor?.end, '12:30');
    assert.equal(state.editor?.persisted, false);
    assert.equal(defaultCalendarId(calendars, 'hollow'), 'hollow', 'the setting wins');
    assert.equal(defaultCalendarId([{ ...holidays }], 'holidays'), null, 'never a read-only calendar');
    assert.deepEqual(nextFreeSlot('2026-11-01', HARNESS_NOW_MS, []), { start: '09:00', end: '10:00' });
    const later = run(week({ anchor: '2026-11-12' }), [{ type: 'newEvent' }]).state;
    assert.equal(later.editor?.date, '2026-11-12');
  });

  test('the editor refuses with the contract sentences and saves only what changed', () => {
    const design = events.find(e => e.id === 'design')!;
    const d = draftFromEvent(design);
    assert.equal(draftProblem({ ...d, title: '  ' }), 'Give the event a title.');
    assert.equal(draftProblem({ ...d, end: '13:00' }), 'An event must end after it starts.');
    assert.equal(draftProblem(d), null);
    assert.equal(draftChange(d, design, 'occurrence'), null, 'nothing changed, nothing written');
    const change = draftChange({ ...d, title: 'Design review' }, design, 'occurrence');
    assert.deepEqual(change, { type: 'update', id: 'design', scope: 'occurrence', fields: { title: 'Design review' } });
    const refused = run(week({ editor: { ...d, title: '' } }), [{ type: 'editorSave' }]);
    assert.equal(refused.state.editor?.error, 'Give the event a title.');
    assert.equal(refused.effects.length, 0);
    const created = run(week(), [{ type: 'newEvent' }, { type: 'editor', patch: { title: 'Pick up prints' } }, { type: 'editorSave' }]);
    const fx = created.effects[0];
    assert.ok(fx.kind === 'eventSet' && fx.change.type === 'create');
    assert.equal(fx.change.calendarId, 'work');
    assert.equal(fx.toast, undefined, 'saves never toast');
    assert.equal(created.state.editor, null);
  });

  test('moving the start in the editor keeps the length', () => {
    const s = run(week(), [{ type: 'newEvent' }, { type: 'editor', patch: { start: '15:00' } }]).state;
    assert.equal(s.editor?.start, '15:00');
    assert.equal(s.editor?.end, '16:00');
  });

  test('Esc ladder closes popover, then the stack menu, then clears selection, never leaves Calendar', () => {
    let s = run(week(), [{ type: 'openStack', ids: ['oneone'] }]).state;
    s = run(s, [{ type: 'escape' }]).state;
    assert.equal(s.stackIds, null);
    s = run(s, [{ type: 'open', id: 'design' }, { type: 'more', open: true }]).state;
    s = run(s, [{ type: 'escape' }]).state;
    assert.equal(s.moreOpen, false);
    assert.equal(s.detailId, 'design');
    s = run(s, [{ type: 'escape' }]).state;
    assert.equal(s.detailId, null);
    assert.equal(s.selectedId, 'design');
    s = run(s, [{ type: 'escape' }]).state;
    assert.equal(s.selectedId, null);
    const last = update(s, { type: 'escape' }, ctxFor(s));
    assert.equal(last.handled, false, 'the key falls through; Calendar stays');
    assert.equal(last.state.view, 'week');
  });

  test('Return opens the selection: a popover in week view, the rail in day view', () => {
    const w = run(week({ selectedId: 'design' }), [{ type: 'return' }]).state;
    assert.equal(w.detailId, 'design');
    const d = run(week({ view: 'day', selectedId: 'design' }), [{ type: 'return' }]);
    assert.equal(d.state.detailId, null);
    assert.deepEqual(d.effects, [{ kind: 'focus', target: 'rail' }]);
    assert.equal(commandEnabled('calendar.open', week(), ctxFor(week())), false);
    assert.equal(commandEnabled('calendar.edit', week({ selectedId: 'design' }), ctxFor(week())), true);
  });

  test('calendar list toggles and solos – click hides Family; ⌥-click Work shows only Work, again brings the rest back', () => {
    const toggled = run(week(), [{ type: 'toggleCalendar', id: 'family' }]);
    assert.deepEqual(toggled.effects, [{ kind: 'calendarSet', id: 'family', shown: false }]);
    const solo = run(week(), [{ type: 'soloCalendar', id: 'work' }]).state;
    assert.equal(solo.solo, 'work');
    assert.deepEqual(visibleCalendarIds(calendars, solo.solo), ['work']);
    assert.deepEqual(calendarInfos(calendars, 'work').map(c => c.visible), [true, false, false, false]);
    assert.ok(ctxFor(solo).entries.filter(e => e.kind === 'event').every(e => e.calendar.id === 'work'));
    assert.equal(run(solo, [{ type: 'soloCalendar', id: 'work' }]).state.solo, null);
    const left = run(solo, [{ type: 'toggleCalendar', id: 'family' }]);
    assert.equal(left.state.solo, null, 'a plain click while solo restores the saved set');
    assert.equal(left.effects.length, 0);
  });

  test('plans confirm to the default calendar and Not now dismisses them, both at once', () => {
    const open = run(week(), [{ type: 'open', id: planEntryId('launch') }]).state;
    const confirmed = run(open, [{ type: 'confirmPlan' }]);
    assert.deepEqual(confirmed.effects[0], {
      kind: 'planConfirm',
      planId: 'launch',
      calendarId: 'work',
      optimistic: { id: planEntryId('launch'), remove: true },
    });
    const dismissed = run(open, [{ type: 'menu', item: 'notNow' }]);
    assert.equal(dismissed.effects[0].kind, 'planDismiss');
    assert.equal(run(open, [{ type: 'openSource' }]).effects[0].kind, 'openThread');
  });

  test('an optimistic overlay moves, removes and adds entries until the window catches up', () => {
    const p = periodOf('week', THU, 0);
    let o = overlayWith({ patch: new Map(), removed: new Set(), added: [] }, { id: 'design', patch: { start: '2026-10-29T16:00:00-07:00', end: '2026-10-29T16:30:00-07:00' } });
    o = overlayWith(o, { id: 'brunch', remove: true });
    const out = entriesFor({ events, plans, calendars, solo: null, period: p, planCalendarId: 'work', overlay: o });
    assert.equal(out.find(e => e.id === 'design')?.start, '2026-10-29T16:00:00-07:00');
    assert.ok(!out.some(e => e.id === 'brunch'));
  });

  test('every command the screen attaches is in the catalog, and every string the model writes passes DESIGN 10', () => {
    const registry = createAppRegistry();
    for (const id of CALENDAR_COMMAND_IDS) assert.ok(registry.get(id), id);
    const s = run(week(), [{ type: 'open', id: 'q4' }, { type: 'answer', answer: 'yes' }]).state;
    const ctx = ctxFor(s, { events: [...events, halloween], calendars: [...calendars, holidays] });
    const vm = viewModel(s, ctx);
    const strings = [vm.head.label, vm.head.range, vm.gridLabel, ...ctx.entries.flatMap(e => detailMenu(e, ctx)).flatMap(m => (m.kind === 'item' ? [m.label, m.detail ?? ''] : []))];
    for (const text of strings) assert.equal(copyProblem(text), null, text);
  });
});
