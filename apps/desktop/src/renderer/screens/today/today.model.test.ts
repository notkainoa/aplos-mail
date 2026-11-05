/**
 * The Today tab's pure decisions: which events belong, the next-plus-two rule, the fold, the gaps and the empty
 * state. Run: `cd apps/desktop && npx tsx --test 'src/renderer/screens/today/**\/*.test.ts*'`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Event } from '../../data';
import {
  calendarColor,
  formatWhen,
  instant,
  todayModel,
  MIN_GAP_MINUTES,
  type TodayCalendar,
} from './today.model';

const at = (h: number, m = 0) => new Date(2026, 9, 29, h, m).getTime();
const NOW = at(10);
const calendars = new Map<string, TodayCalendar>([
  ['work', { id: 'work', name: 'Work', color: 'hill' }],
]);

let seq = 0;
function event(title: string, start: number, end: number, extra: Partial<Event> = {}): Event {
  seq += 1;
  return {
    id: `e${seq}`,
    rev: 1,
    accountId: 'acc',
    calendarId: 'work',
    recurring: false,
    exception: false,
    title,
    start: { type: 'utc', utc: start },
    end: { type: 'utc', utc: end },
    allDay: false,
    attendees: [],
    status: 'confirmed',
    can: { edit: true, move: true, delete: true, rsvp: false, editGuests: true },
    sync: 'synced',
    ...extra,
  };
}

test('next event plus the following two; the rest fold into "N more"', () => {
  const model = todayModel(
    [
      event('one', at(11), at(11, 30)),
      event('two', at(12), at(13)),
      event('three', at(14), at(15)),
      event('four', at(16), at(17)),
    ],
    calendars,
    NOW,
  );
  assert.equal(model.next?.event.title, 'one');
  assert.deepEqual(
    model.following.map(e => e.event.title),
    ['two', 'three'],
  );
  assert.equal(model.moreText, '1 more');
  assert.equal(model.headline, '4 left today · next at 11:00 AM');
});

test('declined, cancelled, hidden and free events neither show nor block a gap', () => {
  const model = todayModel(
    [
      event('declined', at(11), at(12), { myResponse: 'declined' }),
      event('cancelled', at(12), at(13), { status: 'cancelled' }),
      event('hidden', at(13), at(14), { hidden: true }),
      event('free', at(14), at(15), { transparency: 'transparent' }),
      event('real', at(15), at(16)),
    ],
    calendars,
    NOW,
  );
  assert.deepEqual(
    model.events.map(e => e.title),
    ['real'],
  );
});

test('a gap of at least 30 minutes between now and the next event is a Free line', () => {
  const model = todayModel([event('later', at(13), at(14))], calendars, NOW);
  assert.equal(model.gaps.length, 1);
  assert.equal(model.gaps[0].minutes, 180);
  assert.equal(model.gaps[0].text, 'Free for 3 h');
  assert.ok(MIN_GAP_MINUTES >= 30);
});

test('a finished event only counts as earlier, a running event is current, an empty day is a real empty state', () => {
  const model = todayModel(
    [event('early', at(8), at(9)), event('now', at(9, 30), at(10, 30))],
    calendars,
    NOW,
  );
  assert.equal(model.earlier, 1);
  assert.equal(model.current[0]?.event.title, 'now');
  assert.equal(todayModel([], calendars, NOW).empty, true);
});

test('every finished event counts as earlier, however they overlapped', () => {
  const model = todayModel(
    [event('long', at(8), at(9, 50)), event('short', at(9), at(9, 10))],
    calendars,
    NOW,
  );
  assert.equal(model.earlier, 2);
});

test('three finished and two left says "2 left today"; a singular earlier keeps one count', () => {
  const model = todayModel(
    [
      event('one', at(7), at(8)),
      event('two', at(8), at(9)),
      event('three', at(9), at(9, 30)),
      event('four', at(11), at(12)),
      event('five', at(13), at(14)),
    ],
    calendars,
    NOW,
  );
  assert.equal(model.earlier, 3);
  assert.equal(model.headline, '2 left today · next at 11:00 AM');
  assert.equal(
    todayModel([event('one', at(7), at(8)), event('two', at(11), at(12))], calendars, NOW).earlier,
    1,
  );
});

test('a day where everything ended says "Nothing left today"', () => {
  const model = todayModel([event('over', at(8), at(9))], calendars, NOW);
  assert.equal(model.earlier, 1);
  assert.equal(model.headline, 'Nothing left today');
});

test('instant reads utc, date and floating times; formatWhen merges the meridiem', () => {
  assert.equal(instant({ type: 'utc', utc: NOW }), NOW);
  assert.equal(instant({ type: 'date', date: '2026-10-29' }), at(0));
  assert.equal(formatWhen(at(14), at(14, 30), false), 'Thu 2:00–2:30 PM');
  assert.equal(formatWhen(at(0), at(24), true), 'Thu, Oct 29 · All day');
  assert.equal(calendarColor({ id: 'work', colorTag: 'ember' }), 'ember');
});
