// The zone is process-wide, so this file sets it before any Date is made and holds only half-hour-zone cases.
process.env.TZ = 'Asia/Kolkata';

import test from 'node:test';
import assert from 'node:assert/strict';
import { schedulePresets } from './schedule';

function inAnHourAt(h: number, m: number): Date {
  const now = new Date(2026, 9, 27, h, m).getTime();
  return new Date(schedulePresets(now)[0]!.at);
}

test('the zone is a half-hour zone', () => {
  assert.equal(new Date(2026, 9, 27, 9, 0).getTimezoneOffset(), -330);
});

test('"in an hour" is a whole local hour at least 60 minutes away, not :30', () => {
  const cases: readonly (readonly [number, number, number, number])[] = [
    [9, 20, 11, 0],
    [9, 0, 10, 0],
    [9, 59, 11, 0],
    [23, 30, 1, 0],
  ];
  for (const [h, m, wantHour] of cases) {
    const at = inAnHourAt(h, m);
    assert.equal(at.getMinutes(), 0, `${h}:${m}`);
    assert.equal(at.getHours(), wantHour, `${h}:${m}`);
  }
});
