/**
 * The seam's property test (plan 30 4.1 and U2 acceptance 3): seeded random sequences of optimistic commands,
 * receipts, window frames, resets, holds and undo against the stand-in engine, asserting after every sequence that
 * the cache converges to engine truth with no duplicate or lost row and no overlay left behind. The sequences cover
 * receipt before frame and frame before receipt (the engine's ordering knob), a reset mid-overlay, two windows holding
 * the same row (Home and the Inbox share rows), rejected and provider-refused writes, and undo of an undone operation.
 *
 * `cd apps/desktop && npx tsx --test src/renderer/data/property.test.ts`. `APLOS_PROPERTY_RUNS` overrides the 10,000
 * runs; `APLOS_PROPERTY_SEED` replays one seed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Id, OpId, ThreadAction, ThreadRow, ViewSpec } from './contract-shapes';
import { createHarness, type Harness } from './harness';
import { uniqueIds } from './windows';
import type { ActResult, ViewResult } from './index';
import type { EngineWindow } from './windows';

const RUNS = Number(process.env.APLOS_PROPERTY_RUNS ?? 10_000);
const ONLY_SEED = process.env.APLOS_PROPERTY_SEED;

const SPECS: readonly ViewSpec[] = [
  { kind: 'home' },
  { kind: 'mailbox', role: 'inbox' },
  { kind: 'later' },
  { kind: 'done' },
];

const ACTIONS: readonly ThreadAction[] = [
  { type: 'done' },
  { type: 'done' },
  { type: 'later' },
  { type: 'later', until: Date.UTC(2026, 9, 28, 17) },
  { type: 'trash' },
  { type: 'restore' },
  { type: 'read' },
  { type: 'unread' },
  { type: 'flag', on: true },
  { type: 'flag', on: false },
  { type: 'bookmark', on: true },
  { type: 'importance', importance: 'important' },
];

/** mulberry32: small, fast, seeded. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    pick: <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)]!,
    chance: (p: number) => next() < p,
  };
}

function assertNoDuplicates(w: EngineWindow, log: string[]) {
  const ids = w.snapshot().ids;
  assert.equal(
    new Set(ids).size,
    ids.length,
    `duplicate ids in ${w.key}: ${ids.join(',')} (engine: ${w.base?.ids.join(',')})\n${log.join('\n')}`,
  );
}

/** The races the plan names; each must occur in the run, or the property says nothing about it. */
const CASES = [
  'receiptBeforeFrame',
  'frameBeforeReceipt',
  'resetMidOverlay',
  'sharedRow',
  'heldFrames',
  'undoOfUndone',
  'undoOfUndo',
  'rejected',
  'providerRefused',
] as const;
type Case = (typeof CASES)[number];
const seen = new Map<Case, number>(CASES.map(c => [c, 0]));
const saw = (c: Case) => seen.set(c, seen.get(c)! + 1);

async function runSequence(seed: number): Promise<void> {
  const r = rng(seed);
  let ordering: 'receiptFirst' | 'frameFirst' | 'together' = 'receiptFirst';
  const h: Harness = createHarness({ seed: 1 + (seed % 7), checkResults: false });
  const log: string[] = [`seed ${seed}`];
  const ops: OpId[] = [];
  const results: ActResult[] = [];
  try {
    // Deferred frames ride the engine's fake clock (never a wall-clock task), so a run never waits on real time.
    await h.control.setOrdering({ ordering: { mode: 'receiptFirst', delayMs: 1 } });
    const windows = SPECS.map(spec => h.layer.windows.acquire(spec));
    const accountIds = (await h.truth.api.account.get({})).list.map(a => a.id);
    await h.settle();
    const steps = 6 + r.int(14);
    for (let step = 0; step < steps; step++) {
      const roll = r.next();
      if (roll < 0.34) {
        const w = r.pick(windows);
        const ids = w.snapshot().ids;
        if (!ids.length) continue;
        const target = r.pick(ids);
        const action = r.pick(ACTIONS);
        const shared = windows.filter(win => win.snapshot().ids.includes(target)).length > 1;
        const result = h.layer.api.thread.act({ ids: [target], action });
        ops.push(result.opId);
        results.push(result);
        if (shared) saw('sharedRow');
        if (ordering === 'receiptFirst') saw('receiptBeforeFrame');
        if (ordering === 'frameFirst') saw('frameBeforeReceipt');
        log.push(`act ${action.type} ${target} in ${w.spec.kind}`);
      } else if (roll < 0.37) {
        const home = windows[0]!;
        const view = home.snapshot();
        const section = r.pick(view.sections.filter(s => s.key !== 'low'))?.key;
        if (!view.state || !section) continue;
        const result = h.layer.api.thread.act({
          selector: { spec: SPECS[0] as { kind: 'home' }, section, atState: view.state },
          action: { type: 'later' },
        });
        ops.push(result.opId);
        results.push(result);
        log.push(`act later on section ${section}`);
      } else if (roll < 0.55) {
        const ms = r.int(700);
        await h.control.advanceClock({ ms });
        log.push(`clock +${ms}`);
      } else if (roll < 0.68) {
        await h.settle();
        log.push('settle');
      } else if (roll < 0.72) {
        h.scheduler.flush();
        log.push('flush');
      } else if (roll < 0.76) {
        const reason = r.pick(['dbEpoch', 'cannotCalculateChanges', 'restart'] as const);
        if (h.layer.overlay.entries.length) saw('resetMidOverlay');
        await h.control.reset({ reason });
        log.push(`reset ${reason}`);
      } else if (roll < 0.84) {
        const outcome = h.layer.undoStack.undoLast();
        if (outcome?.kind === 'operation') {
          ops.push(outcome.result.opId);
          results.push(outcome.result);
        }
        log.push(`undo last -> ${outcome?.kind === 'operation' ? outcome.opId : 'none'}`);
      } else if (roll < 0.87) {
        // Undo an operation that may already be undone, or undo an undo.
        if (!ops.length) continue;
        const opId = r.pick(ops);
        const record = h.layer.operations.get(opId);
        if (record?.undoneBy) saw('undoOfUndone');
        if (record?.kind === 'undo') saw('undoOfUndo');
        const result = h.layer.api.operation.undo({ opId });
        ops.push(result.opId);
        results.push(result);
        log.push(`undo ${opId}`);
      } else if (roll < 0.91) {
        const mode = r.pick(['reject', 'afterReceipt'] as const);
        await h.control.failNextWrite({
          mode,
          type: 'conflict',
          message: 'The change could not be saved.',
          afterMs: 100 + r.int(600),
        });
        log.push(`fail next ${mode}`);
      } else if (roll < 0.95) {
        const mode = r.pick(['receiptFirst', 'frameFirst', 'together'] as const);
        const delayMs = mode === 'together' ? undefined : 1 + r.int(300);
        await h.control.setOrdering({ ordering: { mode, ...(delayMs ? { delayMs } : {}) } });
        ordering = mode;
        log.push(`ordering ${mode} ${delayMs ?? ''}`);
      } else if (roll < 0.98) {
        const w = windows[r.int(2)]!;
        if (w.held) {
          w.setHold(99, []);
          log.push(`release hold ${w.spec.kind}`);
        } else {
          const ids = w.snapshot().ids;
          w.setHold(99, ids.slice(0, 3));
          log.push(`hold ${w.spec.kind}`);
        }
      } else {
        const base = windows[0]!.snapshot();
        const id = base.ids[0];
        const row = id ? (base.rows.get(id) as ThreadRow | undefined) : undefined;
        if (r.chance(0.5) && row) {
          await h.control.rerank({
            threadId: row.id,
            lane: r.pick(['do', 'update', 'low'] as const),
          });
          log.push(`rerank ${row.id}`);
        } else {
          await h.control.deliverMail({
            accountId: row?.accountId ?? r.pick(accountIds),
            fromName: 'Rowan Hale',
            from: 'rowan@field.example',
            subject: `Update ${step}`,
            body: 'A short note.',
            lane: 'do',
          });
          log.push('deliver');
        }
      }
      for (const w of windows) {
        assertNoDuplicates(w, log);
        if (w.held && w.waiting(null) > 0) saw('heldFrames');
      }
    }

    // Quiesce: release holds, deliver everything the engine holds back, sync every queued write.
    for (const w of windows) w.setHold(99, []);
    await h.control.setOrdering({ ordering: { mode: 'together' } });
    for (let i = 0; i < 5; i++) {
      await h.control.advanceClock({ ms: 1_000 });
      await h.settle();
    }
    await Promise.allSettled(results.map(result => result.receipt));
    await h.settle();

    const context = () => log.join('\n');
    for (const w of windows) {
      const view = w.snapshot() as ViewResult<ThreadRow>;
      // The stand-in can list a follow-up thread in two Home sections; the data layer shows it once.
      const { windowId: _windowId, ...answer } = await h.truth.api.view.query({
        spec: w.spec,
        limit: 100,
      });
      const truth = uniqueIds({ ...answer, windowId: '' });
      assert.equal(view.status, 'live', `${w.key} is live\n${context()}`);
      assertNoDuplicates(w, log);
      assert.deepEqual(view.ids, truth.ids, `${w.key} order equals the engine's\n${context()}`);
      assert.equal(view.total, truth.total, `${w.key} total\n${context()}`);
      assert.deepEqual(view.sections, truth.sections, `${w.key} sections\n${context()}`);
      if (truth.ids.length) {
        const { list } = await h.truth.api.thread.get({ ids: truth.ids });
        const rows = new Map<Id, ThreadRow>(list.map(row => [row.id, row]));
        for (const id of truth.ids)
          assert.deepEqual(
            view.rows.get(id),
            rows.get(id),
            `row ${id} in ${w.key} is the engine's\n${context()}`,
          );
      }
    }
    assert.equal(h.layer.overlay.entries.length, 0, `the overlay is empty\n${context()}`);
    for (const record of h.layer.operations.all()) {
      assert.notEqual(record.state, 'pending', `${record.opId} settled\n${context()}`);
      if (record.state === 'failed') saw('rejected');
      if (h.layer.rows.get('Operation', record.opId)?.state === 'failed') saw('providerRefused');
    }
  } finally {
    h.close();
  }
}

/** Sequences are independent (each has its own engine and data layer), so a few run at once while others wait on timers. */
const CONCURRENCY = 8;

test(`the cache converges to engine truth over ${ONLY_SEED ?? RUNS} seeded sequences`, async () => {
  if (ONLY_SEED) {
    await runSequence(Number(ONLY_SEED));
    return;
  }
  let next = 1;
  let failed = false;
  const worker = async () => {
    while (!failed && next <= RUNS) {
      const seed = next++;
      try {
        await runSequence(seed);
      } catch (error) {
        failed = true;
        throw error instanceof Error
          ? Object.assign(error, { message: `seed ${seed}: ${error.message}` })
          : error;
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log(`property cases over ${RUNS} sequences: ${JSON.stringify(Object.fromEntries(seen))}`);
  for (const c of CASES) assert.ok(seen.get(c)! > 0, `the sequences exercised ${c}`);
});
