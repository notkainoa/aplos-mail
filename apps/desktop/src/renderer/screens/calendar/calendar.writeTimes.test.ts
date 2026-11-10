/**
 * Write shapes (item 3): create and update fields match the providers' 2026-11-10 contract — timed
 * creates send `utc` instants, a create on a zoned calendar sends `floating` times that name their zone
 * (plus `fields.timeZone`), all-day `date` ends are exclusive, switching allDay sends start and end
 * together, and an update carries only the changed fields. A zone-less floating event keeps its wall
 * clock and gains a zone on write, so `event.timeZoneRequired` can never fire.
 * Run: `cd apps/desktop && npx tsx --test 'src/renderer/screens/calendar/*.test.ts*'`.
 */
import './calendar.tz';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Event } from '../../data';
import {
  draftChange,
  draftFromEvent,
  localZone,
  newDraft,
  patchDraft,
  timeChange,
} from './calendar.model';
import { NOW, THU } from './calendar.testkit';
import { demoWorld } from './CalendarStates';

const dental = () => demoWorld.events.find(e => e.id === 'dental')!;

test('writeTimes: a timed create sends utc instants', () => {
  const draft = { ...newDraft(THU, NOW, [], 'work'), title: 'Focus' };
  const change = draftChange(draft, undefined, 'occurrence');
  assert.ok(change && change.type === 'create');
  if (change.type === 'create') {
    assert.equal(change.fields.start.type, 'utc');
    assert.equal(change.fields.end.type, 'utc');
    assert.equal(change.fields.allDay, false);
    assert.equal(change.fields.timeZone, undefined);
  }
});

test('writeTimes: a create on a zoned calendar sends floating times that name the zone', () => {
  const draft = { ...newDraft(THU, NOW, [], 'work'), title: 'Focus' };
  const change = draftChange(draft, undefined, 'occurrence', 'America/New_York');
  assert.ok(change && change.type === 'create');
  if (change.type === 'create') {
    assert.equal(change.fields.start.type, 'floating');
    assert.equal(change.fields.end.type, 'floating');
    if (change.fields.start.type === 'floating')
      assert.equal(change.fields.start.timeZone, 'America/New_York');
    assert.equal(change.fields.timeZone, 'America/New_York');
  }
});

test('writeTimes: an all-day create writes date times with an exclusive end', () => {
  const one = { ...newDraft(THU, NOW, [], 'work'), title: 'Fair', allDay: true };
  const change = draftChange(one, undefined, 'occurrence');
  assert.ok(change && change.type === 'create');
  if (change.type === 'create') {
    assert.deepEqual(change.fields.start, { type: 'date', date: '2026-10-29' });
    // End exclusive: a one-day event ends the next day.
    assert.deepEqual(change.fields.end, { type: 'date', date: '2026-10-30' });
    assert.equal(change.fields.allDay, true);
  }
  // A three-day event ends the day after its last day.
  const three = { ...one, endDate: '2026-10-31' as const };
  const multi = draftChange(three, undefined, 'occurrence');
  if (multi?.type === 'create')
    assert.deepEqual(multi.fields.end, { type: 'date', date: '2026-11-01' });
});

test('writeTimes: switching allDay sends start and end together', () => {
  const draft = { ...draftFromEvent(dental()), allDay: true };
  const change = draftChange(draft, dental(), 'occurrence');
  assert.ok(change && change.type === 'update');
  if (change.type === 'update') {
    assert.equal(change.fields.allDay, true);
    assert.ok(change.fields.start, 'start goes with the allDay switch');
    assert.ok(change.fields.end, 'end goes with the allDay switch');
    assert.equal(change.fields.start?.type, 'date');
    assert.equal(change.fields.end?.type, 'date');
  }
});

test('writeTimes: an update sends only the changed fields', () => {
  const titled = patchDraft(draftFromEvent(dental()), { title: 'Cleaning' });
  const change = draftChange(titled, dental(), 'occurrence');
  assert.ok(change && change.type === 'update');
  if (change.type === 'update') assert.deepEqual(change.fields, { title: 'Cleaning' });
  // A pure time move writes times and nothing else.
  const moved = patchDraft(draftFromEvent(dental()), { start: '11:00' });
  const times = draftChange(moved, dental(), 'occurrence');
  assert.ok(times && times.type === 'update');
  if (times.type === 'update') {
    assert.equal(times.fields.title, undefined);
    assert.ok(times.fields.start);
    assert.ok(times.fields.end);
    assert.equal(times.fields.allDay, undefined);
  }
});

test('writeTimes: a zone-less floating event keeps its wall clock and gains a zone on write', () => {
  const floating: Event = {
    ...dental(),
    start: { type: 'floating', local: '2026-10-29T09:30' },
    end: { type: 'floating', local: '2026-10-29T10:30' },
    timeZone: undefined,
  };
  const moved = draftChange(
    patchDraft(draftFromEvent(floating), { start: '11:00' }),
    floating,
    'occurrence',
  );
  assert.ok(moved && moved.type === 'update');
  if (moved.type === 'update') {
    assert.equal(moved.fields.start?.type, 'floating');
    if (moved.fields.start?.type === 'floating')
      assert.equal(moved.fields.start.timeZone, localZone());
  }
  // The series/event zone wins over the machine's when the event carries one.
  const zoned: Event = { ...floating, timeZone: 'America/New_York' };
  const target = timeChange(zoned, {
    start: { type: 'floating', local: '2026-10-29T11:00' },
    end: zoned.end,
  });
  assert.equal(target.fields.start?.type, 'floating');
  if (target.fields.start?.type === 'floating')
    assert.equal(target.fields.start.timeZone, 'America/New_York');
});
