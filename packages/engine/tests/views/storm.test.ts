import test from 'node:test';
import assert from 'node:assert/strict';
import type { Frame } from '@aplos/contract';
import type { MessageWrite } from '../../src/store';
import { BIG_NOW, populate } from './big';
import { openStore } from '../../src/store';
import { tempDb } from '../store/helpers';
import { incoming, openEngine, patch, worldEngine, type WindowFrame } from './harness';
import { HOLD_LAPSE_MS } from '../../src/views/holds';

/*
 * views-2's storm check (plan 10 E3 (a)): a backfill of coarse commits with three windows open. No window may send more
 * than four frames in any second, a coarse commit costs one fan-out and not a pass over its rows, a held row never
 * moves, and when the storm ends the windows settle on exactly what a fresh read gives.
 */

const MESSAGES = Number(process.env.APLOS_VIEWS_STORM ?? 100_000);
const PAGE = 500;
const PAGE_EVERY_MS = 100;
/** The owner works on a row for the first pages of the storm, then stops; the hold lapses with the storm still going. */
const HOLD_PAGES = 10;

function backfillPage(page: number): MessageWrite[] {
  const out: MessageWrite[] = [];
  for (let i = 0; i < PAGE; i++) {
    const n = page * PAGE + i;
    const thread = `bf${Math.floor(n / 2)}`;
    out.push(
      incoming(thread, {
        accountId: n % 5 === 0 ? 'imap:2' : 'acct-1',
        remoteId: `bf-m${n}`,
        // Newer than the whole mailbox, so every page pushes the inbox's top row down unless it is held.
        date: BIG_NOW + n,
        seen: n % 3 === 0,
        folder: n % 5 === 0 || n % 2 ? 'INBOX' : 'Label_1',
      }),
    );
  }
  return out;
}

/** The most frames any one second holds, from the times they arrived. */
function busiestSecond(times: number[]): number {
  let best = 0;
  for (const [i, from] of times.entries()) {
    let n = 0;
    for (let j = i; j < times.length && times[j]! < from + 1_000; j++) n++;
    best = Math.max(best, n);
  }
  return best;
}

test(`a ${MESSAGES}-message backfill with three windows open stays under four frames a second`, async () => {
  const t = await worldEngine(3, 300);
  try {
    const specs = [
      { kind: 'mailbox', role: 'inbox' },
      { kind: 'home' },
      { kind: 'mailbox', role: 'all' },
    ] as const;
    const wins = [];
    for (const spec of specs) wins.push(await t.call('View/watch', { spec }));
    const arrivals = new Map<string, number[]>(wins.map(w => [w.windowId, []]));
    t.session.subscribe((f: Frame) => {
      if (f.frame === 'window') arrivals.get(f.windowId)?.push(t.clock.now());
    });
    const held = wins[0]!.ids[0]!;
    await t.call('View/hold', { windowId: wins[0]!.windowId, ids: [held] });
    const reruns0 = t.views.stats.reruns;

    const pages = MESSAGES / PAGE;
    const pingPages = Math.min(HOLD_PAGES, Math.ceil(pages / 2));
    let lastPing = t.clock.now();
    let widest = 0;
    for (let p = 0; p < pages; p++) {
      const before = t.store.seq();
      t.store.commit({
        opId: `backfill-${p}`,
        origin: 'sync',
        step: 'backfill',
        changes: 'coarse',
        writes: backfillPage(p),
      });
      const rows = t.store.changesSince(before).status === 'ok' ? changeRows(t.store, before) : 0;
      widest = Math.max(widest, rows);
      if (p < pingPages) {
        await t.call('View/hold', { windowId: wins[0]!.windowId, ids: [held] });
        lastPing = t.clock.now();
      }
      await t.advance(PAGE_EVERY_MS);
      if (p === pingPages - 1) {
        const top = await t.call('View/query', { spec: specs[0], limit: 1 });
        assert.notEqual(top.ids[0], held, 'without the hold the storm would have moved the row');
      }
    }
    assert.ok(widest <= 12, `a coarse page writes a handful of change rows, saw ${widest}`);

    const seconds = (pages * PAGE_EVERY_MS) / 1_000;
    for (const w of wins) {
      const times = arrivals.get(w.windowId)!;
      assert.ok(times.length > 0, 'the storm reaches every window');
      assert.ok(busiestSecond(times) <= 4, `${busiestSecond(times)} frames in one second`);
      assert.ok(times.length <= seconds * 4 + 1, `${times.length} frames in ${seconds}s`);
    }
    const reruns = t.views.stats.reruns - reruns0;
    assert.ok(
      reruns <= wins.length * (seconds * 4 + 2),
      `${reruns} re-runs for ${pages} commits: coalesced, not one per page`,
    );
    assert.ok(reruns < pages * wins.length, 'fewer re-runs than commit-window pairs');

    const lapsesAt = lastPing + HOLD_LAPSE_MS;
    const heldTimes = arrivals.get(wins[0]!.windowId)!;
    t.windowFrames(wins[0]!.windowId).forEach((f, i) => {
      if (heldTimes[i]! < lapsesAt) {
        assert.equal(f.ids[0], held, 'a held row never moves while the owner is working');
        assert.deepEqual(f.held, [held]);
      } else {
        assert.equal(f.held, undefined, 'once the hold lapsed the window is not holding');
      }
    });
    if (pages * PAGE_EVERY_MS > HOLD_LAPSE_MS * 2)
      assert.ok(
        heldTimes.some(at => at >= lapsesAt),
        'the hold lapsed under load and the window reconciled while the storm went on',
      );

    await t.advance(5_000);
    for (const [i, spec] of specs.entries()) {
      const last = t.windowFrames(wins[i]!.windowId).at(-1) as WindowFrame;
      const fresh = await t.call('View/query', { spec, limit: 100 });
      assert.deepEqual(last.ids, fresh.ids, `${spec.kind} settles on the fresh read`);
      assert.equal(last.total, fresh.total);
    }
  } finally {
    await t.close();
  }
});

function changeRows(store: { changesSince(seq: number): { status: string } }, since: number) {
  const page = store.changesSince(since) as { status: string; changes?: unknown[] };
  return page.changes?.length ?? 0;
}

// ---------------------------------------------------------------- budgets (opt-in)

const TIMINGS = process.env.APLOS_VIEWS_TIMINGS;
const THREADS = Number(process.env.APLOS_VIEWS_THREADS ?? 100_000);

const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.95)]!;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const ms = (n: number) => `${n.toFixed(2)} ms`;

async function bigEngine() {
  const file = tempDb();
  openStore(file.open()).close();
  const raw = file.open();
  populate(raw, THREADS, false);
  raw.close();
  const store = openStore(file.open(), { now: () => BIG_NOW });
  const t = await openEngine(store);
  return {
    ...t,
    async close() {
      await t.engine.close();
      store.close();
      file.cleanup();
    },
  };
}

// About a minute at 100,000 threads. Correctness always runs above; the numbers are asserted only when asked for.
test(
  `at ${THREADS} threads: re-run p95 under 1 ms and View/move p95 under 5 ms`,
  { skip: !TIMINGS },
  async () => {
    const t = await bigEngine();
    try {
      const inbox = await t.call('View/watch', { spec: { kind: 'mailbox', role: 'inbox' } });
      const target = inbox.ids[3]!;
      const rerun: number[] = [];
      const counted: number[] = [];
      for (let i = 0; i < 200; i++) {
        t.commit([patch(target, { bookmarked: i % 2 === 0 })]);
        const layouts = t.views.stats.layouts;
        const from = performance.now();
        await t.advance(250);
        const took = performance.now() - from;
        (t.views.stats.layouts > layouts ? counted : rerun).push(took);
      }
      const frames = t.windowFrames(inbox.windowId).length;
      const forward: number[] = [];
      const jumps: number[] = [];
      for (let i = 0; i < 200; i++) {
        let from = performance.now();
        await t.call('View/move', { windowId: inbox.windowId, anchor: { offset: 100 } });
        forward.push(performance.now() - from);
        from = performance.now();
        await t.call('View/move', {
          windowId: inbox.windowId,
          anchor: { position: (i * 7919) % 25_000 },
        });
        jumps.push(performance.now() - from);
      }
      console.log(
        `re-run (incl. 5 ticks and the frame) median ${ms(median(rerun))} p95 ${ms(p95(rerun))};` +
          ` with a recount (at most 1 s apart on a big view) p95 ${ms(p95(counted))}; ${frames} frames;` +
          ` move +100: p95 ${ms(p95(forward))}; jump: median ${ms(median(jumps))} p95 ${ms(p95(jumps))}`,
      );
      assert.ok(p95(rerun) < 1, `re-run p95 ${ms(p95(rerun))}`);
      assert.ok(p95(forward) < 5, `View/move p95 ${ms(p95(forward))}`);
    } finally {
      await t.close();
    }
  },
);
