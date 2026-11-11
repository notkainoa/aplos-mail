/** "Add to calendar" from the reader: the calendar goes to the plan's day and opens the plan, creating nothing. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { initialState, planEntryId, update } from './calendar.model';
import { ctxFor, THU } from './calendar.testkit';
import { demoWorld } from './CalendarStates';
import { offerOf } from '../reader/offerModel';
import { PLAN_WAIT_MS } from './useOpenPlanTarget';
import { isoOfTime } from './model/period';
import { dayOf, longDay } from '../../ui/calendar/dates';

test("picking the offer's day then opening its entry opens the plan detail; no effect writes anything", () => {
  const plan = demoWorld.plans.find(p => p.id === 'launch')!;
  const { date } = offerOf(plan, 's');
  const start = initialState(THU);
  const picked = update(start, { type: 'pick', date: date as never }, ctxFor());
  assert.equal(picked.state.anchor, date, "the calendar moved to the plan's day");
  const opened = update(picked.state, { type: 'open', id: planEntryId(plan.id) }, ctxFor());
  assert.equal(opened.state.detailId, planEntryId(plan.id));
  assert.deepEqual(
    [...picked.effects, ...opened.effects].filter(e =>
      /confirm|calendarSet|planConfirm/.test(e.kind),
    ),
    [],
    "opening a plan confirms nothing: Add to calendar stays the owner's press",
  );
});

test('the offer names the day the calendar draws, for a floating plan in another time zone', () => {
  // 00:30 on the 12th in Tokyo is the 11th on the US West Coast: the grid entry and the offer must agree.
  const plan = {
    ...demoWorld.plans[0]!,
    start: { type: 'floating', local: '2026-11-12T00:30:00', timeZone: 'Asia/Tokyo' },
    end: { type: 'floating', local: '2026-11-12T01:30:00', timeZone: 'Asia/Tokyo' },
  } as const;
  const offer = offerOf(plan as never, 's');
  const moment = new Date(Date.UTC(2026, 10, 11, 15, 30)); // 00:30 on the 12th in Tokyo, whatever this machine's zone is
  const local = `${moment.getFullYear()}-${String(moment.getMonth() + 1).padStart(2, '0')}-${String(moment.getDate()).padStart(2, '0')}`;
  assert.equal(offer.date, local, "the day the grid draws it on, in this machine's zone");
  assert.equal(offer.date, dayOf(isoOfTime(plan.start as never)));
  assert.ok(
    offer.when.startsWith(longDay(offer.date as never)),
    'and the when line names that day',
  );
});

test('a plan that never shows is given up on after a short wait', () => {
  assert.ok(PLAN_WAIT_MS >= 1_000 && PLAN_WAIT_MS <= 10_000);
});
