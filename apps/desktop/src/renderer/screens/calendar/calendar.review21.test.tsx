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
import { getToasts, resetToasts } from '../../shell/store-toast';
import { runCalendarEffect, type EffectPorts } from './effects';
import { update } from './calendar.model';
import type { CalendarEffect } from './calendar.model';
import { ctxFor, nextTask, S, testUi } from './calendar.testkit';
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

test('review21: a second Retry while the first is in flight sends nothing', async () => {
  let release: (value: unknown) => void = () => {};
  const { ports, calls } = fakePorts();
  ports.queueRetry = args => {
    calls.push({ method: 'Queue/retry', args });
    return new Promise(resolve => (release = resolve));
  };
  const fx: CalendarEffect = { kind: 'holdRetry', id: 'cal:op-hold', opId: 'op-hold' };
  runCalendarEffect(fx, ports, testUi());
  runCalendarEffect(fx, ports, testUi());
  assert.deepEqual(
    calls.map(c => c.method),
    ['Queue/retry'],
  );
  release({ ok: true });
  await nextTask();
});

test('review21: an already-being-sent refusal stays quiet', async () => {
  resetToasts();
  const { ports } = fakePorts({
    queueRetry: {
      error: { type: 'conflict', message: 'Only a failed change can be retried.' },
    },
  });
  runCalendarEffect({ kind: 'holdRetry', id: 'cal:op-hold', opId: 'op-hold' }, ports, testUi());
  await nextTask();
  // The first send already took it: no phantom failure toast beside the row that is leaving.
  assert.equal(
    getToasts().find(t => t.id === 'op-hold:failed'),
    undefined,
  );
  resetToasts();
});

test('review21: a row with an action in flight holds its buttons busy', () => {
  const hold = failedHoldsOf([calItem()], new Set(), ACCOUNTS, { pending: () => true })[0];
  assert.equal(hold.pending, true);
  const html = row(hold);
  assert.match(html, /aria-busy="true"/);
});

test('review21: a dead grant offers Sign in again beside Retry', () => {
  const hold = failedHoldsOf(
    [calItem({ problem: { reasonCode: 'auth.expired', message: 'grant expired' } })],
    new Set(),
    ACCOUNTS,
  )[0];
  assert.equal(hold.recovery, 'reconnect');
  assert.equal(hold.accountId, 'acct-alex');
  const html = row(hold);
  assert.match(html, />Sign in again</);
  // The engine keeps canRetry true for a dead grant — Retry stays, it just re-fails until signed in.
  assert.match(html, />Retry</);
});

test('review21: a missing write scope offers Enable editing beside Retry', () => {
  const hold = failedHoldsOf(
    [
      calItem({
        problem: { reasonCode: 'permission.calendarWrite', message: 'read-only grant' },
      }),
    ],
    new Set(),
    ACCOUNTS,
  )[0];
  assert.equal(hold.recovery, 'enableEditing');
  const html = row(hold);
  assert.match(html, />Enable editing</);
  assert.match(html, />Retry</);
});

test('review21: an ordinary failure offers no grant action', () => {
  const hold = failedHoldsOf([calItem()], new Set(), ACCOUNTS)[0];
  assert.equal(hold.recovery, undefined);
  assert.doesNotMatch(row(hold), /Sign in again|Enable editing/);
});

test('review21: Sign in again reconnects the item’s own account', () => {
  const t = update(S(), { type: 'holdReconnect', accountId: 'acct-jordan' }, ctxFor());
  assert.deepEqual(t.effects, [{ kind: 'holdReconnect', accountId: 'acct-jordan' }]);
  let signedIn = '';
  const { ports } = fakePorts();
  ports.reconnect = accountId => {
    signedIn = accountId;
  };
  runCalendarEffect(t.effects[0] as CalendarEffect, ports, testUi());
  assert.equal(signedIn, 'acct-jordan');
});

test('review21: Enable editing asks for the item’s own account’s write scope', async () => {
  const t = update(S(), { type: 'holdEnableEditing', accountId: 'acct-jordan' }, ctxFor());
  // The detail's own Enable editing effect: the same port, the same refusal toast.
  assert.deepEqual(t.effects, [{ kind: 'enableEditing', accountId: 'acct-jordan' }]);
  let enabled = '';
  const { ports } = fakePorts();
  ports.enableEditing = accountId => {
    enabled = accountId;
    return Promise.resolve();
  };
  runCalendarEffect(t.effects[0] as CalendarEffect, ports, testUi());
  await nextTask();
  assert.equal(enabled, 'acct-jordan');
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
