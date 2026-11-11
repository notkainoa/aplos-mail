/**
 * The review19 surface: failed calendar holds read back from Queue/list (DESIGN 7.15). After a reload
 * the in-session op-failure toast is gone, so the pane's quiet line — "N changes didn't send · Review"
 * — is the only place the owner learns a change never sent.
 *
 * - `failedHoldsOf` keeps `op` items whose label names a calendar method (the engine's 'Event/set 1'
 *   shape, or the stand-in's 'set 1 item' under the `send` scope) and ignores mail ops.
 * - Each item's reasonCode maps through writeErrors' at-operation table; unknown codes read
 *   "This change wasn't sent."
 * - Review's Retry is `Operation/retry` on the same op id — never `Event/set` — and Discard is
 *   `Queue/discard` on the item id; a refused retry lands as a quiet sentence, not a crash.
 * - Items an in-session `<opId>:failed` toast already owns are counted once, not twice.
 *
 * Run: `cd apps/desktop && npx tsx --test 'src/renderer/screens/calendar/*.test.ts*'`.
 */
import './calendar.tz';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { QueueItem } from '@aplos/contract';
import { getToasts, resetToasts } from '../../shell/store-toast';
import {
  failedHoldLine,
  failedHoldsOf,
  holdSentence,
  isCalendarHoldItem,
  opIdOf,
} from './FailedHolds';
import { runCalendarEffect, type EffectPorts } from './effects';
import { update, viewModel, type CalendarEffect } from './calendar.model';
import { ctxFor, S, testUi } from './calendar.testkit';

/** A queue item shaped like the real engine's rows: `op:<opId>`, a `<method> <count>` label. */
function opItem(over: Partial<QueueItem>): QueueItem {
  return {
    id: 'op:op-1',
    kind: 'op',
    label: 'Event/set 1',
    state: 'failed',
    attempts: 1,
    createdAt: 1_000,
    problem: { reasonCode: 'calendar.late', message: 'held too long' },
    canRetry: true,
    canDiscard: true,
    scope: 'send',
    ...over,
  };
}

/** Fake ports recording every call; `fail` makes the named port reject with `body`. */
function fakePorts(fail?: { queueDiscard?: unknown; operationRetry?: unknown }) {
  const calls: { method: string; args: unknown }[] = [];
  const record =
    (method: string, reject: unknown) =>
    (args: unknown): Promise<unknown> => {
      calls.push({ method, args });
      return reject === undefined ? Promise.resolve({ ok: true }) : Promise.reject(reject);
    };
  const ports: EffectPorts = {
    eventSet: record('Event/set', undefined) as EffectPorts['eventSet'],
    eventRsvp: record('Event/rsvp', undefined) as EffectPorts['eventRsvp'],
    calendarSet: record('Calendar/set', undefined) as EffectPorts['calendarSet'],
    planConfirm: record('Plan/confirm', undefined) as EffectPorts['planConfirm'],
    planDismiss: record('Plan/dismiss', undefined) as EffectPorts['planDismiss'],
    eventHide: record('Event/hide', undefined) as EffectPorts['eventHide'],
    operationRetry: record(
      'Operation/retry',
      fail?.operationRetry,
    ) as EffectPorts['operationRetry'],
    queueDiscard: record('Queue/discard', fail?.queueDiscard) as EffectPorts['queueDiscard'],
    enableEditing: () => Promise.resolve(),
    reconnect: () => undefined,
    openThread: () => undefined,
    openUrl: () => undefined,
    copyText: () => undefined,
  };
  return { ports, calls };
}

test('review19: a mail op in Queue/list is ignored', () => {
  const mail = opItem({ id: 'op:op-mail', label: 'Thread/act 2', scope: 'triage' });
  const job = opItem({ id: 'job-1', kind: 'job', label: 'Summary' });
  const submission = opItem({ id: 'sub-1', kind: 'submission', label: 'Send 1 message' });
  assert.equal(isCalendarHoldItem(mail), false);
  assert.equal(isCalendarHoldItem(job), false);
  assert.equal(isCalendarHoldItem(submission), false);
  // A queued or in-flight calendar op is not a failure yet.
  assert.equal(isCalendarHoldItem(opItem({ state: 'queued' })), false);
  assert.deepEqual(failedHoldsOf([mail, job, submission], new Set()), []);
});

test('review19: a failed calendar hold is listed, fixture label shape too', () => {
  const real = opItem({ id: 'op:op-hold', label: 'Event/set 1' });
  const rsvp = opItem({ id: 'op:op-rsvp', label: 'Event/rsvp 1', state: 'conflict' });
  // The stand-in's own queue labels are '<verb> N item(s)' under the originating scope.
  const fixture = opItem({ id: 'op-fixture', label: 'set 1 item', scope: 'send' });
  const holds = failedHoldsOf([real, rsvp, fixture], new Set());
  assert.deepEqual(
    holds.map(h => h.opId),
    ['op-hold', 'op-rsvp', 'op-fixture'],
  );
  // `op:` is the engine's queue id prefix; `Operation/retry` takes the bare op id.
  assert.equal(opIdOf(real), 'op-hold');
  assert.equal(holds[0].canRetry, true);
  assert.equal(holds[0].canDiscard, true);
});

test('review19: reasonCode sentences come from writeErrors; unknown gets the plain fallback', () => {
  assert.equal(
    holdSentence('calendar.late'),
    "That change wasn't sent in time. Check the event, then send it again.",
  );
  assert.equal(holdSentence('auth.expired'), 'Sign in to Google again to send this change.');
  assert.equal(
    holdSentence('calendar.unavailable'),
    "Couldn't reach Google Calendar. The change hasn't been sent yet.",
  );
  assert.equal(holdSentence('something.else'), "This change wasn't sent.");
  assert.equal(holdSentence(undefined), "This change wasn't sent.");
});

test('review19: the line counts once, announces plainly', () => {
  assert.equal(failedHoldLine(1), "1 change didn't send");
  assert.equal(failedHoldLine(3), "3 changes didn't send");
});

test('review19: Review Retry is Operation/retry on the same op id, never Event/set', async () => {
  const t = update(
    S({ holdsReview: true }),
    { type: 'holdRetry', id: 'op:op-hold', opId: 'op-hold' },
    ctxFor(),
  );
  assert.deepEqual(t.effects, [{ kind: 'holdRetry', id: 'op:op-hold', opId: 'op-hold' }]);
  // The list stays open so a settled row leaves in place.
  assert.equal(t.state.holdsReview, true);

  const { ports, calls } = fakePorts();
  runCalendarEffect(t.effects[0] as CalendarEffect, ports, testUi());
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(
    calls.map(c => c.method),
    ['Operation/retry'],
  );
  assert.deepEqual(calls[0].args, { opId: 'op-hold' });
});

test('review19: Review Discard is Queue/discard on the item id', async () => {
  const t = update(S(), { type: 'holdDiscard', id: 'op:op-hold' }, ctxFor());
  const { ports, calls } = fakePorts();
  runCalendarEffect(t.effects[0] as CalendarEffect, ports, testUi());
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(
    calls.map(c => c.method),
    ['Queue/discard'],
  );
  assert.deepEqual(calls[0].args, { id: 'op:op-hold' });
});

test('review19: a refused retry shows a quiet sentence, no crash', async () => {
  resetToasts();
  const { ports } = fakePorts({
    operationRetry: { error: { type: 'conflict', message: 'That change was already sent.' } },
  });
  runCalendarEffect({ kind: 'holdRetry', id: 'op:op-hold', opId: 'op-hold' }, ports, testUi());
  await new Promise(resolve => setImmediate(resolve));
  const toast = getToasts().find(toast => toast.id === 'op-hold:failed');
  assert.equal(toast?.message, 'That change was already sent.');
  resetToasts();
});

test('review19: an empty list draws no line', () => {
  const vm = viewModel(S(), ctxFor());
  assert.equal(vm.failedHolds, null);
  const withHolds = { ...ctxFor(), failedHolds: failedHoldsOf([opItem({})], new Set()) };
  const vm2 = viewModel(S(), withHolds);
  assert.equal(vm2.failedHolds?.line, "1 change didn't send");
  assert.equal(vm2.failedHolds?.items.length, 1);
});

test('review19: a live op-failure toast counts the hold once, not twice', () => {
  const items = [
    opItem({ id: 'op:op-seen', label: 'Event/set 1' }),
    opItem({ id: 'op:op-new', label: 'Event/set 1' }),
  ];
  const holds = failedHoldsOf(items, new Set(['op-seen:failed']));
  assert.deepEqual(
    holds.map(h => h.opId),
    ['op-new'],
  );
});

test('review19: Esc closes the Review list; Review toggles it', () => {
  const open = update(S(), { type: 'holdsReview', open: true }, ctxFor());
  assert.equal(open.state.holdsReview, true);
  const closed = update(open.state, { type: 'escape' }, ctxFor());
  assert.equal(closed.state.holdsReview, false);
  assert.equal(closed.handled, true);
});
