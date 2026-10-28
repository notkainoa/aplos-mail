import test from 'node:test';
import assert from 'node:assert/strict';
import { dateLabel } from '../src/renderer/legacy/dateLabel';

const now = new Date(2026, 9, 20, 15, 30); // Tuesday
const iso = (y: number, m: number, d: number, h = 10, min = 0) =>
  new Date(y, m - 1, d, h, min).toISOString();
const time = (s: string) =>
  new Date(s).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const weekday = (s: string) => new Date(s).toLocaleDateString([], { weekday: 'long' });

test('recent mail reads as today, yesterday or a weekday; older mail as a date', () => {
  const today = iso(2026, 10, 20, 8, 5),
    yesterday = iso(2026, 10, 19, 16, 12),
    friday = iso(2026, 10, 16),
    weekAgo = iso(2026, 10, 13),
    lastYear = iso(2025, 10, 14);
  assert.equal(dateLabel(today, false, now), time(today));
  assert.equal(dateLabel(today, true, now), time(today));
  assert.equal(dateLabel(yesterday, false, now), 'Yesterday');
  assert.equal(dateLabel(yesterday, true, now), 'Yesterday ' + time(yesterday));
  assert.equal(dateLabel(friday, false, now), weekday(friday));
  assert.equal(dateLabel(friday, true, now), weekday(friday) + ' ' + time(friday));
  // Seven days back shares today's weekday, so it falls back to the date.
  assert.equal(
    dateLabel(weekAgo, false, now),
    new Date(weekAgo).toLocaleDateString([], { month: 'short', day: 'numeric' }),
  );
  assert.match(dateLabel(lastYear, false, now), /2025/);
  assert.equal(dateLabel(iso(2026, 10, 21, 9), false, now), 'Tomorrow');
  assert.equal(dateLabel('not a date', false, now), '');
});
