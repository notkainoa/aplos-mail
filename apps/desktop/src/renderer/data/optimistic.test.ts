/**
 * The optimistic overlay, operations and the undo stack on the stand-in engine (DESIGN 5 rules 1 and 11). Node, no
 * DOM: `cd apps/desktop && npx tsx --test src/renderer/data/optimistic.test.ts`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import type { ThreadRow, ViewSpec } from './contract-shapes';
import { createHarness, type Harness, type HarnessOptions } from './harness';
import { operationStore, rowStore, topicStore, windowStore } from './hooks';
import { OperationFailedError, type ViewResult } from './index';
import { specKey } from './optimistic';
import type { DataLayer } from './layer';
import type { EngineWindow } from './windows';

const HOME = { kind: 'home' } as const satisfies ViewSpec;
const INBOX = { kind: 'mailbox', role: 'inbox' } as const satisfies ViewSpec;
const KEY_TO_STATE_MS = 8;

async function boot(options: HarnessOptions = {}) {
  const h = createHarness(options);
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

/**
 * What mounted hooks do on every notification: React calls each woken store's `getSnapshot`. Per visible row: a row
 * hook and an operation toast; per window: `copies` views. Returns how many listeners woke since the last read.
 */
function mountHooks(layer: DataLayer, windows: readonly ViewSpec[], copies: number) {
  let woke = 0;
  const stops: Array<() => void> = [];
  const mount = (store: {
    subscribe: (l: () => void) => () => void;
    getSnapshot: () => unknown;
  }) => {
    store.getSnapshot();
    stops.push(
      store.subscribe(() => {
        woke++;
        store.getSnapshot();
      }),
    );
  };
  const ids = new Set<string>();
  for (let c = 0; c < copies; c++)
    for (const spec of windows) {
      const store = windowStore(layer.emitter, layer.windows, spec);
      for (const id of store.getSnapshot().ids) ids.add(id);
      mount(store);
    }
  for (let c = 0; c < copies; c++)
    for (const id of ids) {
      mount(rowStore(layer, 'Thread', id));
      mount(operationStore(layer, `op-elsewhere-${id}`));
    }
  mount(
    topicStore(
      layer.emitter,
      t => t.has('session'),
      () => layer.session.settings,
    ),
  );
  return {
    count: stops.length,
    woke: () => {
      const n = woke;
      woke = 0;
      return n;
    },
    stop: () => stops.forEach(stop => stop()),
  };
}

test('act() applies the overlay synchronously, in both windows', async () => {
  const { h, home, inbox } = await boot();
  try {
    const target = home.snapshot().ids.find(id => inbox.snapshot().ids.includes(id))!;
    assert.ok(target, 'a row in both Home and the Inbox');
    const { opId, receipt } = h.layer.api.thread.act({ ids: [target], action: { type: 'done' } });
    assert.ok(!rowsOf(home).ids.includes(target), 'gone from Home before act() returned');
    assert.ok(!rowsOf(inbox).ids.includes(target), 'gone from the Inbox too (Done archives)');
    assert.equal(h.layer.operations.view(opId)!.state, 'pending');
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

test('act() wakes only the windows and the target row hooks', async () => {
  const { h, home } = await boot({ deferred: true });
  const hooks = mountHooks(h.layer, [HOME, INBOX], 1);
  try {
    const target = home.snapshot().ids[0]!;
    hooks.woke();
    h.layer.api.thread.act({ ids: [target], action: { type: 'read' } });
    // Two windows and the target's row hook; never the other rows, toasts or settings.
    assert.equal(hooks.woke(), 3);
    await catchUp(h);
  } finally {
    hooks.stop();
    h.close();
  }
});

test('key to state: act() and the woken snapshots stay under 8 ms at p95 with hundreds of hooks mounted', async () => {
  // A deferred transport, as in the app, so the timing is the data layer's own synchronous work and not the stand-in's.
  // CPU time, not wall time: a loaded test machine preempts the thread. APLOS_PERF=1 also checks wall time.
  const { h, home } = await boot({ deferred: true });
  const hooks = mountHooks(h.layer, [HOME, INBOX], 28);
  try {
    assert.ok(hooks.count >= 400, `${hooks.count} hooks mounted`);
    const ids = home.snapshot().ids;
    const cpu: number[] = [];
    const wall: number[] = [];
    for (let i = 0; i < 340; i++) {
      const id = ids[i % ids.length]!;
      const startCpu = process.cpuUsage();
      const start = performance.now();
      h.layer.api.thread.act({ ids: [id], action: { type: i % 2 ? 'read' : 'unread' } });
      const took = performance.now() - start;
      const used = process.cpuUsage(startCpu);
      if (i >= 40) {
        cpu.push((used.user + used.system) / 1000);
        wall.push(took);
      }
      if (i % 25 === 24) await catchUp(h, 300);
    }
    const p95 = (samples: number[]) =>
      [...samples].sort((a, b) => a - b)[Math.floor(samples.length * 0.95)]!;
    assert.ok(p95(cpu) < KEY_TO_STATE_MS, `p95 ${p95(cpu).toFixed(2)} ms of CPU`);
    if (process.env.APLOS_PERF)
      assert.ok(p95(wall) < KEY_TO_STATE_MS, `p95 ${p95(wall).toFixed(2)} ms wall`);
  } finally {
    hooks.stop();
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
    assert.ok(!h.layer.failures.has(target), 'the retry went through: the error clears');
    await catchUp(h);
    assert.ok(!rowsOf(home).failures.has(target));
    assert.deepEqual(home.snapshot().ids, await truthIds(h, HOME));
    assert.equal(h.layer.overlay.entries.length, 0);
  } finally {
    h.close();
  }
});

test('a quiet act is sent like any other but is not on the undo stack, so Z still undoes the owner’s own change', async () => {
  const { h, home } = await boot();
  try {
    const [first, second] = home.snapshot().ids;
    const done = h.layer.api.thread.act({ ids: [first!], action: { type: 'done' } });
    const read = h.layer.api.thread.act({
      ids: [second!],
      action: { type: 'read' },
      quiet: true,
    });
    await Promise.all([done.receipt, read.receipt]);
    assert.equal(h.callsOf('Thread/act').length, 2, 'the quiet write reached the engine');
    assert.equal(h.layer.undoStack.peek()?.kind, 'operation');
    const top = h.layer.undoStack.peek();
    assert.equal(top?.kind === 'operation' ? top.opId : null, done.opId, 'Z undoes the Done');
    await catchUp(h);
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

test("a refused row's Retry goes through Operation/retry, and an undo after it shows no stale error", async () => {
  const { h, home } = await boot();
  try {
    await h.control.failNextWrite({
      mode: 'afterReceipt',
      type: 'conflict',
      message: 'Refused by the provider.',
      afterMs: 600,
    });
    const target = home.snapshot().ids[0]!;
    const { opId, receipt } = h.layer.api.thread.act({ ids: [target], action: { type: 'done' } });
    await receipt;
    await catchUp(h, 300);
    await catchUp(h, 400);
    const failure = rowsOf(home).failures.get(target);
    assert.ok(failure, 'refused: the row carries the error');
    h.clearCalls();
    const again = failure.retry();
    assert.equal(again.opId, opId, 'the same operation, not a fresh action');
    assert.ok(!rowsOf(home).failures.has(target), 'the error clears at once');
    await again.receipt;
    assert.equal(h.callsOf('Operation/retry').length, 1);
    assert.equal(h.callsOf('Thread/act').length, 0);
    await catchUp(h);
    assert.notEqual(h.layer.operations.view(opId)!.remote, 'failed');
    assert.deepEqual(home.snapshot().ids, await truthIds(h, HOME));

    const undone = h.layer.api.operation.undo({ opId });
    await undone.receipt;
    await catchUp(h);
    assert.ok(home.snapshot().ids.includes(target), 'undone: back in Home');
    assert.equal(rowsOf(home).failures.has(target), false, 'with no stale error');
    assert.equal(h.layer.failures.size, 0);
  } finally {
    h.close();
  }
});

test('an undone Later takes the row out of Later at once while it puts it back in Home', async () => {
  const LATER = { kind: 'later' } as const satisfies ViewSpec;
  const { h, home } = await boot();
  const later = h.layer.windows.acquire(LATER);
  await h.settle();
  try {
    const target = home.snapshot().ids[0]!;
    const moved = h.layer.api.thread.act({ ids: [target], action: { type: 'later' } });
    await moved.receipt;
    await catchUp(h);
    assert.ok(later.snapshot().ids.includes(target), 'in Later');
    await h.control.setOrdering({ ordering: { mode: 'receiptFirst', delayMs: 300 } });
    const undone = h.layer.api.operation.undo({ opId: moved.opId });
    assert.ok(home.snapshot().ids.includes(target), 'back in Home at once');
    assert.ok(!later.snapshot().ids.includes(target), 'and out of Later at once');
    await undone.receipt;
    await h.settle();
    assert.ok(later.base!.ids.includes(target), 'the frame has not come yet');
    assert.ok(!later.snapshot().ids.includes(target), 'no copy lingers meanwhile');
    await catchUp(h, 400);
    assert.deepEqual(later.snapshot().ids, await truthIds(h, LATER));
    assert.deepEqual(home.snapshot().ids, await truthIds(h, HOME));
    assert.equal(h.layer.overlay.entries.length, 0);
  } finally {
    h.close();
  }
});

test("the Inbox prediction follows the owner's Done setting with no settings hook mounted", async () => {
  const h = createHarness();
  const inbox = h.layer.windows.acquire(INBOX);
  await h.settle();
  try {
    await h.truth.api.settings.set({
      opId: 'op-done-reads',
      patch: { mail: { doneAction: 'read' } },
    });
    await catchUp(h);
    assert.equal(h.layer.session.settings?.mail.doneAction, 'read');
    const target = inbox.snapshot().ids[0]!;
    const { receipt } = h.layer.api.thread.act({ ids: [target], action: { type: 'done' } });
    assert.ok(inbox.snapshot().ids.includes(target), 'Done marks it read here, so it stays');
    await receipt;
    await catchUp(h);
    assert.deepEqual(inbox.snapshot().ids, await truthIds(h, INBOX));
  } finally {
    h.close();
  }
});

test('operation rows are held only while their record is remembered; a reset re-reads only those', async () => {
  const { h, home } = await boot();
  try {
    const ids = home.snapshot().ids;
    const opIds: string[] = [];
    for (let i = 0; i < 12; i++) {
      const r = h.layer.api.thread.act({
        ids: [ids[i % ids.length]!],
        action: { type: i % 2 ? 'read' : 'unread' },
      });
      opIds.push(r.opId);
      await r.receipt;
    }
    await catchUp(h);
    assert.equal(h.layer.rows.size('Operation'), 12);
    for (const opId of opIds.slice(0, 10)) h.layer.operations.forget(opId);
    assert.equal(h.layer.rows.size('Operation'), 2);
    h.clearCalls();
    await h.control.reset({ reason: 'restart' });
    await h.settle();
    const read = h.callsOf('Operation/get').flatMap(c => (c.args as { opIds: string[] }).opIds);
    assert.deepEqual(read.sort(), opIds.slice(10).sort());
  } finally {
    h.close();
  }
});

test('specKey separates two search queries and ignores key order at every depth', () => {
  const search = (text: string) =>
    ({ kind: 'search', query: { text } }) as const satisfies ViewSpec;
  assert.notEqual(specKey(search('dentist')), specKey(search('zebra')));
  assert.equal(
    specKey({ kind: 'mailbox', role: 'inbox', accountId: 'a1' }),
    specKey({ accountId: 'a1', role: 'inbox', kind: 'mailbox' }),
  );
  assert.equal(specKey(search('dentist')), specKey({ query: { text: 'dentist' }, kind: 'search' }));
});
