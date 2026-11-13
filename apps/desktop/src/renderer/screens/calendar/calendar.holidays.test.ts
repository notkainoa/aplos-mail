import './calendar.tz';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { entriesFor, periodOf } from './calendar.model';
import { collapseAllDayDuplicates } from './model/entries';
import { calRef, newEvent } from './calendar.testkit';
import { demoWorld } from './CalendarStates';

const [first, second] = demoWorld.calendars;

test('the same all-day holiday from two calendars is one chip, a different day or title stays', () => {
  assert.ok(first && second);
  const veterans = (id: string, calendarId: string) => ({
    ...newEvent(id, calendarId),
    title: 'Veterans Day',
  });
  const period = periodOf('week', '2026-10-30', 0);
  const entries = entriesFor({
    events: [
      veterans('a', first.id),
      veterans('b', second.id),
      { ...newEvent('c', second.id), title: 'Veterans Day observed' },
    ],
    plans: [],
    calendars: [first, second],
    solo: null,
    period: { from: period.from, to: period.to },
    planCalendarId: first.id,
  });
  assert.deepEqual(
    entries.map(e => e.id),
    ['a', 'c'],
  );
});

test('a timed event, a plan and an all-day meeting with guests are never merged', () => {
  const chip = { ...calRef({ id: 'x', name: 'X' }) };
  const base = {
    title: 'Offsite',
    start: '2026-11-11T00:00:00',
    end: '2026-11-12T00:00:00',
    allDay: true,
    calendar: chip,
    kind: 'event',
  } as const;
  const guests = [{ name: 'Jordan', status: 'accepted' }] as never;
  const kept = collapseAllDayDuplicates([
    { ...base, id: '1', guests },
    { ...base, id: '2', guests },
    { ...base, id: '3', kind: 'plan' },
    { ...base, id: '4', kind: 'plan' },
  ] as never);
  assert.equal(kept.length, 4);
});

test('review23: a new all-day event that is not saved yet is never hidden behind an older twin', () => {
  const chip = calRef({ id: 'x', name: 'X' });
  const base = {
    title: 'Holiday',
    start: '2026-11-11T00:00:00',
    end: '2026-11-12T00:00:00',
    allDay: true,
    calendar: chip,
    kind: 'event',
  } as const;
  // The new entry sorts AFTER the saved one by id: it used to be the one collapsed away.
  const kept = collapseAllDayDuplicates([
    { ...base, id: 'a-saved', persisted: true },
    { ...base, id: 'new:1', persisted: false },
  ] as never);
  assert.deepEqual(
    kept.map(e => e.id),
    ['a-saved', 'new:1'],
  );
  // Two saved twins still collapse to one, and an unsaved entry never hides a saved one.
  const twins = collapseAllDayDuplicates([
    { ...base, id: 'b', persisted: false },
    { ...base, id: 'c', persisted: true },
    { ...base, id: 'd', persisted: true },
  ] as never);
  assert.deepEqual(
    twins.map(e => e.id),
    ['b', 'c'],
  );
});
