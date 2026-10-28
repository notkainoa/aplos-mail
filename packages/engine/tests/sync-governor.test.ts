import test from 'node:test';
import assert from 'node:assert/strict';
import { LANES, gmailBudget } from '../src/sync/budgets';
import { SlidingWindow } from '../src/sync/window';
import type { SyncLane as Lane } from '../src/ports';
import { ACCOUNT, MINUTE, deferred, maxWindow, req, settle, setup } from './sync-governor-helpers';

test('a flood from every lane never goes above the target in any 60 s window', async () => {
  const { clock, governor } = setup();
  const calls: { at: number; units: number; lane: Lane }[] = [];
  const costs = [2, 5, 20, 40, 120];
  let inFlight = 0;
  let maxInFlight = 0;
  const runs: Promise<void>[] = [];
  for (let i = 0; i < 400; i++) {
    const lane = LANES[i % LANES.length];
    const cost = costs[(i * 7) % costs.length];
    runs.push(
      governor.run(ACCOUNT, req(lane, cost), async () => {
        calls.push({ at: clock.now(), units: cost, lane });
        maxInFlight = Math.max(maxInFlight, ++inFlight);
        await clock.sleep(300);
        inFlight--;
      }),
    );
  }
  await Promise.all(runs);
  assert.equal(calls.length, 400);
  const peak = maxWindow(calls);
  assert.ok(peak <= 4_500, `peak ${peak}`);
  assert.ok(peak > 4_000, 'the flood should reach the target');
  assert.ok(maxInFlight <= 3);
  // Each call fitted its lane's limits. Corrected after review (finding 7): comparing every lane's
  // share with the whole window let backfill at 75% starve prefetch, which ARCH 4.1 ranks above it.
  // A lane's own spend stays within its share ("prefetch at most 20% of target", ARCH 6.2), and the
  // window's total within the largest share of that lane and the lanes below it.
  const share = (lane: Lane) => gmailBudget.laneShare[lane]!;
  calls.forEach((call, i) => {
    const window = calls.slice(0, i + 1).filter(c => call.at - c.at < MINUTE);
    const used = window.reduce((sum, c) => sum + c.units, 0);
    const own = window.filter(c => c.lane === call.lane).reduce((sum, c) => sum + c.units, 0);
    const headroom = Math.max(...LANES.slice(LANES.indexOf(call.lane)).map(share));
    assert.ok(own <= Math.floor(4_500 * share(call.lane)), `${call.lane} own spend ${own}`);
    assert.ok(used <= Math.floor(4_500 * headroom), `${call.lane} admitted at ${used}`);
  });
});

test('an interactive request overtakes queued backfill', async () => {
  const { clock, governor } = setup({ auto: false });
  const order: string[] = [];
  const record = (name: string) => async () => {
    order.push(name);
  };
  await governor.run(ACCOUNT, req('interactive', 4_500), record('fill'));
  const backfill = [1, 2, 3].map(i =>
    governor.run(ACCOUNT, req('backfill', 100), record(`backfill${i}`)),
  );
  await settle();
  const interactive = governor.run(ACCOUNT, req('interactive', 120), record('interactive'));
  await settle();
  assert.deepEqual(order, ['fill']);
  await clock.advance(MINUTE);
  await Promise.all([...backfill, interactive]);
  assert.deepEqual(order, ['fill', 'interactive', 'backfill1', 'backfill2', 'backfill3']);
});

test('one in-flight slot stays reserved for interactive and op flush', async () => {
  const { governor } = setup({ auto: false });
  const gates = [deferred(), deferred(), deferred(), deferred()];
  const started: string[] = [];
  const hold = (name: string, gate: { promise: Promise<void> }) => async () => {
    started.push(name);
    await gate.promise;
  };
  const a = governor.run(ACCOUNT, req('backfill', 10), hold('backfill1', gates[0]));
  const b = governor.run(ACCOUNT, req('incremental', 10), hold('incremental', gates[1]));
  const c = governor.run(ACCOUNT, req('backfill', 10), hold('backfill2', gates[3]));
  await settle();
  assert.deepEqual(started, ['backfill1', 'incremental']);
  const d = governor.run(ACCOUNT, req('opFlush', 10), hold('opFlush', gates[2]));
  await settle();
  assert.deepEqual(started, ['backfill1', 'incremental', 'opFlush']);
  assert.equal(governor.inspect(ACCOUNT, 'gmail').inFlight, 3);
  // Background lanes never take the last free slot: with opFlush and incremental running, backfill waits.
  gates[0].resolve();
  await a;
  await settle();
  assert.deepEqual(started, ['backfill1', 'incremental', 'opFlush']);
  gates[1].resolve();
  await b;
  await settle();
  assert.deepEqual(started, ['backfill1', 'incremental', 'opFlush', 'backfill2']);
  for (const gate of gates) gate.resolve();
  await Promise.all([b, c, d]);
});

test('a request larger than its lane limit goes alone, on an empty window, and is logged', async () => {
  const { clock, governor, logs } = setup({ auto: false });
  const start = clock.now();
  await governor.run(ACCOUNT, req('interactive', 10), async () => {});
  let at = 0;
  const big = governor.run(ACCOUNT, req('prefetch', 1_000), async () => {
    at = clock.now();
  });
  await settle();
  assert.equal(at, 0);
  await clock.advance(MINUTE);
  await big;
  assert.equal(at, start + MINUTE);
  const admitted = logs.filter(l => l.event === 'governor.admitted').at(-1)!;
  assert.equal(admitted.fields.reason, 'oversize');
  assert.equal(admitted.fields.waitMs, MINUTE);

  // Larger than the whole target: also admitted, but only on an empty window.
  let hugeAt = 0;
  const huge = governor.run(ACCOUNT, req('interactive', 9_000), async () => {
    hugeAt = clock.now();
  });
  await settle();
  assert.equal(hugeAt, 0);
  await clock.advance(MINUTE);
  await huge;
  assert.equal(hugeAt, start + 2 * MINUTE);
});

test('a lower role target applies at once to new admissions', async () => {
  const { clock, governor } = setup({ auto: false });
  const start = clock.now();
  await governor.run(ACCOUNT, req('interactive', 1_400), async () => {});
  governor.setRole(ACCOUNT, 'secondary');
  assert.equal(governor.snapshot(ACCOUNT)[0].target, 1_500);
  let at = 0;
  const next = governor.run(ACCOUNT, req('interactive', 200), async () => {
    at = clock.now();
  });
  await clock.advance(MINUTE - 1);
  assert.equal(at, 0);
  await clock.advance(1);
  await next;
  assert.equal(at, start + MINUTE);
  governor.setRole(ACCOUNT, 'primary');
  assert.equal(governor.snapshot(ACCOUNT)[0].target, 4_500);
});

test('a caller abort removes a queued request without charging it', async () => {
  const { clock, governor } = setup({ auto: false });
  await governor.run(ACCOUNT, req('interactive', 4_500), async () => {});
  const controller = new AbortController();
  let called = false;
  const queued = governor.run(
    ACCOUNT,
    req('backfill', 10, { signal: controller.signal }),
    async () => {
      called = true;
    },
  );
  await settle();
  controller.abort(new Error('closed'));
  await assert.rejects(queued, /closed/);
  await clock.advance(MINUTE);
  assert.equal(called, false);
  assert.equal(governor.inspect(ACCOUNT, 'gmail').used, 0);
});

test('the Calendar budget counts requests: 300 a minute, two in flight', async () => {
  const { clock, governor } = setup();
  const calls: { at: number; units: number }[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  await Promise.all(
    Array.from({ length: 400 }, () =>
      governor.run(
        ACCOUNT,
        req('interactive', 1, { budget: 'gcal', method: 'gcal.events.list' }),
        async () => {
          calls.push({ at: clock.now(), units: 1 });
          maxInFlight = Math.max(maxInFlight, ++inFlight);
          await clock.sleep(50);
          inFlight--;
        },
      ),
    ),
  );
  assert.ok(maxWindow(calls) <= 300);
  assert.equal(maxInFlight, 2);
});

test('a system clock stepped back does not keep the window full for the size of the jump', () => {
  const window = new SlidingWindow(MINUTE);
  const hour = 60 * MINUTE;
  window.charge(hour, 4_000);
  assert.equal(window.used(hour), 4_000);
  // NTP moves the clock back one hour: the charge counts from the new now and ages out after one window.
  assert.equal(window.used(0), 4_000);
  assert.equal(window.used(MINUTE - 1), 4_000);
  assert.equal(window.used(MINUTE), 0);
});
