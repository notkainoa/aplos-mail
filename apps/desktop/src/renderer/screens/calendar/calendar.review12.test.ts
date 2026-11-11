/**
 * The review12 tests (held writes, providers' 2026-11-11 NOTICE): `calendar.late` is an
 * operation-level failure — its Retry is the operation's own `Operation/retry`, never a re-run —
 * and `calendar.holdPending` is a submit-time conflict that accepts nothing, so it gets the plain
 * Retry and never the stale-copy editor re-open that `calendar.conflict` owns.
 * Run: `cd apps/desktop && npx tsx --test 'src/renderer/screens/calendar/*.test.ts*'`.
 */
import './calendar.tz';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ErrorBody } from '../../data';
import { getToasts, resetToasts, runToastAction } from '../../shell/store-toast';
import type { CalendarEffect } from './calendar.model';
import { runCalendarEffect, type EffectPorts } from './effects';
import { writeFailureOf } from './writeErrors';
import { ports, testUi } from './calendar.testkit';

const save: CalendarEffect = {
  kind: 'eventSet',
  change: { type: 'update', id: 'design', scope: 'occurrence', fields: { title: 'Renamed' } },
  optimistic: { id: 'design', patch: { title: 'Renamed' } },
  toast: { kind: 'info', message: 'Changed Renamed', held: 'Changing Renamed', undoable: true },
  undoLabel: 'Changed Renamed',
  failure: 'Couldn’t change Renamed.',
  // An editor save's event: this is what `calendar.conflict` would re-open the editor on.
  reopenEditorId: 'design',
};

test('review12: calendar.late is an operation-level retry, never a re-run', () => {
  const body: ErrorBody = {
    type: 'unavailable',
    message: 'This change was not sent in time.',
    reasonCode: 'calendar.late',
  };
  const f = writeFailureOf(body, 'Couldn’t move Standup.');
  assert.equal(f.message, "This change wasn't sent in time. Check the event, then try again.");
  assert.equal(f.retry, 'none', 'no re-run at submit time — a fresh write would be late too');
  assert.equal(f.opRetry, true, 'the operation watcher’s Retry is Operation/retry');
});

test('review12: a bare operation error body maps through the same table', () => {
  // The watcher hands `view.error` — an ErrorBody itself, not wrapped — and the reasonCode must
  // survive (an OperationFailedError carries `.error`, a ContractError `.body`, this neither).
  const f = writeFailureOf(
    { type: 'unavailable', message: 'x', reasonCode: 'calendar.uncertain' } as ErrorBody,
    'Couldn’t move Standup.',
  );
  assert.equal(
    f.message,
    "We couldn't confirm that went through. Check your calendar before trying again.",
  );
});

test('review12: calendar.holdPending gets the earlier-change sentence and a safe Retry', () => {
  const f = writeFailureOf(
    { type: 'conflict', message: 'held', reasonCode: 'calendar.holdPending' },
    'Couldn’t change Renamed.',
  );
  assert.equal(
    f.message,
    "Your earlier change to this event hasn't been sent yet. Undo it, or try again once it has.",
  );
  assert.equal(f.retry, 'now', 'nothing was accepted, so re-running is safe');
  assert.notEqual(f.reopenEditor, true, 'not the stale-copy conflict: the editor stays closed');
  assert.notEqual(f.keepDraft, true);
});

test('review12: a holdPending refusal rolls back, toasts the sentence, and Retry re-runs once', async () => {
  resetToasts();
  try {
    const ui = testUi();
    let calls = 0;
    const p: EffectPorts = {
      ...ports(),
      eventSet: () => {
        calls += 1;
        return calls === 1
          ? Promise.reject({
              type: 'conflict',
              message: 'held',
              reasonCode: 'calendar.holdPending',
            })
          : Promise.resolve({ receipt: { opId: 'op-2', appliedState: { dbEpoch: 'e', seq: 2 } } });
      },
    };
    runCalendarEffect(save, p, ui);
    await new Promise(resolve => setImmediate(resolve));
    const toast = getToasts().find(t => t.id.endsWith(':failed'));
    assert.equal(
      toast?.message,
      "Your earlier change to this event hasn't been sent yet. Undo it, or try again once it has.",
    );
    assert.ok(
      toast?.actions?.some(a => a.id === 'retry'),
      'Retry is offered',
    );
    assert.deepEqual(ui.dropped, ['design'], 'the optimistic patch rolled back');
    assert.deepEqual(ui.reopened, [], 'no editor re-open for a hold conflict');
    if (toast) runToastAction(toast.id, 'retry');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 2, 'Retry re-ran the write once under a fresh opId');
    assert.deepEqual(ui.applied, ['design'], 'the second write settled');
  } finally {
    resetToasts();
  }
});
