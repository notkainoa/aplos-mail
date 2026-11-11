/**
 * The review10 tests: three rare engine codes get plain sentences and no Retry (a re-created event, a series
 * time change on a wall-clock time with no zone, and the unsupported "this and following"), and every one
 * rolls the overlay back. Run: `cd apps/desktop && npx tsx --test 'src/renderer/screens/calendar/*.test.ts*'`.
 */
import './calendar.tz';
import test from 'node:test';
import assert from 'node:assert/strict';
import { OperationFailedError } from '../../data';
import { getToasts, resetToasts } from '../../shell/store-toast';
import type { CalendarEffect } from './calendar.model';
import { runCalendarEffect, type EffectPorts } from './effects';
import { ports, testUi } from './calendar.testkit';

const nextTick = () => new Promise<void>(resolve => setImmediate(resolve));
const failedToast = () => [...getToasts()].reverse().find(t => t.id.endsWith(':failed'));

const reject = (type: string, reasonCode: string): EffectPorts => ({
  ...ports(),
  eventSet: () =>
    Promise.reject(new OperationFailedError('op-x', { type, message: 'engine words', reasonCode })),
});

const moveFx: CalendarEffect = {
  kind: 'eventSet',
  change: { type: 'update', id: 'dental', scope: 'series', fields: { title: 'Cleaning' } },
  optimistic: { id: 'dental', patch: { title: 'Cleaning' } },
  toast: { kind: 'info', message: 'Changed Cleaning', held: 'Changing Cleaning', undoable: true },
  undoLabel: 'Changed Cleaning',
  failure: 'Couldn’t change Northwind Dental.',
  accountId: 'acct-alex',
};

const cases: readonly (readonly [string, string, string])[] = [
  ['conflict', 'calendar.opReused', 'That event was deleted. Create it again as a new event.'],
  [
    'unsupported',
    'calendar.floatingSeries',
    'This repeating event runs in another time zone. Change it in Google Calendar, or edit one occurrence.',
  ],
  [
    'unsupported',
    'event.followingUnsupported',
    "Changing this and all following events isn't available. Change this event, or every event.",
  ],
];

for (const [type, reasonCode, sentence] of cases) {
  test(`review10: ${reasonCode} says its plain sentence, offers no Retry, rolls the overlay back`, async () => {
    resetToasts();
    try {
      const ui = testUi();
      runCalendarEffect(moveFx, reject(type, reasonCode), ui);
      await nextTick();
      const toast = failedToast();
      assert.equal(toast?.message, sentence);
      assert.equal(toast?.actions, undefined, 'a refusal that cannot change offers no Retry');
      assert.deepEqual(ui.dropped, ['dental']);
    } finally {
      resetToasts();
    }
  });
}
