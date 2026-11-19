/**
 * The window cache on the stand-in engine (plan 30 U2 acceptance 4): a frame with unknown ids triggers exactly one
 * `Thread/get` for those ids, a `reset` reopens windows, and window order equals the stand-in's. Node, no DOM:
 * `cd apps/desktop && npx tsx --test src/renderer/data/windows.test.ts`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ThreadRow, ViewSpec } from './contract-shapes';
import { createHarness, type Harness } from './harness';
import { windowStore } from './hooks';
import type { ViewResult } from './index';
import type { EngineWindow } from './windows';

const HOME = { kind: 'home' } as const satisfies ViewSpec;
const INBOX = { kind: 'mailbox', role: 'inbox' } as const satisfies ViewSpec;

async function open(h: Harness, spec: ViewSpec): Promise<EngineWindow> {
  const w = h.layer.windows.acquire(spec);
  await h.settle();
  return w;
}

async function engineOrder(h: Harness, spec: ViewSpec) {
  return h.truth.api.view.query({ spec, limit: 100 });
}

test('opening a window reads its rows in one Thread/get, in the stand-in engine order', async () => {
  const h = createHarness();
  try {
    const w = await open(h, HOME);
    const view = w.snapshot() as ViewResult<ThreadRow>;
    const truth = await engineOrder(h, HOME);
    assert.equal(view.status, 'live');
    assert.deepEqual(view.ids, truth.ids);
    assert.deepEqual(view.sections, truth.sections);
    assert.equal(view.total, truth.total);
    const gets = h.callsOf('Thread/get');
    assert.equal(gets.length, 1, 'one read for the whole window');
    assert.deepEqual([...(gets[0]!.args as { ids: string[] }).ids].sort(), [...truth.ids].sort());
    for (const id of view.ids) assert.ok(view.rows.get(id), `row ${id} is cached`);
  } finally {
    h.close();
  }
});

test('a frame with an unknown id triggers exactly one Thread/get, for that id only', async () => {
  const h = createHarness();
  try {
    const w = await open(h, HOME);
    const before = w.snapshot();
    h.clearCalls();
    const { threadId } = await h.control.deliverMail({
      accountId: before.rows.size
        ? (before.rows.get(before.ids[0]!) as ThreadRow).accountId
        : 'acc-work',
      fromName: 'Rowan Hale',
      from: 'rowan@field.example',
      subject: 'Venue walkthrough on Friday',
      body: 'Can you confirm 3 PM works for the walkthrough?',
      lane: 'do',
    });
    await h.control.advanceClock({ ms: 300 });
    await h.settle();
    const view = w.snapshot();
    assert.ok(view.ids.includes(threadId), 'the new thread is in the window');
    const gets = h.callsOf('Thread/get');
    assert.equal(gets.length, 1, `exactly one Thread/get, saw ${gets.length}`);
    assert.deepEqual((gets[0]!.args as { ids: string[] }).ids, [threadId]);
    assert.deepEqual(view.ids, (await engineOrder(h, HOME)).ids);
  } finally {
    h.close();
  }
});

test('row identity holds while rev is unchanged and moves when it changes', async () => {
  const h = createHarness();
  try {
    const w = await open(h, HOME);
    const first = w.snapshot() as ViewResult<ThreadRow>;
    const [a, b] = first.ids;
    const rowB = first.rows.get(b!);
    await h.truth.api.thread.act({
      opId: 'op-truth-1',
      ids: [a!],
      action: { type: 'flag', on: true },
    });
    await h.control.advanceClock({ ms: 300 });
    await h.settle();
    const next = w.snapshot() as ViewResult<ThreadRow>;
    assert.equal(next.rows.get(b!), rowB, 'an untouched row is the same object');
    assert.notEqual(next.rows.get(a!), first.rows.get(a!), 'a changed row is a new object');
    assert.equal(next.rows.get(a!)!.flagged, true);
  } finally {
    h.close();
  }
});

for (const reason of ['dbEpoch', 'cannotCalculateChanges', 'restart'] as const) {
  test(`a reset (${reason}) reopens every window, keeps the old ids meanwhile and re-reads`, async () => {
    const h = createHarness();
    try {
      const home = await open(h, HOME);
      const inbox = await open(h, INBOX);
      const ids = home.snapshot().ids;
      const oldWindow = home.windowId;
      const oldEpoch = home.snapshot().state!.dbEpoch;
      h.clearCalls();
      await h.control.reset({ reason });
      h.scheduler.flush();
      assert.equal(home.snapshot().status, 'reset');
      assert.deepEqual(home.snapshot().ids, ids, 'the previous ids stay on screen');
      await h.settle();
      assert.equal(home.snapshot().status, 'live');
      assert.equal(inbox.snapshot().status, 'live');
      assert.notEqual(home.windowId, oldWindow);
      assert.equal(h.callsOf('View/watch').length, 2, 'both windows reopened');
      assert.deepEqual(home.snapshot().ids, (await engineOrder(h, HOME)).ids);
      assert.deepEqual(inbox.snapshot().ids, (await engineOrder(h, INBOX)).ids);
      assert.ok(h.callsOf('Thread/get').length >= 1, 'rows re-read after the reset');
      if (reason === 'dbEpoch')
        assert.notEqual(home.snapshot().state!.dbEpoch, oldEpoch, 'a new epoch');
    } finally {
      h.close();
    }
  });
}

test('holdIds pin the order: frames queue, View/hold and View/release go out, release reconciles', async () => {
  const h = createHarness();
  try {
    const w = await open(h, HOME);
    const before = w.snapshot();
    h.clearCalls();
    w.setHold(1, before.ids.slice(0, 2));
    await h.settle();
    assert.equal(h.callsOf('View/hold').length, 1);
    assert.equal(h.callsOf('View/watch').length, 0, 'a hold never re-watches');
    const { threadId } = await h.control.deliverMail({
      accountId: (before.rows.get(before.ids[0]!) as ThreadRow).accountId,
      fromName: 'Ines Park',
      from: 'ines@harbor.example',
      subject: 'Signed lease attached',
      body: 'Please countersign by Thursday.',
      lane: 'do',
    });
    await h.control.advanceClock({ ms: 300 });
    await h.settle();
    assert.deepEqual(w.snapshot().ids, before.ids, 'the held order is rendered');
    assert.ok(w.waiting('do') + w.waiting('fromLater') >= 1, 'the arrival waits');
    w.setHold(1, []);
    await h.settle();
    assert.equal(h.callsOf('View/release').length, 1);
    assert.ok(w.snapshot().ids.includes(threadId), 'released: the queued frame applies');
    assert.deepEqual(w.snapshot().ids, (await engineOrder(h, HOME)).ids);
  } finally {
    h.close();
  }
});

test('move pages the window with View/move', async () => {
  const h = createHarness();
  try {
    const w = await open(h, INBOX);
    h.clearCalls();
    w.snapshot().move({ start: 2, end: 6 });
    await h.settle();
    const moves = h.callsOf('View/move');
    assert.equal(moves.length, 1);
    assert.deepEqual((moves[0]!.args as { anchor: unknown }).anchor, { position: 2 });
    const truth = await h.truth.api.view.query({ spec: INBOX, anchor: { position: 2 }, limit: 4 });
    assert.deepEqual(w.snapshot().ids, truth.ids);
    assert.equal(w.snapshot().position, 2);
  } finally {
    h.close();
  }
});

test('a window swept between a render and its effect: the store reads the window the effect acquired', async () => {
  const h = createHarness();
  try {
    const store = windowStore(h.layer.emitter, h.layer.windows, INBOX);
    const rendered = store.current();
    assert.equal(store.getSnapshot().status, 'opening');
    let woke = 0;
    const stop = store.subscribe(() => woke++);
    // An animation frame lands before the passive effect runs; its flush sweeps the unacquired window.
    h.layer.flush();
    const acquired = h.layer.windows.acquire(INBOX);
    assert.notEqual(acquired, rendered, "the render's window was swept");
    await h.settle();
    assert.equal(store.getSnapshot().status, 'live');
    assert.deepEqual(store.getSnapshot().ids, (await engineOrder(h, INBOX)).ids);
    assert.ok(woke > 0, 'the subscriber heard the acquired window open');
    stop();
  } finally {
    h.close();
  }
});

test('a reopen overtaking View/watch unwatches the engine window the stale watch made', async () => {
  const h = createHarness({ deferred: true });
  try {
    const w = h.layer.windows.acquire(HOME);
    w.reset();
    await h.settle();
    assert.equal(w.snapshot().status, 'live');
    assert.equal(h.callsOf('View/watch').length, 2);
    assert.equal(h.callsOf('View/unwatch').length, 1);
    assert.equal((await h.control.snapshot()).windows, 1, 'no orphan left at the engine');
  } finally {
    h.close();
  }
});
