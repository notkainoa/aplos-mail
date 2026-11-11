/**
 * The review19 surface, corrected for the engine's real Queue/list shape (PR #480, review20): a
 * failed calendar hold is a content-free `op` item `cal:<opId>` with the fixed label 'Calendar
 * change' — not an `op:` item whose label names `Event/set`. After a reload the in-session
 * op-failure toast is gone, so the pane's quiet line — "N changes didn't send · Review" — is the
 * only place the owner learns a change never sent.
 *
 * - `failedHoldsOf` keeps `cal:` items in `failed` and ignores mail ops, jobs, submissions, and
 *   holds still inside their undo window (`queued`) or in flight (`syncing`).
 * - Each item's reasonCode maps through writeErrors' at-operation table; an unknown code (or no
 *   problem at all) keeps the engine's own sentence, then the plain fallback.
 * - Items an in-session `<opId>:failed` toast already owns are counted once, not twice.
 *
 * Run: `cd apps/desktop && npx tsx --test 'src/renderer/screens/calendar/*.test.ts*'`.
 */
import './calendar.tz';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { QueueItem } from '@aplos/contract';
import {
  failedHoldLine,
  failedHoldsOf,
  holdAccount,
  holdSentence,
  isCalendarHoldItem,
  opIdOf,
} from './FailedHolds';
import { update, viewModel } from './calendar.model';
import { ctxFor, S } from './calendar.testkit';
import { account } from './accountCalendarState.test';

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

test('review19: a mail op in Queue/list is ignored', () => {
  const mail = calItem({ id: 'op:op-mail', label: 'Thread/act 2', scope: 'triage' });
  const job = calItem({ id: 'job-1', kind: 'job', label: 'Summary' });
  const submission = calItem({ id: 'sub-1', kind: 'submission', label: 'Send 1 message' });
  assert.equal(isCalendarHoldItem(mail), false);
  assert.equal(isCalendarHoldItem(job), false);
  assert.equal(isCalendarHoldItem(submission), false);
  assert.deepEqual(failedHoldsOf([mail, job, submission], new Set(), []), []);
});

test('review19: a hold inside its undo window or in flight is not a failure yet', () => {
  // `queued` still has the write's own Undo toast; `syncing` is a send under way.
  assert.equal(isCalendarHoldItem(calItem({ state: 'queued' })), false);
  assert.equal(isCalendarHoldItem(calItem({ state: 'syncing' })), false);
});

test('review19: a failed cal: item is listed; the op id is the id minus the prefix', () => {
  const holds = failedHoldsOf([calItem({ id: 'cal:op-hold' })], new Set(), []);
  assert.equal(holds.length, 1);
  assert.equal(holds[0].id, 'cal:op-hold');
  assert.equal(holds[0].opId, 'op-hold');
  assert.equal(opIdOf({ id: 'cal:op-hold' }), 'op-hold');
  assert.equal(holds[0].canRetry, true);
  assert.equal(holds[0].canDiscard, true);
});

test('review19: reasonCode sentences come from writeErrors; the engine’s words otherwise', () => {
  assert.equal(
    holdSentence({ problem: { reasonCode: 'calendar.late', message: 'held too long' } }),
    "That change wasn't sent in time. Check the event, then send it again.",
  );
  assert.equal(
    holdSentence({ problem: { reasonCode: 'auth.expired', message: 'grant dead' } }),
    'Sign in to Google again to send this change.',
  );
  // An unknown code (or no problem at all) keeps the engine's own plain sentence, then the fallback.
  assert.equal(
    holdSentence({ problem: { reasonCode: 'something.else', message: 'Google said no.' } }),
    'Google said no.',
  );
  assert.equal(holdSentence({}), "This change wasn't sent.");
});

test('review19: the line counts once, announces plainly', () => {
  assert.equal(failedHoldLine(1), "1 change didn't send");
  assert.equal(failedHoldLine(3), "3 changes didn't send");
});

test('review19: an empty list draws no line', () => {
  const vm = viewModel(S(), ctxFor());
  // Empty items draw nothing, but the surface stays mounted so an emptied open list can close
  // itself (review22).
  assert.equal(vm.failedHolds.items.length, 0);
  const withHolds = { ...ctxFor(), failedHolds: failedHoldsOf([calItem()], new Set(), []) };
  const vm2 = viewModel(S(), withHolds);
  assert.equal(vm2.failedHolds?.items.length, 1);
});

test('review19: a live op-failure toast counts the hold once, not twice', () => {
  const items = [calItem({ id: 'cal:op-seen' }), calItem({ id: 'cal:op-new' })];
  const holds = failedHoldsOf(items, new Set(['op-seen:failed']), []);
  assert.deepEqual(
    holds.map(h => h.opId),
    ['op-new'],
  );
});

test('review19: the row names the account the item names, when the screen knows it', () => {
  const accounts = [
    account({ id: 'acct-alex', name: 'Alex Moreno', address: 'alex.moreno@example.com' }),
  ];
  assert.equal(holdAccount(accounts, 'acct-alex'), 'Alex Moreno');
  assert.equal(holdAccount(accounts, 'acct-none'), undefined);
  assert.equal(holdAccount(accounts, undefined), undefined);
  assert.equal(failedHoldsOf([calItem()], new Set(), accounts)[0].account, 'Alex Moreno');
  // An account the screen does not have stays out of the row.
  assert.equal(
    failedHoldsOf([calItem({ accountId: 'acct-none' })], new Set(), accounts)[0].account,
    undefined,
  );
});

test('review19: Esc closes the Review list; Review toggles it', () => {
  const open = update(S(), { type: 'holdsReview', open: true }, ctxFor());
  assert.equal(open.state.holdsReview, true);
  const closed = update(open.state, { type: 'escape' }, ctxFor());
  assert.equal(closed.state.holdsReview, false);
  assert.equal(closed.handled, true);
});
