/**
 * review21: second-round review fixes on the failed-holds surface.
 *
 * - The pane's account scope filters `cal:` items (`useFailedHolds` gets the pane's accountId): a
 *   failed hold on another account must never draw the line here.
 * - A `cal:` item the engine is still working on (queued or syncing) keeps the queue watched — its
 *   meta-only commits never move the events window's seq, so nothing else would fetch the failure.
 * - A hold a newer write retired (`staleRetries`) shows Discard alone with why; a stale Retry can
 *   never send the older change over the newer one.
 * - A Retry/Discard in flight holds its buttons busy and ignores a second press; an 'already being
 *   sent' refusal stays quiet.
 * - A dead grant (auth.expired / needsReauth) or a missing write scope (permission.calendarWrite)
 *   gets its fix in the row — Sign in again / Enable editing for the item's own account.
 * - `closed()` resets `holdsReview`, so a surface can never open under the Review popover; opening
 *   the review closes the other transient surfaces.
 * - Row actions name the account they act on; an emptied open list puts focus back on the grid.
 * - A refused Discard reuses `<opId>:failed`; a toast never re-lists the queue.
 *
 * Run: `cd apps/desktop && npx tsx --test 'src/renderer/screens/calendar/*.test.ts*'`.
 */
import './calendar.tz';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { QueueItem } from '@aplos/contract';
import { failedHoldsOf } from './FailedHolds';
import { account } from './accountCalendarState.test';
import type { Account } from '../../data';

const ACCOUNTS: readonly Account[] = [
  account({ id: 'acct-alex', name: 'Alex Moreno', address: 'alex.moreno@example.com' }),
  account({ id: 'acct-jordan', name: 'Jordan Lee', address: 'jordan.lee@example.com' }),
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

test('review21: a scoped pane lists only its own account’s failed holds', () => {
  const items = [
    calItem({ id: 'cal:op-alex', accountId: 'acct-alex' }),
    calItem({ id: 'cal:op-jordan', accountId: 'acct-jordan' }),
    calItem({ id: 'cal:op-anon' }),
  ];
  delete (items[2] as { accountId?: string }).accountId;
  assert.deepEqual(
    failedHoldsOf(items, new Set(), ACCOUNTS, { accountId: 'acct-alex' }).map(h => h.id),
    ['cal:op-alex'],
  );
  // No scope: every account's holds still list (the all-accounts pane).
  assert.equal(failedHoldsOf(items, new Set(), ACCOUNTS).length, 3);
});
