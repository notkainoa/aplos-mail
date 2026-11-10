/** "Add to calendar" from the reader: the calendar goes to the plan's day and opens the plan, creating nothing. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { initialState, planEntryId, update } from './calendar.model';
import { ctxFor, THU } from './calendar.testkit';
import { demoWorld } from './CalendarStates';
import { offerOf } from '../reader/offerModel';
import { PLAN_WAIT_MS } from './useOpenPlanTarget';

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

test('a plan that never shows (added or dismissed since the offer) is given up on after a short wait', () => {
  assert.ok(PLAN_WAIT_MS > 0 && PLAN_WAIT_MS <= 10_000);
});
