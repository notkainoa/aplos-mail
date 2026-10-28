import test from 'node:test';
import assert from 'node:assert/strict';
import { createGroq, localNow, messageWeek } from '../src/main/groq';
import type { Thread } from '@aplos/contract/legacy/types';

test('the clock Ask resolves relative dates with spells out weekdays and offsets', async () => {
  const now = new Date('2026-10-20T16:00:00Z');
  const clock = localNow('America/Los_Angeles', now);
  assert.deepEqual(
    { ...clock, upcoming: undefined },
    {
      now: '2026-10-20T09:00:00-07:00',
      weekday: 'Tuesday',
      timeZone: 'America/Los_Angeles',
      upcoming: undefined,
    },
  );
  assert.equal(clock.upcoming[2], 'Friday 2026-10-23 -07:00');
  const london = localNow('Europe/London', now);
  assert.equal(london.upcoming[3], 'Saturday 2026-10-24 +01:00');
  assert.equal(london.upcoming[6], 'Tuesday 2026-10-27 +00:00');
  assert.equal(clock.upcoming.length, 14);
  assert.equal(
    localNow('Not/AZone', now).timeZone,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
});

test('each message carries its own week, so "Friday" in a Monday email is a lookup in the reader\'s zone', () => {
  // Monday 10:00 in Los Angeles is already Monday 17:00 UTC; late Sunday there is Monday in UTC.
  const week = messageWeek('2026-10-19T17:00:00.000Z', 'America/Los_Angeles')!;
  assert.equal(week.sentOn, 'Monday 2026-10-19');
  assert.equal(week.following[0], 'Tuesday 2026-10-20');
  assert.equal(
    week.following.find(d => d.startsWith('Friday')),
    'Friday 2026-10-23',
  );
  assert.equal(
    messageWeek('2026-10-19T05:30:00.000Z', 'America/Los_Angeles')!.sentOn,
    'Sunday 2026-10-18',
  );
  assert.equal(messageWeek('2026-10-19T05:30:00.000Z', 'Asia/Tokyo')!.sentOn, 'Monday 2026-10-19');
  // Across the end of daylight saving the dates still step one calendar day at a time.
  assert.deepEqual(
    messageWeek('2026-10-31T18:00:00.000Z', 'America/New_York')!.following.slice(0, 3),
    ['Sunday 2026-11-01', 'Monday 2026-11-02', 'Tuesday 2026-11-03'],
  );
  assert.equal(messageWeek('not a date'), undefined);
});
