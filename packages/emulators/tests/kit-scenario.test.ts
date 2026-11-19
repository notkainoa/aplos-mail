import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertScenariosPassed,
  defineScenario,
  dbMatchesServer,
  diffSnapshots,
  maxInFlight,
  runScenarios,
  unitsNeverAbove,
} from '../src/kit/scenario';
import { isKilled } from '../src/kit/killpoints';
import type { RequestLogEntry } from '../src/kit/types';

function entry(at: number, units: number, extra: Partial<RequestLogEntry> = {}): RequestLogEntry {
  return {
    seq: at,
    at,
    service: 'gmail',
    apiMethod: 'm',
    httpMethod: 'GET',
    units,
    status: 200,
    inFlight: 1,
    ...extra,
  };
}

test('a passing scenario reports counts, clock time and subjects', async () => {
  const log: RequestLogEntry[] = [];
  const scenario = defineScenario({
    name: 'passes',
    timeoutMs: 10 * 60_000,
    setup(ctx) {
      ctx.subjects.value = 42;
      ctx.requestLog = () => log;
    },
    async run(ctx) {
      assert.equal(ctx.subject<number>('value'), 42);
      log.push(entry(ctx.clock.now(), 5));
      await ctx.clock.sleep(90_000);
      log.push(entry(ctx.clock.now(), 250));
    },
    invariants: [{ name: 'under limit', check: ctx => unitsNeverAbove(ctx.requestLog(), 300) }],
  });
  const [result] = await runScenarios([scenario], { realTimeBudgetMs: 5000 });
  assert.equal(result.passed, true, result.failures.join('\n'));
  assert.equal(result.clockMs, 90_000);
  assert.equal(result.requestCount, 2);
  assert.equal(result.unitsPeak, 250);
  assert.ok(result.realMs < 2000);
  assertScenariosPassed([result]);
});

test('failing invariants, a throwing run and a missing subject are all reported', async () => {
  const results = await runScenarios([
    defineScenario({
      name: 'bad invariant',
      timeoutMs: 1000,
      setup() {},
      run() {},
      invariants: [
        {
          name: 'always wrong',
          check() {
            throw new Error('boom');
          },
        },
        { name: 'fine', check() {} },
      ],
    }),
    defineScenario({
      name: 'run throws',
      timeoutMs: 1000,
      setup() {},
      run() {
        throw new Error('exploded');
      },
      invariants: [],
    }),
    defineScenario({
      name: 'no subject',
      timeoutMs: 1000,
      setup() {},
      run(ctx) {
        ctx.subject('emulator');
      },
      invariants: [],
    }),
  ]);
  assert.deepEqual(
    results.map(r => r.passed),
    [false, false, false],
  );
  assert.deepEqual(results[0].failures, ["invariant 'always wrong': boom"]);
  assert.deepEqual(results[1].failures, ['run threw: exploded']);
  assert.match(results[2].failures[0], /'emulator' was not set up/);
  assert.throws(() => assertScenariosPassed(results), /3 of 3 scenarios failed/);
});

test('step invariants run after every step and stop the story at the first failure', async () => {
  let counter = 0;
  let after = false;
  const [result] = await runScenarios([
    defineScenario({
      name: 'step checks',
      timeoutMs: 1000,
      setup() {},
      async run(ctx) {
        await ctx.step('one', () => {
          counter = 1;
        });
        await ctx.step('two', () => {
          counter = 2;
        });
        await ctx.step('three', () => {
          counter = 3;
        });
        after = true;
      },
      invariants: [
        {
          name: 'below 2',
          every: 'step',
          check: () => assert.ok(counter < 2, `counter is ${counter}`),
        },
        { name: 'end only', check: () => assert.fail('must not run when the story aborted') },
      ],
    }),
  ]);
  assert.equal(after, false);
  assert.equal(result.steps, 2);
  assert.equal(result.failures.length, 2);
  assert.match(result.failures[0], /invariant 'below 2': counter is 2/);
  assert.match(result.failures[1], /stopped at step 2 \('two'\)/);
});

test('timeout is measured in clock time, so a two-hour wait fails fast', async () => {
  const [result] = await runScenarios(
    [
      defineScenario({
        name: 'too slow',
        timeoutMs: 3600_000,
        setup() {},
        async run(ctx) {
          await ctx.clock.sleep(2 * 3600_000);
        },
        invariants: [],
      }),
    ],
    { realTimeBudgetMs: 5000 },
  );
  assert.equal(result.passed, false);
  assert.match(result.failures[0], /timed out after 3600000 ms of clock time \(during run\)/);
  assert.equal(result.clockMs, 3600_000);
  assert.ok(result.realMs < 2000);
});

test('a story that never finishes and has no timers still times out', async () => {
  const [result] = await runScenarios([
    defineScenario({
      name: 'stuck',
      timeoutMs: 1000,
      setup() {},
      run: () => new Promise<void>(() => {}),
      invariants: [],
    }),
  ]);
  assert.match(result.failures[0], /timed out/);
});

test('real-time budget stops a scenario that spins without moving the clock', async () => {
  let stop = false;
  const [result] = await runScenarios(
    [
      defineScenario({
        name: 'spins',
        timeoutMs: 3600_000,
        setup() {},
        // Registering a new clock timer every turn keeps the auto clock from deciding it is idle and jumping.
        async run(ctx) {
          while (!stop) {
            void ctx.clock.sleep(1);
            await new Promise<void>(resolve => setImmediate(resolve));
          }
        },
        // The runner cannot cancel the body, so the test must end the loop itself.
        teardown() {
          stop = true;
        },
        invariants: [],
      }),
    ],
    { realTimeBudgetMs: 100 },
  );
  assert.equal(result.passed, false);
  assert.match(result.failures[0], /exceeded the real-time budget of 100 ms/);
  // Wide bounds on purpose: timers can fire a millisecond early by Date.now(), and a loaded Mac
  // (several npm run check runs at once) can take seconds to come back to the stop.
  assert.ok(result.realMs >= 90 && result.realMs < 15_000, `realMs ${result.realMs}`);
});

test('scenarios get independent clocks, injectors and kill switches; teardown always runs', async () => {
  const seen: unknown[] = [];
  let torn = 0;
  const make = (name: string) =>
    defineScenario({
      name,
      timeoutMs: 1000,
      setup(ctx) {
        seen.push(ctx.clock, ctx.faults, ctx.kill);
      },
      async run(ctx) {
        ctx.kill.arm('p');
        try {
          ctx.kill.checkpoint('p');
        } catch (e) {
          assert.ok(isKilled(e));
        }
        throw new Error('after kill');
      },
      teardown() {
        torn += 1;
      },
      invariants: [],
    });
  const results = await runScenarios([make('a'), make('b')]);
  assert.equal(new Set(seen).size, 6);
  assert.equal(torn, 2);
  assert.equal(results[0].failures[0], 'run threw: after kill');
});

test('unitsNeverAbove: sliding window and its boundary', () => {
  const log = [entry(0, 100), entry(59_999, 100), entry(60_000, 100)];
  // 0 and 59_999 share a window (200); 60_000 is a full window after 0, so it joins 59_999 instead (200).
  unitsNeverAbove(log, 200);
  assert.throws(() => unitsNeverAbove(log, 199), /200 units charged in 60000 ms .* limit is 199/);
  // Exactly windowMs apart are separate windows.
  unitsNeverAbove([entry(0, 100), entry(60_000, 100)], 100);
  assert.throws(() => unitsNeverAbove([entry(0, 100), entry(59_999, 100)], 100), /200 units/);
  // A burst in the middle of a quiet log is found.
  const burst = [
    entry(0, 10),
    entry(100_000, 90),
    entry(130_000, 90),
    entry(159_999, 90),
    entry(300_000, 10),
  ];
  assert.throws(() => unitsNeverAbove(burst, 200), /270 units/);
  unitsNeverAbove(burst, 270);
  // Custom window and empty log.
  unitsNeverAbove([entry(0, 100), entry(1500, 100)], 100, 1000);
  unitsNeverAbove([], 0);
  // Accepts a getter, and unsorted input.
  unitsNeverAbove(() => [entry(5000, 1), entry(0, 1)], 2);
});

test('unitsNeverAbove measures per account unless told otherwise; refused requests count as charged', () => {
  const log = [
    entry(0, 100, { account: 'a@example.test' }),
    entry(10, 100, { account: 'b@example.test' }),
    entry(20, 0, { account: 'a@example.test', status: 429 }),
  ];
  unitsNeverAbove(log, 100);
  assert.throws(() => unitsNeverAbove(log, 100, 60_000, false), /200 units/);
  assert.throws(
    () => unitsNeverAbove([entry(0, 150, { account: 'a@example.test' })], 100),
    /for account a@example.test/,
  );
});

test('maxInFlight reports the worst offender', () => {
  const log = [
    entry(1, 1, { inFlight: 2 }),
    entry(2, 1, { inFlight: 5, apiMethod: 'gmail.users.threads.get' }),
    entry(3, 1, { inFlight: 3 }),
  ];
  maxInFlight(log, 5);
  assert.throws(
    () => maxInFlight(log, 4),
    /5 requests in flight at once \(request #2, gmail.users.threads.get\), limit is 4/,
  );
});

test('dbMatchesServer passes on equal snapshots and prints a readable diff otherwise', async () => {
  await dbMatchesServer(
    () => ({ threads: [{ id: 't1', labels: ['INBOX'] }] }),
    async () => ({ threads: [{ id: 't1', labels: ['INBOX'] }] }),
  );
  await dbMatchesServer(
    () => new Map([['t1', new Set(['b', 'a'])]]),
    () => new Map([['t1', new Set(['a', 'b'])]]),
  );
  await assert.rejects(
    dbMatchesServer(
      () => ({ threads: [{ id: 't1', labels: ['INBOX', 'STARRED'] }, { id: 't2' }], historyId: 5 }),
      () => ({ threads: [{ id: 't1', labels: ['INBOX'] }], historyId: 7 }),
    ),
    (error: Error) => {
      assert.match(error.message, /differ in 3 place\(s\)/);
      assert.match(error.message, /historyId: local 5 vs server 7/);
      assert.match(error.message, /threads\.0\.labels\.1: local "STARRED" vs server missing/);
      assert.match(error.message, /threads\.1: local \{"id":"t2"\} vs server missing/);
      return true;
    },
  );
});

test('dbMatchesServer accepts a custom compare', async () => {
  const ignoreHistory = (a: { n: number; h: number }, b: { n: number; h: number }) =>
    a.n === b.n ? [] : [`n differs: ${a.n} vs ${b.n}`];
  await dbMatchesServer(
    () => ({ n: 1, h: 1 }),
    () => ({ n: 1, h: 2 }),
    ignoreHistory,
  );
  await assert.rejects(
    dbMatchesServer(
      () => ({ n: 1, h: 1 }),
      () => ({ n: 2, h: 1 }),
      ignoreHistory,
    ),
    /n differs: 1 vs 2/,
  );
  assert.deepEqual(diffSnapshots([1, 2], [1, 2]), []);
  assert.deepEqual(diffSnapshots('a', 'b'), ['(root): local "a" vs server "b"']);
});
