import assert from 'node:assert/strict';
import test from 'node:test';
import type { Event } from '@aplos/contract';
import { seriesPatches, shiftTime, wallOf } from '../src/series';

const NY = 'America/New_York';
const utc = (iso: string) => ({ type: 'utc' as const, utc: Date.parse(iso) });
const row = (id: string, start: string, end: string, extra: Partial<Event> = {}) =>
  ({
    id,
    rev: 3,
    accountId: 'a',
    calendarId: 'c',
    recurring: true,
    exception: false,
    title: 'Standup',
    start: utc(start),
    end: utc(end),
    allDay: false,
    attendees: [],
    ...extra,
  }) as unknown as Event;

// A weekly Tuesday 10:00-10:30 New York series; the clocks go back on 2026-11-01.
const master = row('s', '2026-10-27T14:00:00Z', '2026-10-27T14:30:00Z', { seriesId: undefined });
const nov3 = row('s@1', '2026-11-03T15:00:00Z', '2026-11-03T15:30:00Z', {
  seriesId: 's',
  originalStart: utc('2026-11-03T15:00:00Z'),
});
const other = row('x', '2026-11-03T15:00:00Z', '2026-11-03T15:30:00Z', { recurring: false });

test('a series write named by an occurrence shifts every row by the occurrence move, on the wall clock', () => {
  // The Nov 3 occurrence (10:00 EST) is dragged to Wed Nov 4 11:00 EST: +25 h on the wall clock.
  const patches = seriesPatches(
    [master, nov3, other],
    nov3,
    { start: utc('2026-11-04T16:00:00Z'), end: utc('2026-11-04T16:30:00Z') },
    NY,
  );
  assert.deepEqual(patches.map(p => p.row.id).sort(), ['s', 's@1']);
  const byId = Object.fromEntries(patches.map(p => [p.row.id, p]));
  assert.deepEqual(byId['s@1']!.fields.start, utc('2026-11-04T16:00:00Z'));
  // The master (Oct 27 10:00 EDT) lands on Wed Oct 28 11:00 EDT, not on the occurrence's own date.
  assert.deepEqual(byId['s']!.fields.start, utc('2026-10-28T15:00:00Z'));
  assert.deepEqual(byId['s']!.fields.end, utc('2026-10-28T15:30:00Z'));
  assert.deepEqual(byId['s@1']!.originalStart, utc('2026-11-04T16:00:00Z'));
});

test('the shift is wall-clock in the series zone: 10:00 across a DST change stays 10:00', () => {
  const oct28 = row('s@0', '2026-10-28T14:00:00Z', '2026-10-28T14:30:00Z', { seriesId: 's' });
  const week = seriesPatches(
    [master, oct28],
    oct28,
    { start: utc('2026-11-04T15:00:00Z'), end: utc('2026-11-04T15:30:00Z') },
    NY,
  ).find(p => p.row.id === 's@0')!;
  // Oct 28 10:00 EDT plus seven days is Nov 4 10:00 EST (15:00Z), one real hour later than +168 h.
  assert.deepEqual(week.fields.start, utc('2026-11-04T15:00:00Z'));
  assert.deepEqual(
    shiftTime(utc('2026-10-28T14:00:00Z'), 7 * 86_400_000, NY),
    utc('2026-11-04T15:00:00Z'),
  );
});

test('text fields copy to every row; a move of the start only does not touch the end', () => {
  const patches = seriesPatches([master, nov3], nov3, { title: 'Sync' }, NY);
  for (const p of patches) assert.deepEqual(p.fields, { title: 'Sync' });
  const startOnly = seriesPatches([master, nov3], nov3, { start: utc('2026-11-03T16:00:00Z') }, NY);
  for (const p of startOnly) {
    assert.equal(p.fields.end, undefined);
    assert.ok(p.fields.start);
  }
});

test('a master or single event with no series is its own series', () => {
  const alone = seriesPatches([master, other], other, { title: 'Solo' }, NY);
  assert.deepEqual(
    alone.map(p => p.row.id),
    ['x'],
  );
});

test('all-day and floating times shift by days and wall clock', () => {
  assert.deepEqual(shiftTime({ type: 'date', date: '2026-11-03' }, 86_400_000, NY), {
    type: 'date',
    date: '2026-11-04',
  });
  assert.deepEqual(shiftTime({ type: 'floating', local: '2026-11-03T10:00' }, 25 * 3_600_000, NY), {
    type: 'floating',
    local: '2026-11-04T11:00',
  });
  assert.equal(
    wallOf({ type: 'date', date: '2026-11-03' }, NY),
    Date.parse('2026-11-03T00:00:00Z'),
  );
});
