import test from 'node:test';
import assert from 'node:assert/strict';
import { clampSendAt, isFutureSendAt, schedulePresets } from './schedule';

const ids = (now: number) => schedulePresets(now).map(p => p.id);

test('on a Sunday next week would repeat tomorrow morning, so it is left out', () => {
  const sunday = new Date(2026, 9, 25, 10, 0);
  assert.equal(sunday.getDay(), 0);
  assert.deepEqual(ids(sunday.getTime()), ['inAnHour', 'tomorrowMorning', 'tomorrowAfternoon']);
});

test('on other days all four presets show, and no two share a moment', () => {
  const tuesday = new Date(2026, 9, 27, 9, 20).getTime();
  assert.deepEqual(ids(tuesday), ['inAnHour', 'tomorrowMorning', 'tomorrowAfternoon', 'nextWeek']);
  const moments = schedulePresets(tuesday).map(p => p.at);
  assert.equal(new Set(moments).size, moments.length);
});

test('a send time is in the future only when it is after now', () => {
  assert.equal(isFutureSendAt(1_001, 1_000), true);
  assert.equal(isFutureSendAt(1_000, 1_000), false);
  assert.equal(isFutureSendAt(999, 1_000), false);
});

test('a send time that is not in the future clamps to sending now', () => {
  assert.equal(clampSendAt(2_000, 1_000), 2_000);
  assert.equal(clampSendAt(1_000, 1_000), undefined);
  assert.equal(clampSendAt(500, 1_000), undefined);
});
