import assert from 'node:assert/strict';
import { test } from 'node:test';
import { consumeCalendarTarget, getCalendarTarget, openCalendarOnPlan } from './store-calendar';
import { getScreen, setScreen } from './store-route';

test('opening a plan shows the Calendar and leaves a request that only its own seq clears', () => {
  setScreen('home');
  openCalendarOnPlan({ planId: 'a:plan-1', date: '2026-11-12' });
  assert.equal(getScreen(), 'calendar');
  const first = getCalendarTarget();
  assert.equal(first?.planId, 'a:plan-1');
  assert.equal(first?.date, '2026-11-12');
  assert.ok(Math.abs(Date.now() - (first?.at ?? 0)) < 5_000, 'stamped when asked');
  openCalendarOnPlan({ planId: 'a:plan-1', date: '2026-11-12' });
  const second = getCalendarTarget();
  assert.notEqual(second?.seq, first?.seq, 'asking twice still fires');
  consumeCalendarTarget(first!.seq);
  assert.ok(getCalendarTarget(), 'a stale seq does not clear the newer request');
  consumeCalendarTarget(second!.seq);
  assert.equal(getCalendarTarget(), null);
});
