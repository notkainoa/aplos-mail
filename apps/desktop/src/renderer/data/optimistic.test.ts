/**
 * The optimistic overlay, operations and the undo stack on the stand-in engine (DESIGN 5 rules 1 and 11). Node, no
 * DOM: `cd apps/desktop && npx tsx --test src/renderer/data/optimistic.test.ts`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import type { ThreadRow, ViewSpec } from './contract-shapes';
import { createHarness, type Harness } from './harness';
import { OperationFailedError, type ViewResult } from './index';
import type { EngineWindow } from './windows';

const HOME = { kind: 'home' } as const satisfies ViewSpec;
const INBOX = { kind: 'mailbox', role: 'inbox' } as const satisfies ViewSpec;
const KEY_TO_STATE_MS = 8;

async function boot() {
  const h = createHarness();
  const home = h.layer.windows.acquire(HOME);
  const inbox = h.layer.windows.acquire(INBOX);
  h.layer.session.want('settings');
  await h.settle();
  return { h, home, inbox };
}

const rowsOf = (w: EngineWindow) => w.snapshot() as ViewResult<ThreadRow>;

async function truthIds(h: Harness, spec: ViewSpec) {
  return (await h.truth.api.view.query({ spec, limit: 100 })).ids;
}

/** Advance the engine past its frame throttle and provider sync, then let everything land. */
async function catchUp(h: Harness, ms = 700) {
  await h.control.advanceClock({ ms });
  await h.settle();
}

test('act() applies the overlay synchronously, in both windows, within the key-to-state budget', async () => {
  const { h, home, inbox } = await boot();
  try {
    const target = home.snapshot().ids.find(id => inbox.snapshot().ids.includes(id))!;
    assert.ok(target, 'a row in both Home and the Inbox');
    const start = performance.now();
    const { opId, receipt } = h.layer.api.thread.act({ ids: [target], action: { type: 'done' } });
    const homeNow = rowsOf(home);
    const inboxNow = rowsOf(inbox);
    const took = performance.now() - start;
    assert.ok(!homeNow.ids.includes(target), 'gone from Home before act() returned');
    assert.ok(!inboxNow.ids.includes(target), 'gone from the Inbox too (Done archives)');
    assert.equal(h.layer.operations.view(opId)!.state, 'pending');
    assert.ok(took < KEY_TO_STATE_MS, `key to state took ${took.toFixed(2)} ms`);
    await receipt;
    await catchUp(h);
    assert.equal(
      h.layer.overlay.entries.length,
      0,
      'the overlay dropped once the windows caught up',
    );
    assert.deepEqual(home.snapshot().ids, await truthIds(h, HOME));
    assert.equal(h.layer.operations.view(opId)!.state, 'confirmed');
  } finally {
    h.close();
  }
});

test('key to state stays under 8 ms at p95 over 300 triage keys', async () => {
  const { h, home, inbox } = await boot();
  try {
    const ids = home.snapshot().ids;
    const samples: number[] = [];
    for (let i = 0; i < 300; i++) {
      const id = ids[i % ids.length]!;
      const start = performance.now();
      h.layer.api.thread.act({ ids: [id], action: { type: i % 2 ? 'read' : 'unread' } });
      rowsOf(home).rows.get(id);
      rowsOf(inbox);
      samples.push(performance.now() - start);
      if (i % 25 === 24) await catchUp(h, 300);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95)]!;
    assert.ok(p95 < KEY_TO_STATE_MS, `p95 ${p95.toFixed(2)} ms`);
  } finally {
    h.close();
  }
});

test('receipt before frame: the overlay holds until a frame reaches the applied state', async () => {
  const { h, home } = await boot();
  try {
    await h.control.setOrdering({ ordering: { mode: 'receiptFirst', delayMs: 120 } });
    const target = home.snapshot().ids[0]!;
    const { receipt } = h.layer.api.thread.act({ ids: [target], action: { type: 'later' } });
    const r = await receipt;
    await h.settle();
    assert.ok(home.base!.ids.includes(target), 'the frame has not come yet');
    assert.ok(!home.snapshot().ids.includes(target), 'the overlay still hides it');
    assert.equal(h.layer.overlay.entries.length, 1);
    await catchUp(h, 400);
    assert.ok(home.base!.state.seq >= r.appliedState.seq);
    assert.equal(h.layer.overlay.entries.length, 0);
    assert.deepEqual(home.snapshot().ids, await truthIds(h, HOME));
  } finally {
    h.close();
  }
});

test('frame before receipt: a pending entry keeps applying, then drops with the receipt', async () => {
  const { h, home } = await boot();
  try {
    await h.control.setOrdering({ ordering: { mode: 'frameFirst', delayMs: 120 } });
    const target = home.snapshot().ids[1]!;
    const { opId, receipt } = h.layer.api.thread.act({ ids: [target], action: { type: 'done' } });
    await h.settle();
    assert.ok(!home.base!.ids.includes(target), 'the frame already moved the row');
    assert.equal(h.layer.operations.view(opId)!.state, 'pending');
    assert.ok(!home.snapshot().ids.includes(target));
    await h.control.advanceClock({ ms: 200 });
    await receipt;
    await catchUp(h);
    assert.equal(h.layer.overlay.entries.length, 0);
    assert.deepEqual(home.snapshot().ids, await truthIds(h, HOME));
  } finally {
    h.close();
  }
});

test('a rejected write returns the row to its place with an inline error, and Retry acts again', async () => {
  const { h, home } = await boot();
  try {
    await h.control.failNextWrite({
      mode: 'reject',
      type: 'conflict',
      message: "Couldn't move to Later.",
    });
    const ids = home.snapshot().ids;
    const target = ids[2]!;
    const { opId, receipt } = h.layer.api.thread.act({ ids: [target], action: { type: 'later' } });
    assert.ok(!home.snapshot().ids.includes(target));
    await assert.rejects(
      receipt,
      (e: unknown) => e instanceof OperationFailedError && e.opId === opId,
    );
    await h.settle();
    const after = rowsOf(home);
    assert.deepEqual(after.ids, ids, 'back in its place');
    const failure = after.failures.get(target);
    assert.ok(failure, 'the row carries its failure');
    assert.equal(failure.message, "Couldn't move to Later.");
    assert.equal(h.layer.operations.view(opId)!.state, 'failed');
    assert.equal(h.layer.undoStack.peek(), null, 'a failed write is not undoable');
    const again = failure.retry();
    assert.notEqual(again.opId, opId, 'Retry is a fresh operation');
    assert.ok(!home.snapshot().ids.includes(target), 'the overlay re-applies at once');
    assert.ok(!rowsOf(home).failures.has(target));
    await again.receipt;
    await catchUp(h);
    assert.deepEqual(home.snapshot().ids, await truthIds(h, HOME));
  } finally {
    h.close();
  }
});

test('a provider refusal after the receipt puts the row back in place and offers Operation/retry', async () => {
  const { h, home } = await boot();
  try {
    await h.control.failNextWrite({
      mode: 'afterReceipt',
      type: 'conflict',
      message: "Couldn't mark as done.",
      afterMs: 600,
    });
    const ids = home.snapshot().ids;
    const target = ids[0]!;
    const { opId, receipt } = h.layer.api.thread.act({ ids: [target], action: { type: 'done' } });
    await receipt;
    await catchUp(h, 300);
    assert.ok(!home.snapshot().ids.includes(target));
    await catchUp(h, 400);
    assert.deepEqual(home.snapshot().ids, ids, 'back where it was');
    assert.equal(rowsOf(home).failures.get(target)?.message, "Couldn't mark as done.");
    await h.settle();
    const view = h.layer.operations.view(opId)!;
    assert.equal(view.state, 'confirmed');
    assert.equal(view.remote, 'failed');
    h.clearCalls();
    const retried = view.retry();
    assert.equal(retried.opId, opId, 'same operation');
    await retried.receipt;
    assert.equal(h.callsOf('Operation/retry').length, 1);
    await catchUp(h);
    assert.deepEqual(home.snapshot().ids, await truthIds(h, HOME));
    assert.equal(h.layer.overlay.entries.length, 0);
  } finally {
    h.close();
  }
});

test('Z undoes with an inverse operation, the row returns at once; undoing it again is refused; undoing the undo redoes', async () => {
  const { h, home } = await boot();
  try {
    const ids = home.snapshot().ids;
    const target = ids[3]!;
    const done = h.layer.api.thread.act({ ids: [target], action: { type: 'done' } });
    await done.receipt;
    await catchUp(h);
    assert.ok(!home.snapshot().ids.includes(target));
    assert.deepEqual(h.layer.undoStack.peek(), {
      kind: 'operation',
      id: 'undo-t2',
      opId: done.opId,
    });

    const outcome = h.layer.undoStack.undoLast();
    assert.equal(outcome?.kind, 'operation');
    assert.deepEqual(home.snapshot().ids, ids, 'back in place before the engine answers');
    const undone = outcome.kind === 'operation' ? outcome.result : undefined;
    await undone!.receipt;
    assert.equal(h.callsOf('Operation/undo').length, 1);
    await catchUp(h);
    assert.deepEqual(home.snapshot().ids, await truthIds(h, HOME));
    assert.deepEqual(home.snapshot().ids, ids);
    assert.equal(h.layer.undoStack.peek(), null, 'nothing left to undo');
    assert.equal(h.layer.operations.view(done.opId)!.undoable, false);

    // The engine treats a repeated undo of one operation as a replay of the first (idempotent by opId).
    const twice = h.layer.api.operation.undo({ opId: done.opId });
    assert.deepEqual(home.snapshot().ids, ids, 'no overlay for an operation already undone');
    assert.equal(h.layer.overlay.entries.length, 0);
    assert.deepEqual((await twice.receipt).appliedState, (await undone!.receipt).appliedState);

    const redo = h.layer.api.operation.undo({ opId: undone!.opId });
    assert.ok(!home.snapshot().ids.includes(target), 'undoing the undo applies Done again at once');
    await redo.receipt;
    await catchUp(h);
    assert.deepEqual(home.snapshot().ids, await truthIds(h, HOME));
    assert.equal(h.layer.overlay.entries.length, 0);
  } finally {
    h.close();
  }
});

test('one undo stack: Z takes the newest entry of either kind', async () => {
  const { h, home } = await boot();
  try {
    const undone: string[] = [];
    h.layer.undoStack.push({ label: 'Done is now L', undo: () => void undone.push('remap') });
    assert.equal(h.layer.undoStack.peek()?.kind, 'local');
    const act = h.layer.api.thread.act({
      ids: [home.snapshot().ids[0]!],
      action: { type: 'later' },
    });
    assert.deepEqual(h.layer.undoStack.peek(), {
      kind: 'operation',
      id: 'undo-t3',
      opId: act.opId,
    });
    const first = h.layer.undoStack.undoLast();
    assert.equal(first?.kind, 'operation');
    const second = h.layer.undoStack.undoLast();
    assert.equal(second?.kind, 'local');
    if (second?.kind === 'local') await second.done;
    assert.deepEqual(undone, ['remap']);
    assert.equal(h.layer.undoStack.undoLast(), null);
    await h.settle();
  } finally {
    h.close();
  }
});

test('a selector over a section empties it at once and counts it as zero', async () => {
  const { h, home } = await boot();
  try {
    const view = home.snapshot();
    const update = view.sections.find(s => s.key === 'update');
    assert.ok(update && update.count > 0, 'Important updates has rows');
    const { receipt } = h.layer.api.thread.act({
      selector: { spec: HOME, section: 'update', atState: view.state! },
      action: { type: 'done' },
    });
    const now = home.snapshot();
    assert.equal(
      now.sections.find(s => s.key === 'update'),
      undefined,
      'the section is gone',
    );
    assert.equal(now.total, view.total - update.count);
    await receipt;
    await catchUp(h);
    assert.deepEqual(home.snapshot().ids, await truthIds(h, HOME));
    assert.equal(h.layer.overlay.entries.length, 0);
  } finally {
    h.close();
  }
});
