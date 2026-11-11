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
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import type { QueueItem } from '@aplos/contract';
import {
  FailedHolds,
  failedHoldsOf,
  holdsNeedWatch,
  useFailedHolds,
  type FailedHold,
} from './FailedHolds';
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

test('review21: only a queued or syncing cal: item keeps the queue watched', () => {
  assert.equal(holdsNeedWatch([calItem({ state: 'queued' })]), true);
  assert.equal(holdsNeedWatch([calItem({ state: 'syncing' })]), true);
  assert.equal(holdsNeedWatch([calItem({ state: 'failed' })]), false);
  // A mail op or a job in flight is not the calendar lane's business.
  assert.equal(holdsNeedWatch([calItem({ id: 'op:op-mail', state: 'queued' })]), false);
  assert.equal(holdsNeedWatch([calItem({ id: 'job:7', state: 'queued' })]), false);
});

const glob = globalThis as {
  document?: unknown;
  window?: unknown;
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
glob.IS_REACT_ACT_ENVIRONMENT = true;

/** Mount a null-rendering component on the bare fake container (useSealedMailKeys' pattern). */
function mount(el: React.ReactElement): () => void {
  const doc = {
    nodeType: 9,
    addEventListener: () => {},
    removeEventListener: () => {},
    visibilityState: 'visible',
    activeElement: null,
  };
  const savedDocument = glob.document;
  const savedWindow = glob.window;
  glob.window = {
    HTMLIFrameElement: class {},
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  glob.document = doc;
  const container = {
    ...doc,
    nodeType: 1,
    tagName: 'DIV',
    textContent: '',
    ownerDocument: doc,
  } as unknown as Element;
  const root = createRoot(container);
  act(() => root.render(el));
  return () => {
    act(() => root.unmount());
    glob.document = savedDocument;
    glob.window = savedWindow;
  };
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const noop = () => {};

const row = (hold: FailedHold, open = true) =>
  renderToStaticMarkup(<FailedHolds holds={[hold]} open={open} dispatch={noop} />);

test('review21: a hold a newer write retired shows Discard alone, with why', () => {
  const holds = failedHoldsOf([calItem()], new Set(), ACCOUNTS, { stale: () => true });
  assert.equal(holds[0].stale, true);
  const html = row(holds[0]);
  assert.doesNotMatch(html, />Retry</);
  assert.match(html, />Discard</);
  assert.match(html, /You changed this event again\. This older change can be discarded\./);
});

test('review21: a fresh hold keeps its Retry beside Discard', () => {
  const html = row(failedHoldsOf([calItem()], new Set(), ACCOUNTS)[0]);
  assert.match(html, />Retry</);
  assert.match(html, />Discard</);
});

test('review21: a queued hold that fails while the pane is mounted surfaces without a window frame', async () => {
  let calls = 0;
  const seen: number[] = [];
  const list = () =>
    Promise.resolve<readonly QueueItem[]>([
      calItem({ state: calls++ === 0 ? 'queued' : 'failed' }),
    ]);
  function Probe() {
    const { holds } = useFailedHolds('', ACCOUNTS, {}, { list, watchMs: 10 });
    seen.push(holds.length);
    return null;
  }
  const unmount = mount(<Probe />);
  await act(() => sleep(60));
  unmount();
  assert.ok(calls > 1, 'the watch kept re-listing while the item was queued');
  assert.equal(seen.at(-1), 1);
});
