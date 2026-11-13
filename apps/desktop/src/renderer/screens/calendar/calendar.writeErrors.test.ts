/**
 * The writeErrors table end to end: a refused `Event/set` or `Event/rsvp` reaches the failure toast with
 * the reasonCode's plain sentence and behaviour (DESIGN 7.15, 10; the providers' 2026-11-10 shapes). One
 * test per code: the copy, whether Retry is offered (never for `uncertain`, `conflict`, `forbidden`,
 * `eventGone`, `rejected`, `notAGuest`), the conflict's editor re-open and the gone event's closed detail.
 * Failures are stub ports rejecting like the data layer does (`OperationFailedError`) plus one run through
 * the real stand-in's `failures` knob to prove the code arrives on `body.reasonCode`.
 * Run: `cd apps/desktop && npx tsx --test 'src/renderer/screens/calendar/*.test.ts*'`.
 */
import './calendar.tz';
import test from 'node:test';
import assert from 'node:assert/strict';
import { api, OperationFailedError } from '../../data';
import { getToasts, resetToasts, runToastAction } from '../../shell/store-toast';
import { draftFromEvent, update, type CalendarEffect } from './calendar.model';
import { runCalendarEffect, type EffectPorts } from './effects';
import { boot, calRef, ctxFor, ports, S, testUi } from './calendar.testkit';

const reject = (type: string, reasonCode: string, retryAfterMs?: number): EffectPorts => ({
  ...ports(),
  eventSet: () =>
    Promise.reject(
      new OperationFailedError('op-x', {
        type,
        message: 'engine words',
        reasonCode,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      }),
    ),
});

const moveFx: CalendarEffect = {
  kind: 'eventSet',
  change: {
    type: 'update',
    id: 'dental',
    scope: 'occurrence',
    fields: { title: 'Moved cleaning' },
  },
  optimistic: { id: 'dental', patch: { title: 'Moved cleaning' } },
  toast: {
    kind: 'info' as const,
    message: 'Changed Moved cleaning',
    held: 'Changing Moved cleaning',
    undoable: true,
  },
  undoLabel: 'Changed Moved cleaning',
  failure: 'Couldn’t change Northwind Dental.',
};

async function failedWrite(p: EffectPorts, fx = moveFx) {
  const ui = testUi();
  runCalendarEffect(fx, p, ui);
  await new Promise(resolve => setImmediate(resolve));
  return ui;
}

const lastToast = () => getToasts()[getToasts().length - 1];

test('writeErrors: each reasonCode maps to its sentence and Retry decision', async () => {
  const cases: ReadonlyArray<readonly [string, string, boolean]> = [
    ['calendar.conflict', "This event changed somewhere else. Your changes weren't saved.", false],
    [
      'calendar.uncertain',
      "We couldn't confirm that went through. Check your calendar before trying again.",
      false,
    ],
    ['calendar.eventGone', 'That event is no longer on your calendar.', false],
    ['calendar.forbidden', 'Only the organizer can change this event.', false],
    ['calendar.rejected', "Google Calendar didn't accept that change.", false],
    // Nothing was accepted, so the retry re-runs the write — safe (review16).
    [
      'calendar.holdPending',
      "Your earlier change to this event hasn't been sent yet. Undo it, or try again once it has.",
      true,
    ],
    // `calendar.late` means the OPERATION missed its window — a submit-time refusal accepted
    // nothing, so the sentence stands alone (review16: only an operation-level late retries).
    [
      'calendar.late',
      "That change wasn't sent in time. Check the event, then send it again.",
      false,
    ],
    ['event.notAGuest', "You aren't on this event's guest list, so you can't reply.", false],
    ['event.timeZoneRequired', 'That event needs a time zone.', false],
  ];
  for (const [reasonCode, message, retry] of cases) {
    resetToasts();
    try {
      const ui = await failedWrite(reject('conflict', reasonCode));
      const toast = lastToast();
      assert.equal(toast?.message, message, reasonCode);
      assert.equal(
        toast?.kind,
        'error',
        `${reasonCode}: a refusal wears the alert, with a close button`,
      );
      assert.ok(!toast?.actions?.some(a => a.id === 'dismiss'), 'one close control, not two');
      assert.equal(toast?.actions?.some(a => a.id === 'retry') ?? false, retry, reasonCode);
      // Rollback is unchanged: the optimistic overlay drops whatever the code.
      assert.deepEqual(ui.dropped, ['dental'], reasonCode);
    } finally {
      resetToasts();
    }
  }
});

test('writeErrors: an unknown code keeps the write’s own sentence and offers Retry', async () => {
  resetToasts();
  try {
    await failedWrite(reject('unavailable', 'calendar.mystery'));
    assert.equal(lastToast()?.message, 'Couldn’t change Northwind Dental.');
    assert.ok(lastToast()?.actions?.some(a => a.id === 'retry'));
  } finally {
    resetToasts();
  }
});

test('writeErrors: calendar.unavailable says nothing changed and retries', async () => {
  resetToasts();
  try {
    await failedWrite(reject('unavailable', 'calendar.unavailable'));
    const toast = lastToast();
    assert.equal(toast?.message, "Couldn't reach Google Calendar. Nothing changed.");
    assert.ok(toast?.actions?.some(a => a.id === 'retry'));
  } finally {
    resetToasts();
  }
});

test('writeErrors: calendar.unavailable with retryAfterMs arms the retry with the notice', async () => {
  resetToasts();
  const real = global.setTimeout;
  const delays: number[] = [];
  // @ts-expect-error test shim records the delay without waiting
  global.setTimeout = (fn: () => void, ms?: number) => {
    delays.push(ms ?? 0);
    return 0;
  };
  try {
    let calls = 0;
    await failedWrite({
      ...ports(),
      eventSet: () => {
        calls += 1;
        return calls === 1
          ? Promise.reject(
              new OperationFailedError('op-x', {
                type: 'unavailable',
                message: 'engine words',
                reasonCode: 'calendar.unavailable',
                retryAfterMs: 2_000,
              }),
            )
          : Promise.resolve({ receipt: { opId: 'op-2', appliedState: { dbEpoch: 'e', seq: 9 } } });
      },
    });
    const toast = lastToast();
    assert.equal(toast?.message, "Couldn't reach Google Calendar. Nothing changed.");
    // The write retries itself after retryAfterMs; Retry goes at once instead (review7 9).
    assert.deepEqual(delays, [2_000]);
    assert.equal(calls, 1, 'the write still waits out retryAfterMs');
    runToastAction(toast!.id, 'retry');
    assert.equal(calls, 2, 'Retry runs the write at once');
  } finally {
    global.setTimeout = real;
    resetToasts();
  }
});

test('writeErrors: calendar.uncertain never offers Retry', async () => {
  resetToasts();
  try {
    await failedWrite(reject('unavailable', 'calendar.uncertain'));
    const toast = lastToast();
    assert.equal(
      toast?.message,
      "We couldn't confirm that went through. Check your calendar before trying again.",
    );
    assert.equal(toast?.actions, undefined);
  } finally {
    resetToasts();
  }
});

test('writeErrors: calendar.conflict on an editor save re-opens the editor on the newer copy', async () => {
  resetToasts();
  try {
    const save = update(
      S({ editor: { ...draftFromEvent(ctxFor().events.get('dental')!), title: 'Cleaning' } }),
      { type: 'editorSave' },
      ctxFor(),
    );
    const fx = save.effects.find(f => f.kind === 'eventSet');
    assert.ok(fx && fx.kind === 'eventSet');
    assert.equal(fx.reopenEditorId, 'dental');
    const ui = await failedWrite(reject('conflict', 'calendar.conflict'), fx);
    assert.deepEqual(ui.reopened, [
      { id: 'dental', note: "This event changed somewhere else. Your changes weren't saved." },
    ]);
    assert.equal(ui.closed, 0);
    // A move's conflict has no editor to re-open: the notice alone.
    const plain = await failedWrite(reject('conflict', 'calendar.conflict'));
    assert.equal(plain.reopened.length, 0);
  } finally {
    resetToasts();
  }
});

test('writeErrors: calendar.eventGone drops the overlay and closes the detail', async () => {
  resetToasts();
  try {
    const ui = await failedWrite(reject('notFound', 'calendar.eventGone'));
    assert.deepEqual(ui.dropped, ['dental']);
    assert.equal(ui.closed, 1);
  } finally {
    resetToasts();
  }
});

test('writeErrors: a refuse through the real stand-in carries reasonCode on the error body', async () => {
  const { flush, engine } = await boot();
  resetToasts();
  try {
    const calendarId = (await api.calendar.get({})).list[0].id;
    engine.fixture.failures.push({
      mode: 'reject',
      type: 'unavailable',
      message: 'engine words',
      reasonCode: 'calendar.uncertain',
      afterMs: 0,
    });
    const ui = testUi();
    runCalendarEffect(
      {
        kind: 'eventSet',
        change: {
          type: 'create',
          calendarId,
          fields: {
            title: 'Focus',
            start: { type: 'utc', utc: 1_762_000_000_000 },
            end: { type: 'utc', utc: 1_762_003_600_000 },
            allDay: false,
          },
        },
        optimistic: {
          id: 'tmp-focus',
          add: {
            id: 'tmp-focus',
            title: 'Focus',
            start: '',
            end: '',
            calendar: calRef({ id: calendarId, name: 'Work' }),
            kind: 'event',
            persisted: false,
          },
        },
        toast: { kind: 'info', message: 'Added Focus', held: 'Adding Focus', undoable: true },
        undoLabel: 'Added Focus',
        failure: 'Couldn’t add Focus.',
      },
      ports(),
      ui,
    );
    await flush();
    const toast = lastToast();
    assert.equal(
      toast?.message,
      "We couldn't confirm that went through. Check your calendar before trying again.",
    );
    assert.equal(toast?.actions, undefined);
    assert.deepEqual(ui.dropped, ['tmp-focus']);
  } finally {
    resetToasts();
  }
});
