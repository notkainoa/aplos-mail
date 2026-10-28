import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore, type StorePort } from '../../src/store';
import { BENCH_SPECS, compileView } from '../../src/views/registry';
import type { ViewEnv } from '../../src/views/specs';
import { tempDb } from '../store/helpers';
import { BIG_NOW, populate } from './big';

/*
 * views-1's check: at 100,000 threads, no statement any compiled spec runs scans `threads` or `messages` (each is
 * reached by primary key or an index), and none uses OFFSET. Timings are printed for the record, not asserted.
 */

const THREADS = Number(process.env.APLOS_VIEWS_THREADS ?? 100_000);
const ENV: ViewEnv = { now: BIG_NOW, zone: 'America/Los_Angeles', followUpDays: 3 };

/** Table aliases the compiler uses for `threads` and `messages`. */
const BIG_TABLES = new Set(['threads', 'messages', 't', 'st', 'ft', 'sf', 'm', 'vm']);

let store: StorePort;
let cleanup: () => void;

test.before(() => {
  const file = tempDb();
  const db = file.open();
  openStore(db).close();
  const raw = file.open();
  populate(raw, THREADS);
  raw.close();
  store = openStore(file.open());
  cleanup = () => (store.close(), file.cleanup());
});
test.after(() => cleanup?.());

function median(values: number[]) {
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
}

test(`at ${THREADS} threads no compiled statement scans threads or messages`, () => {
  const bad: string[] = [];
  let statements = 0;
  store.read(q => {
    for (const spec of BENCH_SPECS) {
      for (const s of compileView(spec, ENV).statements(q)) {
        statements++;
        assert.doesNotMatch(s.sql, /\bOFFSET\b/i);
        for (const row of q.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${s.sql}`, ...s.params)) {
          const scan = /^SCAN (\w+)/.exec(row.detail);
          if (scan && BIG_TABLES.has(scan[1]))
            bad.push(`${JSON.stringify(spec)}: ${row.detail}\n  ${s.sql}`);
        }
      }
    }
  });
  assert.deepEqual(bad, []);
  assert.ok(statements > 300, `${statements} statements`);
});

// Opt-in (APLOS_VIEWS_TIMINGS=1): about 30 s at 100,000 threads. The numbers go to the PR and PROGRESS.md.
test(
  `at ${THREADS} threads: first page and layout per spec (printed)`,
  { skip: !process.env.APLOS_VIEWS_TIMINGS },
  () => {
    store.read(q => {
      for (const spec of BENCH_SPECS) {
        const plan = compileView(spec, ENV);
        const page: number[] = [];
        const layout: number[] = [];
        let total = 0;
        for (let i = 0; i < 5; i++) {
          let t = performance.now();
          const rows = plan.rows(q, undefined, 200);
          page.push(performance.now() - t);
          t = performance.now();
          total = plan.layout(q).total;
          layout.push(performance.now() - t);
          assert.ok(rows.length <= 200);
        }
        console.log(
          `${JSON.stringify(spec).padEnd(96)} page ${median(page).toFixed(2).padStart(8)} ms  layout ${median(layout).toFixed(2).padStart(8)} ms  rows ${total}`,
        );
      }
    });
  },
);
