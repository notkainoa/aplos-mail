import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays,
  localInput,
  moveStart,
  parseGuests,
  setAllDay,
  slotOn,
  timeRange,
} from '../src/renderer/legacy/calendarTime';

const at = (y: number, m: number, d: number, h = 0, min = 0) =>
  new Date(y, m - 1, d, h, min).toISOString();

test('event editing keeps duration, converts all-day spans and cleans guest lists', () => {
  const meeting = { start: at(2026, 10, 16, 14), end: at(2026, 10, 16, 15, 30), allDay: false };
  const moved = moveStart(meeting, '2026-10-17T09:00');
  assert.equal(localInput(moved.start), '2026-10-17T09:00');
  assert.equal(localInput(moved.end), '2026-10-17T10:30');

  // A timed event becomes a one-day all-day event with an exclusive end, and back again.
  const allDay = setAllDay(meeting, true);
  assert.deepEqual([allDay.start, allDay.end], ['2026-10-16', '2026-10-17']);
  assert.equal(timeRange(allDay), 'All day');
  const timed = setAllDay(allDay, false, new Date(2026, 9, 1));
  assert.equal(localInput(timed.start), '2026-10-16T10:00');
  assert.equal(+new Date(timed.end) - +new Date(timed.start), 3600000);

  // Ending at midnight belongs to the previous day; multi-day all-day spans move as a block.
  assert.deepEqual(
    setAllDay({ start: at(2026, 10, 16, 22), end: at(2026, 10, 17), allDay: false }, true).end,
    '2026-10-17',
  );
  const trip = moveStart({ start: '2026-10-16', end: '2026-10-19', allDay: true }, '2026-10-20');
  assert.deepEqual([trip.start, trip.end], ['2026-10-20', '2026-10-23']);
  assert.match(timeRange(trip), /^All day · until /);
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');

  // New events land on the chosen day: 10 AM on other days, the next whole hour today.
  assert.equal(
    localInput(slotOn(new Date(2026, 9, 20), new Date(2026, 9, 15, 13, 20)).start),
    '2026-10-20T10:00',
  );
  assert.equal(
    localInput(slotOn(new Date(2026, 9, 15), new Date(2026, 9, 15, 13, 20)).start),
    '2026-10-15T14:00',
  );

  assert.deepEqual(parseGuests('theo@studio.example, , sam;  ada@ex.org'), {
    guests: ['theo@studio.example', 'sam', 'ada@ex.org'],
    invalid: ['sam'],
  });
});
