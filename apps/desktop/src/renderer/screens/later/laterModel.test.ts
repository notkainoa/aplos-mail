/**
 * Later's pure logic: groups from the view's sections (and an emptied group held at 0), the presets and the moment each
 * drop target resolves to, the drag reducer (lift threshold, targets, Overdue never a target, the release) and the
 * date picker's model. Dates are built with the local-time constructor so the tests hold in any time zone.
 * Run: `cd apps/desktop && npx tsx --test 'src/renderer/screens/later/*.test.ts*'`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { WindowSection } from '../../data';
import {
  GROUP_ORDER,
  flatIds,
  groupsOf,
  keepEmptied,
  withDropZones,
  type LaterGroup,
} from './laterGroups';
import {
  DRAG_THRESHOLD,
  IDLE,
  dragReducer,
  dropFor,
  dropTargets,
  groupAt,
  headerDrop,
  type DragState,
} from './laterDrag';
import { CLOSED, dayAfter, pickedUntil, pickerReducer } from './laterPickerState';
import { guarded } from './laterCommands';
import { laterPresets, momentLabel, presetById, presetOptions } from './laterPresets';

const section = (key: string, start: number, count: number): WindowSection => ({
  key,
  start,
  count,
});
const at = (month: number, day: number, hour = 10) =>
  new Date(2026, month - 1, day, hour).getTime();

test('groupsOf slices the window by each section, in display order, and skips empty and unknown ones', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const groups = groupsOf(
    ids,
    [
      section('someday', 4, 1),
      section('overdue', 0, 2),
      section('week', 2, 2),
      section('soon', 9, 1),
      section('today', 4, 0),
    ],
    0,
  );
  assert.deepEqual(
    groups.map(group => [group.key, group.label, group.ids, group.count]),
    [
      ['overdue', 'Overdue', ['a', 'b'], 2],
      ['week', 'This week', ['c', 'd'], 2],
      ['someday', 'Someday', ['e'], 1],
    ],
  );
  assert.deepEqual(flatIds(groups), ids);
});

test('groupsOf clips a group to a window that starts part-way into the view', () => {
  const groups = groupsOf(['c', 'd', 'e'], [section('overdue', 0, 3), section('week', 3, 4)], 2);
  assert.deepEqual(
    groups.map(group => [group.key, group.ids, group.count]),
    [
      ['overdue', ['c'], 3],
      ['week', ['d', 'e'], 4],
    ],
  );
});

test('an emptied group stays at 0 in its place while held, and goes when the hold releases', () => {
  const full = groupsOf(
    ['a', 'b', 'c'],
    [section('overdue', 0, 1), section('today', 1, 1), section('week', 2, 1)],
    0,
  );
  const afterMove = groupsOf(['a', 'c'], [section('overdue', 0, 1), section('week', 1, 1)], 0);
  const held = keepEmptied(full, afterMove, true);
  assert.deepEqual(
    held.map(group => [group.key, group.count, group.held]),
    [
      ['overdue', 1, false],
      ['today', 0, true],
      ['week', 1, false],
    ],
  );
  assert.deepEqual(
    keepEmptied(held, afterMove, true).map(group => group.key),
    ['overdue', 'today', 'week'],
    'and it stays',
  );
  assert.deepEqual(
    keepEmptied(held, afterMove, false).map(group => group.key),
    ['overdue', 'week'],
  );
  const never: LaterGroup[] = [];
  assert.deepEqual(
    keepEmptied(never, afterMove, true).map(group => group.key),
    ['overdue', 'week'],
    'a group never shown is not invented',
  );
  assert.deepEqual(GROUP_ORDER, ['overdue', 'today', 'week', 'someday']);
});

test('presets follow the engine rules: evening before 5 PM, weekend Monday to Thursday, next week on the first weekday', () => {
  const ids = (now: number, first = 1) => laterPresets(now, first).map(preset => preset.id);
  assert.deepEqual(
    ids(at(10, 29)),
    ['evening', 'tomorrow', 'weekend', 'nextWeek', 'someday'],
    'Thursday 10:00',
  );
  assert.deepEqual(
    ids(at(10, 29, 17)),
    ['tomorrow', 'weekend', 'nextWeek', 'someday'],
    'no evening after 5 PM',
  );
  assert.deepEqual(
    ids(at(10, 30)),
    ['evening', 'tomorrow', 'nextWeek', 'someday'],
    'Friday has no weekend choice',
  );
  const thursday = laterPresets(at(10, 29));
  assert.equal(presetById(thursday, 'evening')?.until, at(10, 29, 18));
  assert.equal(presetById(thursday, 'tomorrow')?.until, at(10, 30, 8));
  assert.equal(presetById(thursday, 'weekend')?.until, at(10, 31, 8), 'Saturday');
  assert.equal(presetById(thursday, 'nextWeek')?.until, at(11, 2, 8), 'Monday');
  assert.equal(
    presetById(laterPresets(at(10, 29), 0), 'nextWeek')?.until,
    at(11, 1, 8),
    'Sunday-first weeks',
  );
  assert.equal(presetById(thursday, 'someday')?.until, undefined);
  assert.equal(presetOptions(thursday).at(-1)?.at, undefined);
  assert.match(presetOptions(thursday)[0]?.at ?? '', /^2026-10-29T18:00:00/);
});

test('momentLabel names a drop target by its moment', () => {
  const now = at(10, 29);
  assert.equal(momentLabel(at(10, 29, 18), now), 'Today, 6:00 PM');
  assert.equal(momentLabel(at(10, 30, 8), now), 'Tomorrow, 8:00 AM');
  assert.equal(momentLabel(at(11, 4, 8), now), 'Wed, Nov 4, 8:00 AM');
  assert.equal(momentLabel(undefined, now), 'Someday');
});

test('drop targets: Today lands on this evening, This week on tomorrow, Someday on Someday, Overdue never', () => {
  const now = at(10, 29);
  const targets = dropTargets(laterPresets(now), now);
  assert.deepEqual(
    GROUP_ORDER.map(key => [key, targets[key].state, targets[key].label]),
    [
      ['overdue', 'unavailable', ''],
      ['today', 'available', 'Today, 6:00 PM'],
      ['week', 'available', 'Tomorrow, 8:00 AM'],
      ['someday', 'available', 'Someday'],
    ],
  );
  const late = at(10, 29, 17);
  assert.equal(
    dropTargets(laterPresets(late), late).today.state,
    'unavailable',
    'the evening is gone',
  );
});

function lifted(
  over: 'today' | 'week' | 'someday' | 'overdue' | null,
  from: 'today' | 'week' | 'someday' | 'overdue' = 'overdue',
): DragState {
  return { phase: 'lifted', id: 't', from, over };
}

test('a press lifts only after the threshold, and the state changes only when something visible does', () => {
  const pressed = dragReducer(IDLE, { type: 'press', id: 't', from: 'someday', x: 100, y: 100 });
  assert.equal(pressed.phase, 'pressed');
  assert.equal(
    dragReducer(pressed, { type: 'move', x: 102, y: 101, over: 'week' }),
    pressed,
    'a click is not a drag',
  );
  const wobble = DRAG_THRESHOLD - 1;
  assert.equal(
    dragReducer(pressed, { type: 'move', x: 100 + wobble, y: 100, over: null }),
    pressed,
  );
  const up = dragReducer(pressed, {
    type: 'move',
    x: 100,
    y: 100 + DRAG_THRESHOLD,
    over: 'someday',
  });
  assert.deepEqual(up, { phase: 'lifted', id: 't', from: 'someday', over: 'someday' });
  assert.equal(
    dragReducer(up, { type: 'move', x: 1, y: 2, over: 'someday' }),
    up,
    'pixels alone change nothing',
  );
  const over = dragReducer(up, { type: 'move', x: 1, y: 2, over: 'week' });
  assert.equal(over.phase === 'lifted' && over.over, 'week');
  assert.equal(dragReducer(IDLE, { type: 'move', x: 9, y: 9, over: 'week' }), IDLE);
  assert.equal(dragReducer(over, { type: 'end' }), IDLE);
  assert.equal(dragReducer(IDLE, { type: 'end' }), IDLE);
});

test('headers name every group as a drop target while lifted, with Overdue unavailable', () => {
  const now = at(10, 29);
  const targets = dropTargets(laterPresets(now), now);
  assert.equal(headerDrop('week', IDLE, targets), undefined, 'nothing while at rest');
  assert.deepEqual(headerDrop('week', lifted('week'), targets), {
    label: 'Tomorrow, 8:00 AM',
    state: 'over',
  });
  assert.deepEqual(headerDrop('today', lifted('week'), targets), {
    label: 'Today, 6:00 PM',
    state: 'available',
  });
  assert.deepEqual(headerDrop('overdue', lifted('overdue'), targets), {
    label: '',
    state: 'unavailable',
  });
});

test('a release resolves to a moment, or to nothing over Overdue, outside a group or without a lift', () => {
  const now = at(10, 29);
  const targets = dropTargets(laterPresets(now), now);
  assert.deepEqual(dropFor(lifted('week'), targets), {
    id: 't',
    until: at(10, 30, 8),
    label: 'Tomorrow, 8:00 AM',
  });
  assert.deepEqual(dropFor(lifted('someday'), targets), {
    id: 't',
    until: undefined,
    label: 'Someday',
  });
  assert.equal(dropFor(lifted('overdue'), targets), null, 'you cannot reschedule into the past');
  assert.equal(dropFor(lifted(null), targets), null);
  assert.equal(
    dropFor(lifted('week', 'week'), targets),
    null,
    'a drop on its own group re-dates nothing',
  );
  assert.equal(dropFor(IDLE, targets), null);
  assert.equal(dropFor({ phase: 'pressed', id: 't', from: 'week', x: 0, y: 0 }, targets), null);
});

test('groupAt finds the group under the pointer', () => {
  const rects = [
    { key: 'overdue', top: 0, bottom: 100 },
    { key: 'week', top: 120, bottom: 300 },
  ] as const;
  assert.equal(groupAt(rects, 50), 'overdue');
  assert.equal(groupAt(rects, 100), null, 'the gap between groups');
  assert.equal(groupAt(rects, 120), 'week');
  assert.equal(groupAt(rects, 300), null);
  assert.equal(groupAt([], 10), null);
});

test('the date picker model: open on the first preset, Pick a date opens the month on tomorrow, the past is refused', () => {
  const today = '2026-10-29';
  const opened = pickerReducer(CLOSED, { type: 'open', id: 't', today, first: 'evening' });
  assert.deepEqual(
    [opened.open, opened.id, opened.activeId, opened.calendarOpen],
    [true, 't', 'evening', false],
  );
  assert.equal(
    pickerReducer(CLOSED, { type: 'active', entry: 'date', today }),
    CLOSED,
    'closed ignores it',
  );
  const toDate = pickerReducer(opened, { type: 'active', entry: 'date', today });
  assert.deepEqual(
    [toDate.activeId, toDate.calendarOpen, toDate.pickedDate, toDate.month],
    ['date', true, '2026-10-30', '2026-10'],
  );
  const back = pickerReducer(toDate, { type: 'active', entry: 'nextWeek', today });
  assert.equal(back.calendarOpen, false);
  const nextMonth = pickerReducer(toDate, { type: 'day', date: '2026-11-04' });
  const moved = pickerReducer(nextMonth, { type: 'month', month: '2026-11' });
  assert.equal(moved.month, '2026-11');
  const now = at(10, 29);
  assert.equal(pickedUntil(moved, now), new Date(2026, 10, 4, 8, 0).getTime(), 'default 8:00 AM');
  assert.equal(
    pickedUntil(pickerReducer(moved, { type: 'time', time: '16:30' }), now),
    new Date(2026, 10, 4, 16, 30).getTime(),
  );
  assert.equal(
    pickedUntil(pickerReducer(moved, { type: 'day', date: '2026-10-28' }), now),
    null,
    'in the past',
  );
  assert.equal(pickedUntil(opened, now), null, 'no day picked');
  assert.equal(pickerReducer(moved, { type: 'close' }), CLOSED);
  assert.equal(dayAfter('2026-12-31'), '2027-01-01');
});

test('while a row is lifted every target group is on screen, empty ones at 0, and Overdue only with rows', () => {
  const groups = groupsOf(['a', 'b'], [section('week', 0, 2)], 0);
  const zones = withDropZones(groups);
  assert.deepEqual(
    zones.map(group => group.key),
    ['today', 'week', 'someday'],
  );
  assert.deepEqual(
    zones.map(group => group.count),
    [0, 2, 0],
  );
  assert.ok(zones.filter(group => group.ids.length === 0).every(group => group.held));
  const withOverdue = withDropZones(groupsOf(['a'], [section('overdue', 0, 1)], 0));
  assert.deepEqual(
    withOverdue.map(group => group.key),
    ['overdue', 'today', 'week', 'someday'],
  );
});

test('guarded silences every verb while a row is lifted and passes them through otherwise', () => {
  const calls: string[] = [];
  let lifted = true;
  const actions = guarded(
    { done: () => calls.push('done'), openPicker: (key?: string) => calls.push(`picker:${key}`) },
    () => lifted,
  );
  actions.done();
  actions.openPicker('a');
  assert.deepEqual(calls, [], 'E on the cursor during a drag does nothing');
  lifted = false;
  actions.done();
  actions.openPicker('a');
  assert.deepEqual(calls, ['done', 'picker:a']);
});
