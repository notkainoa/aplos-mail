/**
 * review20: the failed-holds surface on the engine's real Queue/list shape (PR #480). The previous
 * round assumed `op:` items labeled 'Event/set N' resolvable to an event; the engine ships
 * content-free `cal:<opId>` `op` items — label 'Calendar change', account, state, `nextAt` while
 * waiting, a plain failure sentence, `canRetry`/`canDiscard` — so a row reads 'A calendar change',
 * its account and its reason, and can never name the event.
 *
 * - A failed `cal:` item is listed; a `queued` or `syncing` hold and an `op:` mail item are not.
 * - An uncertain hold (`calendar.uncertain`, `canRetry` false) offers Discard only.
 * - Retry is `Queue/retry {id}` — the engine's own path for holds — never `Event/set`; Discard is
 *   `Queue/discard {id}`. A `calendar.checkFirst` refusal reads 'Check your calendar first: we
 *   couldn't confirm that change went through.' and offers Discard alone; a forbidden answer is a
 *   quiet sentence. A transient refusal keeps Retry, which retries the item id again.
 * - A live `<opId>:failed` toast counts the item once; an empty list draws nothing.
 *
 * Run: `cd apps/desktop && npx tsx --test 'src/renderer/screens/calendar/*.test.ts*'`.
 */
import './calendar.tz';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import type { QueueItem } from '@aplos/contract';
import { getToasts, resetToasts, runToastAction } from '../../shell/store-toast';
import { FailedHolds, failedHoldsOf, isCalendarHoldItem, type FailedHold } from './FailedHolds';
import { runCalendarEffect, type EffectPorts } from './effects';
import { update, type CalendarEffect } from './calendar.model';
import { ctxFor, S, testUi } from './calendar.testkit';
import { account } from './accountCalendarState.test';

const ACCOUNTS = [
  account({ id: 'acct-alex', name: 'Alex Moreno', address: 'alex.moreno@example.com' }),
];

/** A queue item shaped like the real engine's hold rows: `cal:<opId>`, label 'Calendar change'. */
function calItem(over: Partial<QueueItem> = {}): QueueItem {
  return {
    id: 'cal:op-1',
    kind: 'op',
    label: 'Calendar change',
    accountId: 'acct-alex',
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

const noop = () => {};

const row = (hold: FailedHold, open = true) =>
  renderToStaticMarkup(<FailedHolds holds={[hold]} open={open} dispatch={noop} />);

/** Fake ports recording every call; `fail` makes the named port reject with `body`. */
function fakePorts(fail?: { queueRetry?: unknown; queueDiscard?: unknown }) {
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
    operationRetry: record('Operation/retry', undefined) as EffectPorts['operationRetry'],
    queueRetry: record('Queue/retry', fail?.queueRetry) as EffectPorts['queueRetry'],
    queueDiscard: record('Queue/discard', fail?.queueDiscard) as EffectPorts['queueDiscard'],
    enableEditing: () => Promise.resolve(),
    reconnect: () => undefined,
    openThread: () => undefined,
    openUrl: () => undefined,
    copyText: () => undefined,
  };
  return { ports, calls };
}

test('review20: a mail op item and a waiting or in-flight hold are ignored', () => {
  assert.equal(isCalendarHoldItem(calItem({ id: 'op:op-mail' })), false);
  assert.equal(isCalendarHoldItem(calItem({ state: 'queued' })), false);
  assert.equal(isCalendarHoldItem(calItem({ state: 'syncing' })), false);
  assert.equal(isCalendarHoldItem(calItem({ id: 'cal:op-1', state: 'failed' })), true);
});

test('review20: a failed cal: item is listed with its account resolved', () => {
  const holds = failedHoldsOf([calItem()], new Set(), ACCOUNTS);
  assert.equal(holds.length, 1);
  assert.equal(holds[0].id, 'cal:op-1');
  assert.equal(holds[0].opId, 'op-1');
  assert.equal(holds[0].account, 'Alex Moreno');
});

test('review20: an uncertain hold offers Discard only', () => {
  const uncertain = failedHoldsOf(
    [
      calItem({
        id: 'cal:op-uncertain',
        problem: { reasonCode: 'calendar.uncertain', message: 'answer lost' },
        canRetry: false,
      }),
    ],
    new Set(),
    ACCOUNTS,
  )[0];
  assert.equal(uncertain.canRetry, false);
  assert.equal(uncertain.canDiscard, true);
  const html = row(uncertain);
  assert.match(html, /A calendar change/);
  assert.match(html, /Alex Moreno/);
  assert.match(html, />Discard</);
  assert.doesNotMatch(html, />Retry</);
});

test('review20: Review Retry is Queue/retry on the item id, never Event/set', async () => {
  const t = update(
    S({ holdsReview: true }),
    { type: 'holdRetry', id: 'cal:op-hold', opId: 'op-hold' },
    ctxFor(),
  );
  assert.deepEqual(t.effects, [{ kind: 'holdRetry', id: 'cal:op-hold', opId: 'op-hold' }]);
  // The list stays open so a settled row leaves in place.
  assert.equal(t.state.holdsReview, true);

  const { ports, calls } = fakePorts();
  runCalendarEffect(t.effects[0] as CalendarEffect, ports, testUi());
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(
    calls.map(c => c.method),
    ['Queue/retry'],
  );
  assert.deepEqual(calls[0].args, { id: 'cal:op-hold' });
});

test('review20: Review Discard is Queue/discard on the item id', async () => {
  const t = update(S(), { type: 'holdDiscard', id: 'cal:op-hold' }, ctxFor());
  const { ports, calls } = fakePorts();
  runCalendarEffect(t.effects[0] as CalendarEffect, ports, testUi());
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(
    calls.map(c => c.method),
    ['Queue/discard'],
  );
  assert.deepEqual(calls[0].args, { id: 'cal:op-hold' });
});

test('review20: a checkFirst refusal shows the check-first sentence and offers Discard alone', async () => {
  resetToasts();
  const { ports, calls } = fakePorts({
    queueRetry: {
      error: {
        type: 'conflict',
        message:
          'Check your calendar: this change may already have gone through. Make it again if it is missing.',
        reasonCode: 'calendar.checkFirst',
      },
    },
  });
  runCalendarEffect({ kind: 'holdRetry', id: 'cal:op-hold', opId: 'op-hold' }, ports, testUi());
  await new Promise(resolve => setImmediate(resolve));
  const toast = getToasts().find(t => t.id === 'op-hold:failed');
  assert.equal(
    toast?.message,
    "Check your calendar first: we couldn't confirm that change went through.",
  );
  assert.deepEqual(
    toast?.actions?.map(a => a.id),
    ['discard'],
  );

  // Its Discard drops the hold through the same item id and closes the toast.
  runToastAction('op-hold:failed', 'discard');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(
    calls.map(c => c.method),
    ['Queue/retry', 'Queue/discard'],
  );
  assert.deepEqual(calls[1].args, { id: 'cal:op-hold' });
  assert.equal(
    getToasts().find(t => t.id === 'op-hold:failed'),
    undefined,
  );
  resetToasts();
});

test('review20: a forbidden refusal shows a quiet sentence', async () => {
  resetToasts();
  const { ports } = fakePorts({
    queueRetry: { error: { type: 'forbidden', message: 'Aplos may not send that change.' } },
  });
  runCalendarEffect({ kind: 'holdRetry', id: 'cal:op-hold', opId: 'op-hold' }, ports, testUi());
  await new Promise(resolve => setImmediate(resolve));
  const toast = getToasts().find(t => t.id === 'op-hold:failed');
  assert.equal(toast?.message, 'Aplos may not send that change.');
  assert.equal(toast?.persistent, true);
  // A refusal that cannot change keeps no Retry — Dismiss alone.
  assert.deepEqual(
    toast?.actions?.map(a => a.id),
    ['dismiss'],
  );
  resetToasts();
});

test('review20: an empty list renders nothing', () => {
  assert.equal(renderToStaticMarkup(<FailedHolds holds={[]} open={false} dispatch={noop} />), '');
});

test('review20: a live op-failure toast counts the hold once, not twice', () => {
  const items = [calItem({ id: 'cal:op-seen' }), calItem({ id: 'cal:op-new' })];
  const holds = failedHoldsOf(items, new Set(['op-seen:failed']), ACCOUNTS);
  assert.deepEqual(
    holds.map(h => h.opId),
    ['op-new'],
  );
});

test('review20: a transient refusal keeps Retry, wired to the same item id', async () => {
  resetToasts();
  const { ports, calls } = fakePorts({
    queueRetry: { error: { type: 'unavailable', message: 'Google did not answer.' } },
  });
  runCalendarEffect({ kind: 'holdRetry', id: 'cal:op-hold', opId: 'op-hold' }, ports, testUi());
  await new Promise(resolve => setImmediate(resolve));
  const toast = getToasts().find(t => t.id === 'op-hold:failed');
  assert.equal(toast?.message, 'Google did not answer.');
  assert.deepEqual(
    toast?.actions?.map(a => a.id),
    ['retry', 'dismiss'],
  );
  runToastAction('op-hold:failed', 'retry');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(
    calls.map(c => c.method),
    ['Queue/retry', 'Queue/retry'],
  );
  resetToasts();
});
