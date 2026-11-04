import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Submission } from '@aplos/contract';
import { ContractError } from '@aplos/contract/contract-error';
import { openSqlite } from '../../../../apps/desktop/src/host/sqlite';
import { createTimerLoop, fakeClock, type FakeClock } from '../../src/clock/module';
import { createLogger } from '../../src/diag/log';
import { UNCERTAIN_COPY } from '../../src/outbox/context';
import { installKillHook, KP, type KillPoint } from '../../src/outbox/killpoints';
import { createOutboxModule, outboxExtension } from '../../src/outbox/module';
import type { SendPort } from '../../src/ports/engine';
import { openStore } from '../../src/store';
import { accountWrite, ACCOUNT } from '../store/helpers';
import { deliveryCounts, readLog, type PortEnv } from './killpoint-fake';

/**
 * The kill-point harness (time-6): runs one send in child processes that kill themselves at a named kill point
 * (`SIGKILL`, no cleanup), then restarts the engine on the same store file and checks the send machine's promise: one
 * Message-ID is never delivered twice and a message is never lost silently (ARCH 7.1 to 7.3, plan 10 E6).
 *
 * HOW A SCENARIO RUNS
 *  1. The parent seeds a temp `mail.db`: an account, a draft, and one send due at `SEND_DUE`.
 *  2. For each entry of `killAt`, a child process (`killpoint-child.ts`) opens that file with a real engine (the real
 *     start rule), installs the kill hook for that one point and drives a fake clock. It dies at the point; a child that
 *     exits without dying means the point was never reached, which fails the scenario.
 *  3. The parent opens the file once more in this process, with the same port, and drives the clock past the 60 s
 *     recheck. The result is the submission's final row, the server's delivery count and the calls it saw.
 *  `assertSendInvariant` states what must hold for every scenario; a test adds the exact expected state.
 *
 * PLUGGING IN ANOTHER SERVER (prov-emu, Providers)
 * The engine talks to the provider only through `SendPort`. A scenario names a port by `{ module, config }`: `module` is
 * an absolute path to a file exporting `createSendPort(env: PortEnv): SendPort | Promise<SendPort>`; `config` is the JSON
 * it receives (in the child and in the parent). The default is the counting fake in `killpoint-fake.ts`, whose server
 * memory is a file. The Gmail emulator is an HTTP server and must outlive the child, so run it in the test process,
 * put its base URL in `config`, export a `createSendPort` that builds the Gmail send adapter over that URL, and pass
 * `countDeliveries` (the emulator's own count per Message-ID). Everything else (the kill points, the restart, the
 * invariant) is the same code. Two kill points sit in `killableSend`, a wrapper the outbox puts around any port in test
 * builds, so an adapter needs no kill-point code of its own.
 */

/** The environment variable a child reads to learn its kill point; only test code knows it. */
export const KILL_ENV = 'APLOS_KILLPOINT';
/** The environment variable that carries the child's run description (JSON). */
export const RUN_ENV = 'APLOS_KILLPOINT_RUN';

const SEC = 1_000;
const T0 = Date.UTC(2026, 9, 28, 9, 0, 0);
/** `Submission/set send` with the default undo window: the send is due this long after the seed. */
const SEND_DUE = T0 + 10 * SEC;
/** A life that is killed needs to reach its point (the send is due after 10 s); one that is not runs past both checks. */
const KILLED_RUN_MS = 30 * SEC;
const QUIET_RUN_MS = 120 * SEC;
/** A life that quits between the two checks: the send is due at 10 s, the second check at 70 s. */
const QUIT_RUN_MS = 40 * SEC;
/** A life, and a whole scenario, that outlasts these is hung (a spinning engine), not slow: it fails with a message. */
const LIFE_BUDGET_MS = 15 * SEC;
const SCENARIO_BUDGET_MS = 20 * SEC;
/** The most clock steps one life takes; the longest scenario (six hours) takes a few hundred. */
const MAX_STEPS = 1_000;
const MAX_SETTLE_ROUNDS = 3;
/** How long a life runs, by its kill step; a killed life runs only until it reaches its point. */
const LIFE_MS: Partial<Record<KillStep, number>> = { none: QUIET_RUN_MS, quit: QUIT_RUN_MS };
const CHILD = join(import.meta.dirname, 'killpoint-child.ts');
const FAKE_PORT = join(import.meta.dirname, 'killpoint-fake.ts');

export interface PortSpec {
  /** Absolute path of a module exporting `createSendPort`. */
  module: string;
  config: Record<string, unknown>;
}

/** What a child needs to run one engine life. */
export interface RunSpec {
  dbPath: string;
  clockStart: number;
  runMs: number;
  port: PortSpec;
  /** `during-commit` only: the one move this life dies in (see `MOVES`). */
  move?: MoveName;
  /** The owner's scripted actions in this life (see `ActionSpec`). */
  actions?: ActionSpec[];
  /** Where this life appends what the owner did (`JournalLine`). */
  journalPath?: string;
  /** This life's index in the scenario (the journal says which life acted). */
  life?: number;
}

/**
 * The state moves a `during-commit` kill can name. The hook sees `from>to:why` (`killpoints.ts`); each name is one move.
 * `startup-uncertain` is the launch's start rule (`sending` row nobody awaits); `uncertain` is the same move made by a
 * `send` whose outcome is unknown; `check-uncertain` is a `findSent` that found nothing (count and next check).
 */
export type MoveName =
  | 'marker'
  | 'sent'
  | 'uncertain'
  | 'startup-uncertain'
  | 'check-uncertain'
  | 'failed'
  | 'cancelled'
  | 'queued-after-sendAnyway';

export const MOVES: Record<MoveName, (detail: string) => boolean> = {
  marker: d => /^[^>]*>sending:/.test(d),
  sent: d => />sent:/.test(d),
  uncertain: d => d.endsWith('>uncertain:uncertain'),
  'startup-uncertain': d => d === 'sending>uncertain:startRule',
  'check-uncertain': d => d === 'uncertain>uncertain:findSent',
  failed: d => />failed:/.test(d),
  cancelled: d => />cancelled:/.test(d),
  'queued-after-sendAnyway': d => d.endsWith('>queued:sendAnyway'),
};

/**
 * The owner pressing a button in one life. `when`: a number is fake ms into the life (once, answered or refused);
 * `asked` is the first moment the row shows the prompt, retried every step until the machine accepts it (Send anyway and
 * Cancel are refused while a check is pending, as in the app); a kill point name runs it synchronously AT that point,
 * before the engine goes on (the race: the click lands between two steps of the send), and then the engine carries on.
 */
export interface ActionSpec {
  do: 'undo' | 'cancel' | 'sendAnyway';
  when: number | 'asked' | KillPoint;
  /** Which life (index into `killAt`; the restarted engine is `killAt.length`). Default 0. */
  life?: number;
}

/** One line of the journal: the owner's action, as the machine saw it. A line with no outcome died inside the call. */
export interface JournalLine {
  key: string;
  phase: 'issued' | 'ok' | 'refused';
  do?: ActionSpec['do'];
  life?: number;
  at?: number;
  /** The row's state and problem code when the owner acted (did they see the prompt?). */
  state?: string;
  reason?: string;
  sentence?: string;
}

export async function loadPort(spec: PortSpec, clock: FakeClock): Promise<SendPort> {
  const mod = (await import(pathToFileURL(spec.module).href)) as {
    createSendPort(env: PortEnv): SendPort | Promise<SendPort>;
  };
  return mod.createSendPort({ clock, config: spec.config });
}

/** `SIGKILL` runs no handlers, no `finally` and no store close, like a crash or a force quit. */
export function dieNow(): never {
  process.kill(process.pid, 'SIGKILL');
  // The signal is delivered asynchronously: nothing of the engine may run meanwhile.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000);
  process.exit(99);
}

type Outbox = ReturnType<typeof createOutboxModule>;

/** The owner's scripted actions of one life; every call is journaled before and after, so a death inside it shows. */
function ownerOf(
  run: RunSpec,
  clock: FakeClock,
  outbox: Outbox,
  store: ReturnType<typeof openStore>,
) {
  const pending = [...(run.actions ?? [])];
  let n = 0;
  const journal = (line: Omit<JournalLine, 'key'>, key: string) => {
    if (run.journalPath) appendFileSync(run.journalPath, `${JSON.stringify({ key, ...line })}\n`);
  };
  const current = () => {
    const id = store.read(q => q.get<{ id: string }>('SELECT id FROM submissions'))!.id;
    return { id, row: outbox.service.get([id]).list[0] };
  };
  /** True when the machine accepted the action. */
  const issue = async (spec: ActionSpec): Promise<boolean> => {
    const key = `${run.life ?? 0}:${n++}`;
    const { id, row } = current();
    journal(
      {
        phase: 'issued',
        do: spec.do,
        life: run.life ?? 0,
        at: clock.now(),
        state: row?.state,
        reason: row?.problem?.reasonCode,
      },
      key,
    );
    try {
      await outbox.service.set(`kp-${key}`, { type: spec.do, submissionId: id });
      journal({ phase: 'ok' }, key);
      return true;
    } catch (error) {
      if (!(error instanceof ContractError)) throw error;
      journal({ phase: 'refused', sentence: error.message }, key);
      return false;
    }
  };
  const asked = () => {
    const row = current().row;
    return row?.state === 'uncertain' && row.problem?.reasonCode === 'send.uncertain';
  };
  return {
    /** At a kill point: the actions that wait for it run once, then the engine carries on. */
    atPoint(name: KillPoint) {
      for (const spec of pending.filter(a => a.when === name)) {
        pending.splice(pending.indexOf(spec), 1);
        // The hook is synchronous (it runs inside the engine). The action does all its work inside the call, so it lands
        // here as it always did; only its journal line follows a microtask later, which is why `driveEngine` refuses an
        // action at the very point this life dies (its outcome would be journaled as a death inside the call).
        void issue(spec);
      }
    },
    /** After a clock step. */
    async atTime(elapsed: number) {
      for (const spec of [...pending]) {
        if (typeof spec.when === 'number' && elapsed >= spec.when) {
          pending.splice(pending.indexOf(spec), 1);
          await issue(spec);
        } else if (spec.when === 'asked' && asked() && (await issue(spec))) {
          pending.splice(pending.indexOf(spec), 1);
        }
      }
    },
  };
}

/**
 * An action set at the point where this life dies would be journaled as having died inside its call even when it was
 * answered: `Submission/set` answers through a promise, a microtask after the kill. No scenario does that; one that did
 * would not mean what it says, so it is refused.
 */
function refuseActionAtDeath(run: RunSpec, point: KillPoint | undefined) {
  const clash = point !== undefined && (run.actions ?? []).some(a => a.when === point);
  if (clash)
    throw new Error(`an owner action at the kill point ${point} cannot be journaled exactly`);
}

/**
 * One engine life on `dbPath`: opens it, starts (the real start rule), lets `runMs` of fake time pass, closes. `point`
 * is where it dies (and, for `during-commit`, `run.move` is the move), if anywhere.
 */
export async function driveEngine(run: RunSpec, point?: KillPoint): Promise<Submission[]> {
  const clock = fakeClock(run.clockStart);
  const log = createLogger({ sink: { write: () => {} }, salt: 'kill', clock, level: 'error' });
  const store = openStore(openSqlite(run.dbPath), {
    extensions: [outboxExtension],
    now: () => clock.now(),
  });
  const loop = createTimerLoop({ clock, log });
  const outbox = createOutboxModule({
    store,
    send: await loadPort(run.port, clock),
    clock,
    deadlines: loop,
    log,
    blobs: { get: async () => undefined },
  });
  const progress = { steps: 0, at: 0 };
  const states = () =>
    store
      .read(q => q.all<{ state: string }>('SELECT state FROM submissions ORDER BY id'))
      .map(r => r.state)
      .join(',');
  // A life that spins instead of settling fails with where it was, not by hanging the suite.
  let timer: NodeJS.Timeout | undefined;
  const hung = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `did not settle: state=${states()} after ${progress.steps} steps, fake +${progress.at} ms, ${LIFE_BUDGET_MS} ms wall clock`,
          ),
        ),
      LIFE_BUDGET_MS,
    );
  });
  refuseActionAtDeath(run, point);
  const owner = ownerOf(run, clock, outbox, store);
  installKillHook((name, detail) => {
    owner.atPoint(name);
    if (name !== point) return;
    if (name !== KP.DURING_COMMIT || (run.move && MOVES[run.move](detail ?? ''))) dieNow();
  });
  outbox.start();
  loop.start();
  try {
    await Promise.race([hung, advanceThrough(run, clock, loop, outbox, progress, owner)]);
  } finally {
    clearTimeout(timer);
  }
  // Only a life that settled is closed: closing a spinning one waits on a clock that never moves. Its process exits.
  const ids = store.read(q => q.all<{ id: string }>('SELECT id FROM submissions ORDER BY id'));
  const found = outbox.service.get(ids.map(r => r.id)).list;
  loop.stop();
  await outbox.close();
  store.close();
  return found;
}

async function advanceThrough(
  run: RunSpec,
  clock: FakeClock,
  loop: { idle(): Promise<void> },
  outbox: { idle(): Promise<void> },
  progress: { steps: number; at: number },
  owner: { atTime(elapsed: number): Promise<void> },
) {
  // Fine steps while the checks run (they are due at once and after 60 s), minutes after that.
  while (progress.at < run.runMs) {
    if (progress.steps++ >= MAX_STEPS)
      throw new Error(`did not settle: more than ${MAX_STEPS} steps`);
    const step = progress.at < 3 * 60 * SEC ? 5 * SEC : 60 * SEC;
    await clock.advance(step);
    await settle(clock, loop, outbox);
    progress.at += step;
    await owner.atTime(progress.at);
    await settle(clock, loop, outbox);
  }
}

async function settle(
  clock: FakeClock,
  loop: { idle(): Promise<void> },
  outbox: { idle(): Promise<void> },
) {
  for (let round = 0; round < MAX_SETTLE_ROUNDS; round++) {
    await clock.flush();
    await loop.idle();
    await outbox.idle();
  }
}

// ---------------------------------------------------------------- seeding

async function seed(dbPath: string): Promise<{ id: string; internetId: string }> {
  const clock = fakeClock(T0);
  const log = createLogger({ sink: { write: () => {} }, salt: 'kill', clock, level: 'error' });
  const store = openStore(openSqlite(dbPath), {
    extensions: [outboxExtension],
    now: () => clock.now(),
  });
  store.commit({ opId: 'setup', origin: 'sync', writes: [accountWrite] });
  const db = openSqlite(dbPath);
  db.prepare(
    `INSERT INTO drafts(id, account_id, revision, data, updated_at) VALUES(?, ?, 1, ?, ?)`,
  ).run(
    'd1',
    ACCOUNT,
    JSON.stringify({
      accountId: ACCOUNT,
      mode: 'new',
      to: [{ address: 'jordan@mail.example', name: 'Jordan' }],
      cc: [],
      bcc: [],
      subject: 'Lunch',
      html: '<p>Lunch at noon?</p>',
      attachments: [],
      signature: false,
    }),
    T0,
  );
  db.close();
  const noop: SendPort = {
    admission: () => ({ ok: true }),
    send: () => Promise.reject(new Error('the seed never sends')),
    findSent: () => Promise.reject(new Error('the seed never searches')),
  };
  const outbox = createOutboxModule({
    store,
    send: noop,
    clock,
    deadlines: createTimerLoop({ clock, log }),
    log,
  });
  const { submission } = await outbox.service.set('seed-send', {
    type: 'send',
    draftId: 'd1',
    revision: 1,
  });
  store.close();
  assert.equal(submission.notBefore, SEND_DUE, 'the seed is due after the default undo window');
  return { id: submission.id, internetId: submission.internetId };
}

// ---------------------------------------------------------------- the scenario

/**
 * `none`: a life that is not killed and runs to its end (the prompt shows, then the app is quit and restarted).
 * `quit`: a life that is not killed either, but quit 40 s in: the send's first `findSent` has run and the second is not due.
 */
export type KillStep = KillPoint | 'none' | 'quit';

export interface KillScenario {
  /** The kill point of each engine life before the last, in order: one entry per child process. */
  killAt: KillStep | readonly KillStep[];
  /** The port both the children and the final restart use. Default: the counting fake with `deliver` and `find`. */
  port?: PortSpec;
  /** The counting fake only: does the server accept the bytes? (default true) */
  deliver?: boolean;
  /** The counting fake only: what `findSent` says after a delivery (default `finds`). */
  find?: 'finds' | 'lags' | 'throws';
  /** The counting fake only: the index shows a delivery this long after it arrived (see `FakeConfig.indexLagMs`). */
  indexLagMs?: number;
  /** The counting fake only: the server's clock minus the engine's (see `FakeConfig.serverClockOffsetMs`). */
  serverClockOffsetMs?: number;
  /** The counting fake only: the server accepts the bytes, then `send` throws (see `FakeConfig.answerLost`). */
  answerLost?: boolean;
  /** The counting fake only: `send` refuses with a `NotSentError` of this class (provably not sent). */
  refuse?: string;
  /**
   * Fake time between one life's end and the next life's start (default 20 s). Past 5 minutes the overdue rule applies.
   * Negative: the wall clock is set back while the app is quit (the next life starts earlier than the last one ended).
   */
  downtimeMs?: number;
  /** How long the last life runs; the default (3 minutes) passes the 60 s recheck. */
  recoverMs?: number;
  /** How long a killed life may run to reach its point (default 30 s); longer when it first waits for the prompt. */
  killedRunMs?: number;
  /**
   * The move each `during-commit` step dies in, in order (one entry per such step; a bare name for one). A kill point that
   * fires on every state move needs the move named: there is no default.
   */
  onMove?: MoveName | readonly MoveName[];
  /** The owner's scripted actions (undo, cancel, Send anyway), each in a named life. */
  actions?: readonly ActionSpec[];
  /**
   * The counting fake only: what the k-th `send` call for this Message-ID does, whatever `deliver` says: `drop` (the bytes
   * are lost, nothing delivered), `lose` (delivered, the answer is lost), `ok` (delivered and answered).
   */
  script?: readonly ('drop' | 'lose' | 'ok')[];
  /** The server's own count of deliveries of one Message-ID. Default: the counting fake's log. */
  countDeliveries?: (internetId: string) => number | Promise<number>;
}

export interface KillResult {
  /** The submission as the restarted engine reports it. */
  submission: Submission;
  /** How many times the server accepted this Message-ID. */
  deliveries: number;
  /** How many `send` calls reached the port (counting fake only; -1 for another port). */
  sendCalls: number;
  /** How many `findSent` calls reached the port (counting fake only; -1 for another port). */
  findCalls: number;
  /** One entry per child: the signal that ended it. */
  signals: (NodeJS.Signals | null)[];
  /** The owner's actions as the machine saw them, in order. */
  actions: ActionRecord[];
  /** Deliveries / `send` calls from the first Send anyway the machine did not refuse on (0 without one; -1: another port). */
  newDeliveries: number;
  newSendCalls: number;
}

/** An action of the journal with its outcome: `killed` is an action whose call never returned (the process died in it). */
export interface ActionRecord {
  do: ActionSpec['do'];
  life: number;
  at: number;
  state?: string;
  reason?: string;
  outcome: 'ok' | 'refused' | 'killed';
  sentence?: string;
}

function readJournal(path: string): ActionRecord[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as JournalLine);
  return lines
    .filter(l => l.phase === 'issued')
    .map(issued => {
      const end = lines.find(l => l.key === issued.key && l.phase !== 'issued');
      return {
        do: issued.do!,
        life: issued.life!,
        at: issued.at!,
        state: issued.state,
        reason: issued.reason,
        outcome: end ? (end.phase as 'ok' | 'refused') : 'killed',
        ...(end?.sentence ? { sentence: end.sentence } : {}),
      };
    });
}

interface ChildEnd {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function runChild(point: KillStep, run: RunSpec, children: Set<ChildProcess>): Promise<ChildEnd> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', CHILD], {
      cwd: join(import.meta.dirname, '..', '..', '..', '..'),
      env: { ...process.env, [KILL_ENV]: point, [RUN_ENV]: JSON.stringify(run) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.add(child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => (stdout += String(chunk)));
    child.stderr.on('data', chunk => (stderr += String(chunk)));
    child.on('error', reject);
    // 'close', not 'exit': 'exit' can fire before the last of stdout was read (an empty list under load).
    child.on('close', (code, signal) => {
      children.delete(child);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

/** Set by the first hung scenario: the rest of the suite fails at once instead of waiting out its own budget. */
let hungScenario: string | undefined;

/** The rows' states as a hung scenario left them, read from its store file (the spinning child is already dead). */
function stateOf(dbPath: string): string {
  try {
    const db = openSqlite(dbPath);
    const rows = db.prepare('SELECT state FROM submissions ORDER BY id').all() as {
      state: string;
    }[];
    db.close();
    return rows.map(r => r.state).join(',');
  } catch (error) {
    return `unreadable (${String(error)})`;
  }
}

/** Runs one scenario end to end and returns what the restarted engine and the server say. */
export async function runKillScenario(scenario: KillScenario): Promise<KillResult> {
  if (hungScenario) throw new Error(`not run: an earlier scenario hung (${hungScenario})`);
  const dir = mkdtempSync(join(tmpdir(), 'aplos-kill-'));
  const children = new Set<ChildProcess>();
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      for (const child of children) child.kill('SIGKILL');
      hungScenario = `state=${stateOf(join(dir, 'mail.db'))}`;
      reject(
        new Error(
          `did not settle: ${hungScenario} after ${SCENARIO_BUDGET_MS} ms wall clock (kill step ${JSON.stringify(scenario.killAt)})`,
        ),
      );
    }, SCENARIO_BUDGET_MS);
  });
  try {
    return await Promise.race([runIn(dir, scenario, children), late]);
  } finally {
    clearTimeout(timer);
    for (const child of children) child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The counting fake as the scenario configures it. */
function fakePort(s: KillScenario, logPath: string): PortSpec {
  return {
    module: FAKE_PORT,
    config: {
      logPath,
      deliver: s.deliver ?? true,
      find: s.find ?? 'finds',
      ...(s.indexLagMs !== undefined ? { indexLagMs: s.indexLagMs } : {}),
      ...(s.serverClockOffsetMs !== undefined
        ? { serverClockOffsetMs: s.serverClockOffsetMs }
        : {}),
      ...(s.refuse !== undefined ? { refuse: s.refuse } : {}),
      ...(s.answerLost ? { answerLost: true } : {}),
      ...(s.script ? { script: s.script } : {}),
    },
  };
}

async function runIn(
  dir: string,
  s: KillScenario,
  children: Set<ChildProcess>,
): Promise<KillResult> {
  const dbPath = join(dir, 'mail.db');
  const logPath = join(dir, 'server.jsonl');
  const port: PortSpec = s.port ?? fakePort(s, logPath);
  const journalPath = join(dir, 'actions.jsonl');
  const moves = [s.onMove ?? []].flat();
  let duringCommit = 0;
  const sent = await seed(dbPath);
  const points = typeof s.killAt === 'string' ? [s.killAt] : s.killAt;
  const downtime = s.downtimeMs ?? 20 * SEC;
  let clockStart = T0;
  const signals: KillResult['signals'] = [];
  const lifeSpec = (life: number, runMs: number, point?: KillStep): RunSpec => {
    const spec: RunSpec = { dbPath, clockStart, runMs, port, journalPath, life };
    const actions = (s.actions ?? []).filter(a => (a.life ?? 0) === life);
    if (actions.length) spec.actions = actions;
    if (point === KP.DURING_COMMIT) {
      const move = moves[duringCommit++];
      if (!move) throw new Error('a during-commit step needs its move in `onMove`');
      spec.move = move;
    }
    return spec;
  };
  for (const [life, point] of points.entries()) {
    const runMs = LIFE_MS[point] ?? s.killedRunMs ?? KILLED_RUN_MS;
    const end = await runChild(point, lifeSpec(life, runMs, point), children);
    const quiet = point === 'none' || point === 'quit';
    const wanted = quiet ? null : 'SIGKILL';
    assert.equal(
      end.signal,
      wanted,
      `kill point ${point} ended with exit ${end.code}, signal ${end.signal}: ${end.stderr.slice(-600)}`,
    );
    if (quiet) assert.equal(end.code, 0);
    signals.push(end.signal);
    clockStart += runMs + downtime;
  }
  // The last life runs in a child too: an engine that spins is killed with its process, never hangs the suite.
  const runMs = s.recoverMs ?? 180 * SEC;
  const last = await runChild('none', lifeSpec(points.length, runMs), children);
  assert.ok(
    last.code === 0,
    `the restarted engine failed (exit ${last.code}): ${last.stderr.slice(-600)}`,
  );
  const list = JSON.parse(last.stdout) as Submission[];
  const submission = list.find(x => x.id === sent.id);
  assert.ok(submission, 'the submission row is still there after the restart');
  return summarize(s, { submission, sent, logPath, journalPath, signals });
}

/** What the server's record, the journal and the final row say about one scenario. */
async function summarize(
  s: KillScenario,
  from: {
    submission: Submission;
    sent: { internetId: string };
    logPath: string;
    journalPath: string;
    signals: KillResult['signals'];
  },
): Promise<KillResult> {
  const { submission, sent, logPath, signals } = from;
  const fake = s.port === undefined;
  const log = fake ? readLog(logPath).filter(l => l.internetId === sent.internetId) : [];
  const deliveries = s.countDeliveries
    ? await s.countDeliveries(sent.internetId)
    : (deliveryCounts(logPath).get(sent.internetId) ?? 0);
  const actions = readJournal(from.journalPath);
  const anyway = actions.find(a => a.do === 'sendAnyway' && a.outcome !== 'refused');
  const after = (op: 'send' | 'deliver') =>
    anyway ? log.filter(l => l.op === op && l.at >= anyway.at).length : 0;
  return {
    submission,
    deliveries,
    sendCalls: fake ? log.filter(l => l.op === 'send').length : -1,
    findCalls: fake ? log.filter(l => l.op === 'findSent').length : -1,
    signals,
    actions,
    newDeliveries: fake ? after('deliver') : -1,
    newSendCalls: fake ? after('send') : -1,
  };
}

// ---------------------------------------------------------------- the invariant

/**
 * What must hold after any kill and restart, whatever the server did. Never two deliveries, except the one the owner
 * chose: after Send anyway (the machine accepted it, or died inside accepting it) at most ONE new delivery and ONE new
 * `send` call on top of the one an earlier life may already have made. Never a lost message: the row ends `sent`, `failed`
 * with a reason, `uncertain` with the prompt, or `suspended` with the overdue sentence; or `cancelled` when the owner did
 * it, and a cancelled message the server has was cancelled from the prompt (the owner saw "Check Sent, or Send anyway"):
 * never `cancelled` AND delivered with no prompt, never `queued` or `sending`. Never a lie: `sent` means the server has
 * it, and `failed` ("not sent, Retry") never stands on a message the server accepted.
 */
export function assertSendInvariant(r: KillResult): void {
  const { submission: s } = r;
  const anyway = r.actions.some(a => a.do === 'sendAnyway' && a.outcome !== 'refused');
  if (!anyway) {
    assert.ok(r.deliveries <= 1, `delivered ${r.deliveries} times`);
    assert.ok(r.sendCalls <= 1, `send was called ${r.sendCalls} times for one Message-ID`);
  } else if (r.newDeliveries >= 0) {
    assert.ok(r.newDeliveries <= 1, `Send anyway delivered ${r.newDeliveries} new times`);
    assert.ok(r.newSendCalls <= 1, `Send anyway called send ${r.newSendCalls} new times`);
    assert.ok(r.deliveries - r.newDeliveries <= 1, 'delivered twice before Send anyway');
    assert.ok(r.sendCalls - r.newSendCalls <= 1, 'send called twice before Send anyway');
  } else assert.ok(r.deliveries <= 2, `delivered ${r.deliveries} times`);
  const cancel = r.actions.find(a => a.outcome === 'ok' && (a.do === 'undo' || a.do === 'cancel'));
  const settled = ['sent', 'failed', 'uncertain', 'suspended', ...(cancel ? ['cancelled'] : [])];
  assert.ok(
    settled.includes(s.state),
    `ended ${s.state}, which is neither settled nor asking the owner`,
  );
  if (s.state === 'cancelled' && r.deliveries > 0)
    assert.ok(
      cancel?.state === 'uncertain' && cancel.reason === 'send.uncertain',
      'cancelled and delivered, but the owner never saw the prompt',
    );
  if (s.state === 'sent')
    assert.ok(r.deliveries >= 1, '`sent` without a delivery is a lost message');
  if (s.state === 'uncertain') {
    assert.equal(s.problem?.reasonCode, 'send.uncertain');
    assert.equal(s.problem?.message, UNCERTAIN_COPY);
  }
  if (s.state === 'failed' || s.state === 'suspended')
    assert.ok(s.problem?.message, `${s.state} must say why`);
  if (s.state === 'failed') assert.equal(r.deliveries, 0, '`failed` on a message the server has');
  if (s.state === 'suspended') assert.equal(r.deliveries, 0);
}
