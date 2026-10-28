/**
 * A small scenario runner. A scenario sets up an emulator and a client, runs a story against a fake
 * clock, and then invariants decide whether the story ended well. The runner knows nothing about
 * Gmail: whatever the scenario builds goes into `ctx.subjects`, and the request log it wants
 * measured is handed over with `ctx.requestLog`.
 *
 * Two budgets stop a scenario that hangs: `timeoutMs` in clock time (a story that never finishes)
 * and `realTimeBudgetMs` in real time (a story that spins). Waits inside the code under test must go
 * through `ctx.clock`.
 */
import { FakeClock } from './clock';
import { createFaultInjector, type FaultInjector } from './faults';
import { createKillSwitch, type KillSwitch } from './killpoints';
import type { RequestLogEntry } from './types';

export interface ScenarioContext {
  readonly name: string;
  readonly clock: FakeClock;
  readonly faults: FaultInjector;
  readonly kill: KillSwitch;
  /** Whatever the scenario builds (emulator, client, database). The runner never looks inside. */
  readonly subjects: Record<string, unknown>;
  /** Scenario setup points this at the emulator's log so the runner can report counts and peak units. */
  requestLog: () => readonly RequestLogEntry[];
  /** Typed read from `subjects`; throws if setup did not provide it. */
  subject<T>(key: string): T;
  /**
   * Mark a step in the story: runs `body` (optional) and then every invariant declared with
   * `every: 'step'`. A failing invariant ends the scenario at once.
   */
  step(label: string, body?: () => void | Promise<void>): Promise<void>;
}

export interface Invariant {
  name: string;
  /** Throw (e.g. with node:assert) to fail. */
  check(ctx: ScenarioContext): void | Promise<void>;
  /** 'end' (default) checks once after the run; 'step' also checks after every `ctx.step`. */
  every?: 'end' | 'step';
}

export interface Scenario {
  name: string;
  /** Maximum clock time for setup plus run. */
  timeoutMs: number;
  setup(ctx: ScenarioContext): void | Promise<void>;
  run(ctx: ScenarioContext): void | Promise<void>;
  invariants: Invariant[];
  /** Always called last, to stop servers or close databases. Errors are reported as failures. */
  teardown?(ctx: ScenarioContext): void | Promise<void>;
}

export interface ScenarioResult {
  name: string;
  passed: boolean;
  /** Clock time the scenario used. */
  clockMs: number;
  realMs: number;
  failures: string[];
  steps: number;
  requestCount: number;
  /** Most units charged inside any sliding 60 s window for one account. */
  unitsPeak: number;
}

export interface RunOptions {
  /** Real-time limit per scenario. Default 10 000 ms. */
  realTimeBudgetMs?: number;
}

export function defineScenario(scenario: Scenario): Scenario {
  return scenario;
}

/** Raised by `ctx.step` after it has recorded the failure, so the runner doesn't report it twice. */
class ScenarioAbort extends Error {
  constructor() {
    super('scenario aborted after a failed invariant');
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Let real macrotask turns pass, so work woken by a clock jump can finish. */
async function realTurns(turns = 5): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise<void>(resolve => setImmediate(resolve));
}

export async function runScenarios(
  list: Scenario[],
  options: RunOptions = {},
): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = [];
  for (const scenario of list)
    results.push(await runScenario(scenario, options.realTimeBudgetMs ?? 10_000));
  return results;
}

/** Throws one readable error listing every failed scenario. For use inside node:test. */
export function assertScenariosPassed(results: ScenarioResult[]): void {
  const bad = results.filter(r => !r.passed);
  if (!bad.length) return;
  const lines = bad.map(r => `${r.name}:\n${r.failures.map(f => `  - ${f}`).join('\n')}`);
  throw new Error(`${bad.length} of ${results.length} scenarios failed\n${lines.join('\n')}`);
}

type Outcome = 'done' | 'timeout' | 'budget';

async function runScenario(scenario: Scenario, realTimeBudgetMs: number): Promise<ScenarioResult> {
  const clock = new FakeClock();
  const clockStart = clock.now();
  const realStart = Date.now();
  const failures: string[] = [];
  let steps = 0;
  let requestLog: () => readonly RequestLogEntry[] = () => [];
  const subjects: Record<string, unknown> = {};

  const runInvariants = async (ctx: ScenarioContext, which: 'step' | 'end'): Promise<boolean> => {
    let ok = true;
    for (const invariant of scenario.invariants) {
      // Step invariants also run at the end; end invariants never run mid-story.
      if (which === 'step' && invariant.every !== 'step') continue;
      try {
        await invariant.check(ctx);
      } catch (error) {
        ok = false;
        failures.push(`invariant '${invariant.name}': ${describeError(error)}`);
      }
    }
    return ok;
  };

  const ctx: ScenarioContext = {
    name: scenario.name,
    clock,
    faults: createFaultInjector(),
    kill: createKillSwitch(),
    subjects,
    get requestLog() {
      return requestLog;
    },
    set requestLog(fn) {
      requestLog = fn;
    },
    subject<T>(key: string): T {
      if (!(key in subjects)) throw new Error(`scenario subject '${key}' was not set up`);
      return subjects[key] as T;
    },
    async step(label, body) {
      steps += 1;
      if (body) await body();
      if (!(await runInvariants(ctx, 'step'))) {
        failures.push(`stopped at step ${steps} ('${label}')`);
        throw new ScenarioAbort();
      }
    },
  };

  let phase = 'setup' as 'setup' | 'run';
  const body = (async () => {
    await scenario.setup(ctx);
    phase = 'run';
    await scenario.run(ctx);
  })();

  const abort = new AbortController();
  let realTimer: ReturnType<typeof setTimeout> | undefined;
  let bodyError: unknown;
  const outcome = await new Promise<Outcome>(resolve => {
    let settled = false;
    const finish = (value: Outcome) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    body.then(
      () => finish('done'),
      error => {
        bodyError = error;
        finish('done');
      },
    );
    // Clock-time limit. When it fires, give work that the jump woke a chance to finish first:
    // a scenario that drains the clock with runUntilIdle would otherwise trip its own watchdog.
    clock.sleep(scenario.timeoutMs, abort.signal).then(
      async () => {
        await realTurns();
        finish('timeout');
      },
      () => {},
    );
    realTimer = setTimeout(() => finish('budget'), realTimeBudgetMs);
  });
  if (realTimer) clearTimeout(realTimer);
  abort.abort();

  if (outcome !== 'done') {
    // Stop a runaway body from keeping the clock moving, and keep its late rejection quiet.
    clock.auto(false);
    body.catch(() => {});
    failures.push(
      outcome === 'timeout'
        ? `timed out after ${scenario.timeoutMs} ms of clock time (during ${phase})`
        : `exceeded the real-time budget of ${realTimeBudgetMs} ms (during ${phase})`,
    );
  } else {
    if (bodyError !== undefined && !(bodyError instanceof ScenarioAbort)) {
      failures.push(`${phase} threw: ${describeError(bodyError)}`);
    }
    if (!(bodyError instanceof ScenarioAbort) && phase === 'run') await runInvariants(ctx, 'end');
  }

  if (scenario.teardown) {
    try {
      await scenario.teardown(ctx);
    } catch (error) {
      failures.push(`teardown threw: ${describeError(error)}`);
    }
  }

  const log = requestLog();
  return {
    name: scenario.name,
    passed: failures.length === 0,
    clockMs: clock.now() - clockStart,
    realMs: Date.now() - realStart,
    failures,
    steps,
    requestCount: log.length,
    unitsPeak: peakUnits(log, 60_000),
  };
}

// ---------------------------------------------------------------------------------------------
// Generic invariant helpers. Each throws with a readable message when the property is violated.
// ---------------------------------------------------------------------------------------------

type LogSource = readonly RequestLogEntry[] | (() => readonly RequestLogEntry[]);
const resolveLog = (log: LogSource): readonly RequestLogEntry[] =>
  typeof log === 'function' ? log() : log;

export interface WindowPeak {
  units: number;
  /** Start of the window: the arrival time of its first request. */
  from: number;
  requests: number;
  account?: string;
}

/**
 * The heaviest sliding window. A window is `[start, start + windowMs)`, so two requests exactly
 * `windowMs` apart are not in the same window. Windows are measured per account because quotas
 * are per user; pass `perAccount: false` to pool every request together.
 */
export function peakWindow(
  log: readonly RequestLogEntry[],
  windowMs = 60_000,
  perAccount = true,
): WindowPeak {
  const groups = new Map<string | undefined, RequestLogEntry[]>();
  for (const entry of log) {
    const key = perAccount ? entry.account : undefined;
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }

  let best: WindowPeak = { units: 0, from: 0, requests: 0 };
  for (const [account, entries] of groups) {
    const sorted = [...entries].sort((a, b) => a.at - b.at || a.seq - b.seq);
    let first = 0;
    let sum = 0;
    for (let last = 0; last < sorted.length; last++) {
      sum += sorted[last].units;
      // Drop requests too old to share a window with the newest one.
      while (sorted[last].at - sorted[first].at >= windowMs) {
        sum -= sorted[first].units;
        first++;
      }
      if (sum > best.units)
        best = { units: sum, from: sorted[first].at, requests: last - first + 1, account };
    }
  }
  return best;
}

export function peakUnits(log: readonly RequestLogEntry[], windowMs = 60_000): number {
  return peakWindow(log, windowMs).units;
}

/** Fails if any sliding window of `windowMs` charged more than `limit` units. */
export function unitsNeverAbove(
  log: LogSource,
  limit: number,
  windowMs = 60_000,
  perAccount = true,
): void {
  const peak = peakWindow(resolveLog(log), windowMs, perAccount);
  if (peak.units > limit) {
    const who = peak.account ? ` for account ${peak.account}` : '';
    throw new Error(
      `${peak.units} units charged in ${windowMs} ms${who} (${peak.requests} requests from t=${peak.from}), limit is ${limit}`,
    );
  }
}

/** Fails if more than `limit` requests were ever in flight at once (the log's own `inFlight` field). */
export function maxInFlight(log: LogSource, limit: number): void {
  let worst: RequestLogEntry | undefined;
  for (const entry of resolveLog(log)) {
    if (entry.inFlight > limit && (!worst || entry.inFlight > worst.inFlight)) worst = entry;
  }
  if (worst) {
    throw new Error(
      `${worst.inFlight} requests in flight at once (request #${worst.seq}, ${worst.apiMethod}), limit is ${limit}`,
    );
  }
}

// -- snapshot comparison ----------------------------------------------------------------------

/** Turn Maps and Sets into plain data so they can be compared and printed. */
function toPlain(value: unknown): unknown {
  if (value instanceof Map)
    return Object.fromEntries([...value].map(([k, v]) => [String(k), toPlain(v)]));
  if (value instanceof Set)
    return [...value]
      .map(toPlain)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (Array.isArray(value)) return value.map(toPlain);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toPlain(v)]));
  }
  return value;
}

function show(value: unknown): string {
  const text = value === undefined ? 'missing' : JSON.stringify(value);
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

/** Path-by-path differences between two snapshots, empty when equal. `local` is the left side. */
export function diffSnapshots(local: unknown, server: unknown): string[] {
  const out: string[] = [];
  const walk = (a: unknown, b: unknown, path: string): void => {
    if (JSON.stringify(a) === JSON.stringify(b) && typeof a !== 'object') return;
    const bothObjects = a && b && typeof a === 'object' && typeof b === 'object';
    if (bothObjects && Array.isArray(a) === Array.isArray(b)) {
      const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
      for (const key of keys) {
        walk(
          (a as Record<string, unknown>)[key],
          (b as Record<string, unknown>)[key],
          path ? `${path}.${key}` : key,
        );
      }
      return;
    }
    if (a !== b) out.push(`${path || '(root)'}: local ${show(a)} vs server ${show(b)}`);
  };
  walk(toPlain(local), toPlain(server), '');
  return out;
}

/**
 * Fails when the client's local database and the server disagree. By default the two snapshots are
 * deep-compared; pass `compare` to normalise first (e.g. ignore server-only fields) by returning
 * the list of differences, empty when they match.
 */
export async function dbMatchesServer<T>(
  getLocal: () => T | Promise<T>,
  getServer: () => T | Promise<T>,
  compare: (local: T, server: T) => string[] = diffSnapshots,
): Promise<void> {
  const differences = compare(await getLocal(), await getServer());
  if (!differences.length) return;
  const shown = differences.slice(0, 20);
  const more =
    differences.length > shown.length
      ? `\n  ... and ${differences.length - shown.length} more`
      : '';
  throw new Error(
    `local database and server differ in ${differences.length} place(s):\n  ${shown.join('\n  ')}${more}`,
  );
}
