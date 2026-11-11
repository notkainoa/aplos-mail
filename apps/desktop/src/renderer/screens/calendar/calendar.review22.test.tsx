/**
 * review22: third-round review fixes on the failed-holds surface.
 *
 * - The Review surface stays mounted when its list empties: `vm.failedHolds` is always present so
 *   `FailedHolds` sees the count reach zero, dispatches `holdsEmptied` itself (closing the stale
 *   `holdsReview` flag and landing focus on the grid), and the next failed hold arrives closed —
 *   the popover never pops open on its own.
 * - A non-last row leaving under the open popover hands focus to the next row's first button (the
 *   previous row's when the last left), never to body where Esc would miss the popover.
 * - Discard says what it drops: 'Discarding means this change is never sent.' under the list, and
 *   an uncertain hold's own 'Discarding does not undo anything already on your Google calendar.';
 *   on open, focus lands on the dialog container, not the first row's possibly-destructive Discard.
 * - `Queue/retry` resolving does not mean the resend went through: when the refreshed list still
 *   shows the item `failed`, one quiet 'Still didn't send.' toast carries it (`<opId>:failed`).
 * - A rejected `Queue/list` keeps the last good items and retries on the same bounded timer (a cap
 *   of five, then it rests until the next tick or focus) — a briefly unavailable engine can no
 *   longer kill the watch or the first list after a reload.
 * - The Review button declares its dialog: aria-haspopup, aria-expanded and aria-controls.
 *
 * Run: `cd apps/desktop && npx tsx --test 'src/renderer/screens/calendar/*.test.ts*'`.
 */
import './calendar.tz';
import test from 'node:test';
import assert from 'node:assert/strict';
import { act, type RefObject } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import type { QueueItem } from '@aplos/contract';
import {
  FailedHolds,
  failedHoldsOf,
  noteHoldRetried,
  useFailedHolds,
  useReviewLifecycle,
  type FailedHold,
} from './FailedHolds';
import { getToasts, resetToasts } from '../../shell/store-toast';
import { update, viewModel, type CalendarAction } from './calendar.model';
import { ctxFor, S } from './calendar.testkit';
import { account } from './accountCalendarState.test';
import type { Account } from '../../data';

const ACCOUNTS: readonly Account[] = [
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

const hold = (over: Partial<FailedHold> = {}): FailedHold => ({
  id: 'cal:op-1',
  opId: 'op-1',
  reason: "That change wasn't sent in time. Check the event, then send it again.",
  account: 'Alex Moreno',
  canRetry: true,
  canDiscard: true,
  ...over,
});

const noop = () => {};

const markup = (holds: readonly FailedHold[], open = true) =>
  renderToStaticMarkup(<FailedHolds holds={holds} open={open} dispatch={noop} />);

/* ---------------------------------------------------------------------------
   The emptied list must close itself from inside the mounted surface (1)
   --------------------------------------------------------------------------- */

test('review22: the view keeps the surface mounted with the stale open flag on an emptied list', () => {
  const vm = viewModel(S({ holdsReview: true }), ctxFor()); // ctxFor: no failed holds
  // Null here means FailedHolds unmounts and can never see the count reach zero (the bug).
  assert.notEqual(vm.failedHolds, null);
  assert.equal(vm.failedHolds?.items.length, 0);
  assert.equal(vm.failedHolds?.open, true);
});

/* ---------------------------------------------------------------------------
   React-mounted probes on the bare fake container (review21's pattern): the
   components under test render null themselves, so no real DOM is needed.
   --------------------------------------------------------------------------- */

const glob = globalThis as {
  document?: unknown;
  window?: unknown;
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
glob.IS_REACT_ACT_ENVIRONMENT = true;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const fakeDoc = () => ({
  nodeType: 9,
  addEventListener: () => {},
  removeEventListener: () => {},
  visibilityState: 'visible',
  activeElement: null as unknown,
});

function mount(el: React.ReactElement): () => void {
  const doc = fakeDoc();
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

/** The same bare mount, but lets the test re-render and set `document.activeElement`. */
function mountProbe(el: React.ReactElement) {
  const doc = fakeDoc();
  const savedDocument = glob.document;
  const savedWindow = glob.window;
  glob.window = { HTMLIFrameElement: class {} };
  glob.document = doc;
  const container = {
    ...doc,
    nodeType: 1,
    tagName: 'DIV',
    textContent: '',
    ownerDocument: doc,
  } as unknown as Element;
  const root = createRoot(container);
  const rerender = (next: React.ReactElement) => act(() => root.render(next));
  rerender(el);
  return {
    doc,
    rerender,
    unmount: () => {
      act(() => root.unmount());
      glob.document = savedDocument;
      glob.window = savedWindow;
    },
  };
}

/** Elements enough like DOM for the lifecycle hook's focus work. */
function fakeSurface() {
  const focused: string[] = [];
  const inside = new Set<unknown>();
  const button = { focus: () => focused.push('button') };
  const row = { querySelector: () => button };
  let rows: unknown[] = [];
  const pop = {
    contains: (el: unknown) => el === pop || inside.has(el),
    focus: () => focused.push('pop'),
  };
  const box = {
    closest: () => pop,
    querySelectorAll: () => rows,
  };
  return {
    focused,
    inside,
    button,
    row,
    pop,
    box: box as unknown as HTMLElement,
    setRows(next: unknown[]) {
      rows = next;
    },
    body: {},
  };
}

test('review22: an emptied open list dispatches holdsEmptied through the real lifecycle', () => {
  const surface = fakeSurface();
  const boxRef: RefObject<HTMLElement | null> = { current: surface.box };
  const dispatched: CalendarAction[] = [];
  function Probe({ holds, open }: { holds: readonly FailedHold[]; open: boolean }) {
    useReviewLifecycle(boxRef, holds, open, a => dispatched.push(a));
    return null;
  }
  const { rerender, unmount } = mountProbe(<Probe holds={[hold()]} open={true} />);
  assert.deepEqual(dispatched, []);
  // The last row's own Discard emptied the list under the open popover.
  rerender(<Probe holds={[]} open={true} />);
  assert.deepEqual(dispatched, [{ type: 'holdsEmptied' }]);
  unmount();
});

test('review22: holdsEmptied closes the stale flag so a new hold arrives shut', () => {
  const t = update(S({ holdsReview: true }), { type: 'holdsEmptied' }, ctxFor());
  assert.equal(t.state.holdsReview, false);
  assert.deepEqual(t.effects, [{ kind: 'focus', target: 'grid' }]);
  const withNew = {
    ...ctxFor(),
    failedHolds: failedHoldsOf([calItem()], new Set(), ACCOUNTS),
  };
  const vm = viewModel(t.state, withNew);
  assert.equal(vm.failedHolds?.open, false);
});

test('review22: a row leaving mid-list hands focus to the next row’s first button', () => {
  const surface = fakeSurface();
  const boxRef: RefObject<HTMLElement | null> = { current: surface.box };
  const three = [hold({ id: 'cal:a' }), hold({ id: 'cal:b' }), hold({ id: 'cal:c' })];
  function Probe({ holds }: { holds: readonly FailedHold[] }) {
    useReviewLifecycle(boxRef, holds, true, noop);
    return null;
  }
  surface.setRows([surface.row, surface.row, surface.row]);
  const { rerender, unmount } = mountProbe(<Probe holds={three} />);
  surface.focused.length = 0;
  // Row b's focused Discard unmounted with it: focus is on body, not inside the popover.
  surface.setRows([surface.row, surface.row]);
  rerender(<Probe holds={[three[0], three[2]]} />);
  assert.deepEqual(surface.focused, ['button']);
  unmount();
});

test('review22: focus on the popover itself is left alone when a row leaves', () => {
  const surface = fakeSurface();
  const boxRef: RefObject<HTMLElement | null> = { current: surface.box };
  const two = [hold({ id: 'cal:a' }), hold({ id: 'cal:b' })];
  function Probe({ holds }: { holds: readonly FailedHold[] }) {
    useReviewLifecycle(boxRef, holds, true, noop);
    return null;
  }
  surface.setRows([surface.row, surface.row]);
  const { doc, rerender, unmount } = mountProbe(<Probe holds={two} />);
  surface.focused.length = 0;
  // The dialog container itself holds focus: a row leaving does not move it.
  doc.activeElement = surface.pop;
  surface.setRows([surface.row]);
  rerender(<Probe holds={[two[1]]} />);
  assert.deepEqual(surface.focused, []);
  unmount();
});

test('review22: opening Review lands focus on the dialog container, not a row button', () => {
  const surface = fakeSurface();
  const boxRef: RefObject<HTMLElement | null> = { current: surface.box };
  function Probe({ open }: { open: boolean }) {
    useReviewLifecycle(boxRef, [hold()], open, noop);
    return null;
  }
  surface.setRows([surface.row]);
  const { rerender, unmount } = mountProbe(<Probe open={false} />);
  surface.focused.length = 0;
  rerender(<Probe open={true} />);
  // The container takes it — the first focusable can be a destructive Discard.
  assert.deepEqual(surface.focused, ['pop']);
  unmount();
});

/* ---------------------------------------------------------------------------
   Discard says what it drops (3)
   --------------------------------------------------------------------------- */

test('review22: the list carries what Discard means', () => {
  const html = markup([hold()]);
  assert.match(html, /Discarding means this change is never sent\./);
});

test('review22: an uncertain hold warns that Discard does not undo what may be sent', () => {
  const [uncertain] = failedHoldsOf(
    [
      calItem({
        problem: { reasonCode: 'calendar.uncertain', message: 'answer lost' },
        canRetry: false,
      }),
    ],
    new Set(),
    ACCOUNTS,
  );
  assert.equal(uncertain.uncertain, true);
  const html = markup([uncertain]);
  assert.match(html, /Discarding does not undo anything already on your Google calendar\./);
});

test('review22: a plain failed hold carries no uncertain warning', () => {
  const [plain] = failedHoldsOf([calItem()], new Set(), ACCOUNTS);
  assert.equal(plain.uncertain, undefined);
  const html = markup([plain]);
  assert.doesNotMatch(html, /does not undo anything already on your Google calendar/);
});

/* ---------------------------------------------------------------------------
   The Review button names its dialog (6)
   --------------------------------------------------------------------------- */

test('review22: the Review button declares its dialog', () => {
  const html = markup([hold()], true);
  assert.match(html, /aria-haspopup="dialog"/);
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /aria-controls="cal-holds-list"/);
  const closed = markup([hold()], false);
  assert.match(closed, /aria-expanded="false"/);
});

/* ---------------------------------------------------------------------------
   A Retry that fails again says so once (4)
   --------------------------------------------------------------------------- */

test('review22: a retried item still failed gets one quiet notice under the op id', async () => {
  resetToasts();
  const item = calItem({ id: 'cal:op-again' });
  const list = () => Promise.resolve<readonly QueueItem[]>([item]);
  function Probe() {
    useFailedHolds('', ACCOUNTS, {}, { list });
    return null;
  }
  const unmount = mount(<Probe />);
  await act(() => sleep(10));
  // Queue/retry resolved, but the refreshed list still shows the hold failed.
  noteHoldRetried('cal:op-again');
  await act(() => sleep(20));
  unmount();
  const toast = getToasts().find(t => t.id === 'op-again:failed');
  assert.equal(toast?.message, "Still didn't send.");
  assert.equal(toast?.persistent, true);
  resetToasts();
});

test('review22: a retried item that left the queue stays quiet', async () => {
  resetToasts();
  const list = () => Promise.resolve<readonly QueueItem[]>([]);
  function Probe() {
    useFailedHolds('', ACCOUNTS, {}, { list });
    return null;
  }
  const unmount = mount(<Probe />);
  await act(() => sleep(10));
  noteHoldRetried('cal:op-gone');
  await act(() => sleep(20));
  unmount();
  assert.equal(
    getToasts().find(t => t.id === 'op-gone:failed'),
    undefined,
  );
  resetToasts();
});

/* ---------------------------------------------------------------------------
   A rejected list keeps polling, bounded (5)
   --------------------------------------------------------------------------- */

test('review22: a rejected list retries on the same bound and still lands the hold', async () => {
  let calls = 0;
  const seen: number[] = [];
  const list = () => {
    calls += 1;
    // Briefly unavailable, then the queued->failed change comes through.
    if (calls <= 2) return Promise.reject(new Error('engine unavailable'));
    return Promise.resolve<readonly QueueItem[]>([calItem()]);
  };
  function Probe() {
    const { holds } = useFailedHolds('', ACCOUNTS, {}, { list, watchMs: 10 });
    seen.push(holds.length);
    return null;
  }
  const unmount = mount(<Probe />);
  await act(() => sleep(80));
  unmount();
  assert.ok(calls >= 3, 'the rejected lists retried instead of dying');
  assert.equal(seen.at(-1), 1);
});

test('review22: a dead engine stops the list retries at the cap and never throws', async () => {
  let calls = 0;
  const list = () => {
    calls += 1;
    return Promise.reject(new Error('engine unavailable'));
  };
  function Probe() {
    useFailedHolds('', ACCOUNTS, {}, { list, watchMs: 10 });
    return null;
  }
  const unmount = mount(<Probe />);
  await act(() => sleep(120));
  unmount();
  assert.equal(calls, 6); // the first list plus five bounded retries
});
