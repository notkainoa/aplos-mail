import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Submission } from '@aplos/contract';
import { openSqlite } from '../../../../apps/desktop/src/host/sqlite';
import { createTimerLoop, fakeClock, type FakeClock } from '../../src/clock/module';
import { createLogger } from '../../src/diag/log';
import { UNCERTAIN_COPY } from '../../src/outbox/context';
import type { KillPoint } from '../../src/outbox/killpoints';
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
}

export async function loadPort(spec: PortSpec, clock: FakeClock): Promise<SendPort> {
  const mod = (await import(pathToFileURL(spec.module).href)) as {
    createSendPort(env: PortEnv): SendPort | Promise<SendPort>;
  };
  return mod.createSendPort({ clock, config: spec.config });
}

/** One engine life on `dbPath`: opens it, starts (the real start rule), lets `runMs` of fake time pass, closes. */
export async function driveEngine(run: RunSpec): Promise<Submission[]> {
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
    blobs: { get: () => undefined },
  });
  outbox.start();
  loop.start();
  // Fine steps while the checks run (they are due at once and after 60 s), minutes after that.
  for (let at = 0; at < run.runMs;) {
    const step = at < 3 * 60 * SEC ? 5 * SEC : 60 * SEC;
    await clock.advance(step);
    await settle(clock, loop, outbox);
    at += step;
  }
  const ids = store.read(q => q.all<{ id: string }>('SELECT id FROM submissions ORDER BY id'));
  const found = outbox.service.get(ids.map(r => r.id)).list;
  loop.stop();
  await outbox.close();
  store.close();
  return found;
}

async function settle(
  clock: FakeClock,
  loop: { idle(): Promise<void> },
  outbox: { idle(): Promise<void> },
) {
  for (let i = 0; i < 3; i++) {
    await clock.flush();
    await loop.idle();
    await outbox.idle();
  }
}

// ---------------------------------------------------------------- seeding

function seed(dbPath: string): { id: string; internetId: string } {
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
  const { submission } = outbox.service.set('seed-send', {
    type: 'send',
    draftId: 'd1',
    revision: 1,
  });
  store.close();
  assert.equal(submission.notBefore, SEND_DUE, 'the seed is due after the default undo window');
  return { id: submission.id, internetId: submission.internetId };
}

// ---------------------------------------------------------------- the scenario

/** `none`: a life that is not killed and runs to its end (the prompt shows, then the app is quit and restarted). */
export type KillStep = KillPoint | 'none';

export interface KillScenario {
  /** The kill point of each engine life before the last, in order: one entry per child process. */
  killAt: KillStep | readonly KillStep[];
  /** The port both the children and the final restart use. Default: the counting fake with `deliver` and `find`. */
  port?: PortSpec;
  /** The counting fake only: does the server accept the bytes? (default true) */
  deliver?: boolean;
  /** The counting fake only: what `findSent` says after a delivery (default `finds`). */
  find?: 'finds' | 'lags' | 'throws';
  /** Fake time between one life's end and the next life's start (default 20 s). Past 5 minutes the overdue rule applies. */
  downtimeMs?: number;
  /** How long the last life runs; the default (3 minutes) passes the 60 s recheck. */
  recoverMs?: number;
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
}

interface ChildEnd {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

function runChild(point: KillStep, run: RunSpec): Promise<ChildEnd> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', CHILD], {
      cwd: join(import.meta.dirname, '..', '..', '..', '..'),
      env: { ...process.env, [KILL_ENV]: point, [RUN_ENV]: JSON.stringify(run) },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', chunk => (stderr += String(chunk)));
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve({ code, signal, stderr }));
  });
}

/** Runs one scenario end to end and returns what the restarted engine and the server say. */
export async function runKillScenario(scenario: KillScenario): Promise<KillResult> {
  const dir = mkdtempSync(join(tmpdir(), 'aplos-kill-'));
  try {
    return await runIn(dir, scenario);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function runIn(dir: string, s: KillScenario): Promise<KillResult> {
  const dbPath = join(dir, 'mail.db');
  const logPath = join(dir, 'server.jsonl');
  const port: PortSpec = s.port ?? {
    module: FAKE_PORT,
    config: { logPath, deliver: s.deliver ?? true, find: s.find ?? 'finds' },
  };
  const sent = seed(dbPath);
  const points = typeof s.killAt === 'string' ? [s.killAt] : s.killAt;
  const downtime = s.downtimeMs ?? 20 * SEC;
  let clockStart = T0;
  const signals: KillResult['signals'] = [];
  for (const point of points) {
    const runMs = point === 'none' ? QUIET_RUN_MS : KILLED_RUN_MS;
    const end = await runChild(point, { dbPath, clockStart, runMs, port });
    const wanted = point === 'none' ? null : 'SIGKILL';
    assert.equal(
      end.signal,
      wanted,
      `kill point ${point} ended with exit ${end.code}, signal ${end.signal}: ${end.stderr.slice(-600)}`,
    );
    if (point === 'none') assert.equal(end.code, 0);
    signals.push(end.signal);
    clockStart += runMs + downtime;
  }
  const list = await driveEngine({ dbPath, clockStart, runMs: s.recoverMs ?? 180 * SEC, port });
  const submission = list.find(x => x.id === sent.id);
  assert.ok(submission, 'the submission row is still there after the restart');
  const fake = s.port === undefined;
  const log = fake ? readLog(logPath).filter(l => l.internetId === sent.internetId) : [];
  const deliveries = s.countDeliveries
    ? await s.countDeliveries(sent.internetId)
    : (deliveryCounts(logPath).get(sent.internetId) ?? 0);
  return {
    submission,
    deliveries,
    sendCalls: fake ? log.filter(l => l.op === 'send').length : -1,
    findCalls: fake ? log.filter(l => l.op === 'findSent').length : -1,
    signals,
  };
}

// ---------------------------------------------------------------- the invariant

/**
 * What must hold after any kill and restart, whatever the server did. Never two deliveries. Never a lost message:
 * the row ends `sent`, `failed` with a reason, `uncertain` with the prompt, or `suspended` with the overdue sentence;
 * never `queued` or `sending`. Never a lie: `sent` means the server has it, and `failed` ("not sent, Retry") never
 * stands on a message the server accepted. The engine never calls `send` twice for one Message-ID.
 */
export function assertSendInvariant(r: KillResult): void {
  const { submission: s } = r;
  assert.ok(r.deliveries <= 1, `delivered ${r.deliveries} times`);
  assert.ok(r.sendCalls <= 1, `send was called ${r.sendCalls} times for one Message-ID`);
  assert.ok(
    ['sent', 'failed', 'uncertain', 'suspended'].includes(s.state),
    `ended ${s.state}, which is neither settled nor asking the owner`,
  );
  if (s.state === 'sent')
    assert.equal(r.deliveries, 1, '`sent` without a delivery is a lost message');
  if (s.state === 'uncertain') assert.equal(s.problem?.message, UNCERTAIN_COPY);
  if (s.state === 'failed' || s.state === 'suspended')
    assert.ok(s.problem?.message, `${s.state} must say why`);
  if (s.state === 'failed') assert.equal(r.deliveries, 0, '`failed` on a message the server has');
  if (s.state === 'suspended') assert.equal(r.deliveries, 0);
}
