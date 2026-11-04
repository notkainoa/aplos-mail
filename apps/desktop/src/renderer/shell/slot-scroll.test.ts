/** The sidebar slot's scroll decisions: when the region overflows, and when the observer must be set up again. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { overflows, partsKey } from './slot-scroll';
import type { CalendarListProps, MiniMonthProps } from '../ui/props';

const MONTH = { month: '2026-10' } as MiniMonthProps;
const CALENDARS = { calendars: [] } as unknown as CalendarListProps;

test('overflows: only content taller than the region, past one pixel of rounding', () => {
  assert.equal(overflows({ scrollHeight: 300, clientHeight: 300 }), false);
  assert.equal(overflows({ scrollHeight: 301, clientHeight: 300 }), false);
  assert.equal(overflows({ scrollHeight: 302, clientHeight: 300 }), true);
  assert.equal(overflows({ scrollHeight: 0, clientHeight: 0 }), false);
});

test('partsKey changes when a part is added, dropped or the slot empties, not when a part only updates', () => {
  const month = partsKey({ miniMonth: MONTH });
  const both = partsKey({ miniMonth: MONTH, calendars: CALENDARS });
  const empty = partsKey({});
  assert.notEqual(month, both, 'calendars arriving after the month re-observes');
  assert.notEqual(both, empty, 'an emptied slot re-observes');
  assert.notEqual(partsKey({ calendars: CALENDARS }), month, 'month and calendars differ');
  assert.equal(partsKey({ miniMonth: { ...MONTH } }), month, 'new props, same parts: same key');
});
