/** The sidebar slot's scroll decisions: when the region overflows, and when the observer must be set up again. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { moreBelow, overflows, partsKey } from './slot-scroll';
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

test('moreBelow: only while the region scrolls and its bottom is not yet in view', () => {
  const at = (scrollTop: number) => ({ scrollHeight: 400, clientHeight: 266, scrollTop });
  assert.equal(moreBelow(at(0)), true);
  assert.equal(moreBelow(at(100)), true);
  assert.equal(moreBelow(at(133)), false, 'scrolled to the end, within one pixel');
  assert.equal(moreBelow({ scrollHeight: 200, clientHeight: 266, scrollTop: 0 }), false);
});
