#!/usr/bin/env node
// Idle-budget measurement (plan 40 Q3 deliverable 6; fills budgets.json rows idle.engine-rss,
// idle.cpu-10min and idle.wakeups). macOS only. Usage:
//   node scripts/audit/measure-idle.mjs <path-to-Aplos Mail.app> [--minutes 10] [--interval 5] [--settle 60] [--wakeup-seconds 30] [--json] [--out file.json]
//
// Launches the packaged app the way apps/desktop/scripts/verify-hardening-real-engine.mjs does:
// APLOS_TEST=1 + APLOS_ENGINE=real, a fresh mkdtemp APLOS_DATA_DIR and a random loopback
// --remote-debugging-port on argv. Never `open`, never a visible window, and never the real keychain
// or data dir (test mode uses Chromium's in-memory keychain and the given data dir;
// APLOS_TEST_KEYCHAIN, APLOS_TEST_SHOW_WINDOWS and APLOS_TEST_CDP_PORT are stripped from the child
// env so a leaked parent setting can never show windows or touch the login keychain). A release
// build ignores APLOS_TEST and refuses the debug port
// with exit 78 — this needs a local build (npm run package -w @aplos/desktop).
// Once "engine: real engine ready" is printed, every page window is closed over CDP
// (Runtime.evaluate window.close(), like verify-resident.mjs; the /json/close endpoint is the
// fallback for a window that ignores it). On macOS window-all-closed does not quit, so the app then
// sits in resident mode: no window, engine still running. If closing the windows quits the app it is
// relaunched once and measured with its window hidden, and the report says so in `mode`.
// After a --settle-second wait (default 60, so startup and first-sync work is not counted as idle),
// for --minutes it runs `ps -o pid=,rss=,pcpu=,time= -p <engine,main,renderers>` every --interval
// seconds (pid= is added to the plan's column list so one call covers all of them) and ends with a
// single `top -l <wakeup-seconds+1> -pid <engine> -stats pid,cpu,idlew`, reporting the median and
// max idle wake-ups per second over samples 2..<wakeup-seconds+1> (the first sample is invalid for
// CPU per man top); --wakeup-seconds defaults to 30 and must be at least 5. powermetrics needs
// sudo, so energy stays a hand check (the plan's note). RSS here is `ps rss`, not Activity Monitor's
// footprint — fine for tighten-only budgets. MB is MiB: ps rss is in KB. The engine is the main
// pid's --type=utility child; the pick prefers the --aplos-engine=real argument (together with the
// engine's --service-name when present), then the node.mojom.NodeService marker verify-release.mjs
// asserts on, then a sole utility child, then the lowest pid — `enginePickedBy` records which. All
// DevTools http and WebSocket I/O carries a 5 s deadline, so a wedged debugging port fails clearly
// instead of hanging the run.
// Reports engine RSS (median and max over the samples), CPU percent for the whole window (ps cputime
// delta over wall time, never the instantaneous pcpu), wake-ups/sec, and main plus renderer RSS for
// context. --json prints { idleEngineRssMb, idleCpuPercent, idleWakeupsPerSec, ... }; --out writes
// the same object. A run where the app died mid-window or the measured window came out under 80% of
// --minutes is `complete:false` — still reported and written to --out, but the table prints an
// INCOMPLETE line and the exit code is 1 so a partial window can never pass a budget. Exit 0 on a
// complete measured run, 1 on an incomplete or unmeasurable one, 2 on usage or environment errors.
// The finally always SIGTERMs then SIGKILLs the app and sweeps every pid it ever saw as the app's
// own descendant — kept in a set because a dead parent's helpers reparent to launchd at once and a
// late ppid scan would never find them again (never a command-line match, so other apps on this Mac
// stay safe) — and removes the temp dir; an exit handler does the same sweep so a crash leaves no
// process or directory behind.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const usage =
  'usage: node scripts/audit/measure-idle.mjs <path-to-Aplos Mail.app> [--minutes 10] [--interval 5] [--settle 60] [--wakeup-seconds 30] [--json] [--out file.json]';
// KB per MB: ps rss prints kilobytes, so rssKb / 1024 is MiB — the same MB measure-budgets uses.
const kbPerMb = 1024;
const tempPrefix = 'aplos-idle-';
const readyLine = 'engine: real engine ready';
const devToolsPort = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/;
const engineServiceName = /--service-name=Aplos Mail Engine/;
const releaseRefusalExit = 78;
const engineReadyTimeoutMs = 45_000;
const pageWaitMs = 90_000;
const closeWaitMs = 15_000;
const quitGraceMs = 2_000;
const sigtermWaitMs = 15_000;
const devToolsIoTimeoutMs = 5_000;
const maxOutputLines = 500;
const defaultWakeupSeconds = 30;

// ---------- pure functions (unit-tested in tests/measure-idle.test.mjs) ----------

/** Seconds from a ps TIME field: 'S', 'M:SS(.cc)', 'H:MM:SS(.cc)' or 'D-H:MM:SS'. NaN when malformed. */
export function cputimeSeconds(text) {
  const trimmed = String(text).trim();
  const days = trimmed.match(/^(\d+)-/);
  const rest = days ? trimmed.slice(days[0].length) : trimmed;
  const parts = rest.split(':');
  if (parts.length > 3 || parts.some(part => !/^\d+(?:\.\d+)?$/.test(part))) return NaN;
  const [a, b, c] = parts.map(Number);
  const within = days ? Number(days[1]) * 86_400 : 0;
  if (parts.length === 1) return within + a;
  if (parts.length === 2) return within + a * 60 + b;
  return within + a * 3600 + b * 60 + c;
}

/** Rows of `ps -axo pid=,ppid=,command=` as { pid, ppid, command }; malformed lines are skipped. */
export function parsePsTree(text) {
  const rows = [];
  for (const line of String(text).split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S.*)$/);
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] });
  }
  return rows;
}

/** One `ps -o pid=,rss=,pcpu=,time=` run as Map(pid -> { rssKb, pcpu, cputime }); bad lines are skipped. */
export function parsePsSample(text) {
  const rows = new Map();
  for (const line of String(text).split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+(?:\.\d+)?)\s+(\S+)$/);
    if (!match) continue;
    const cputime = cputimeSeconds(match[4]);
    if (Number.isNaN(cputime)) continue;
    rows.set(Number(match[1]), {
      rssKb: Number(match[2]),
      pcpu: Number(match[3]),
      cputime,
    });
  }
  return rows;
}

/** Direct children of `pid` in a parsePsTree listing. */
export function childrenOf(rows, pid) {
  return rows.filter(row => row.ppid === pid);
}

/** Every descendant pid of `pid` (its children, then theirs, ...); the pid itself is not included. */
export function descendantsOf(rows, pid) {
  const byParent = new Map();
  for (const row of rows) {
    const list = byParent.get(row.ppid) ?? [];
    list.push(row.pid);
    byParent.set(row.ppid, list);
  }
  const found = [];
  const seen = new Set([pid]);
  const queue = [pid];
  while (queue.length) {
    for (const child of byParent.get(queue.shift()) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}

/** The main pid's renderer children (`--type=renderer`), as pids. */
export function rendererPids(rows, mainPid) {
  return childrenOf(rows, mainPid)
    .filter(row => row.command.includes('--type=renderer'))
    .map(row => row.pid);
}

/**
 * The engine utility process: a direct child of the app main pid whose command line carries
 * --type=utility. Prefers the engine-specific markers — the --aplos-engine=real argument the fork
 * passes, strongest together with the engine's --service-name — then the generic
 * node.mojom.NodeService marker (which any node utility child could carry), then a sole utility
 * child, then the lowest pid (the engine is forked at boot, before any later utility child).
 * Returns { pid, how } or null; `how` records which rule picked it for the report.
 */
export function chooseEngineProcess(rows, mainPid) {
  const utilities = childrenOf(rows, mainPid).filter(row => row.command.includes('--type=utility'));
  if (!utilities.length) return null;
  const named = utilities.find(
    row => row.command.includes('--aplos-engine=real') && engineServiceName.test(row.command),
  );
  if (named) return { pid: named.pid, how: '--service-name and --aplos-engine=real markers' };
  const real = utilities.find(row => row.command.includes('--aplos-engine=real'));
  if (real) return { pid: real.pid, how: '--aplos-engine=real argument' };
  const marker = utilities.find(row => row.command.includes('node.mojom.NodeService'));
  if (marker) return { pid: marker.pid, how: 'node.mojom.NodeService marker' };
  if (utilities.length === 1) return { pid: utilities[0].pid, how: 'the only utility child' };
  const lowest = utilities.reduce((a, b) => (a.pid < b.pid ? a : b));
  return { pid: lowest.pid, how: `lowest pid of ${utilities.length} utility children` };
}

/**
 * Every post-first `top -l N -stats pid,cpu,idlew` sample's row for `pid`, as a list of
 * { cpu, idlew } in sample order. The first table is skipped: per man top it is invalid for CPU.
 * Each table's header names the columns; when a wider row appears (a COMMAND column holds spaces)
 * the named columns are read from the right. A dead pid still prints headers, just no rows.
 */
export function parseTopSamples(text, pid) {
  const lines = String(text).split('\n');
  const headers = [];
  lines.forEach((line, index) => {
    const names = line.trim().split(/\s+/);
    if (names[0] === 'PID' && names.includes('IDLEW')) headers.push({ index, names });
  });
  const samples = [];
  for (let h = 1; h < headers.length; h++) {
    const header = headers[h];
    const sectionEnd = headers[h + 1]?.index ?? lines.length;
    const idlewAt = header.names.indexOf('IDLEW');
    const cpuAt = header.names.indexOf('%CPU');
    if (idlewAt < 0 || cpuAt < 0) continue;
    for (const line of lines.slice(header.index + 1, sectionEnd)) {
      const fields = line.trim().split(/\s+/);
      if (fields[0] !== String(pid)) continue;
      if (fields.length < header.names.length) break;
      // A COMMAND column widens the row past the header count, so columns after it are read from
      // the right instead of the left.
      const at = nameAt =>
        fields.length === header.names.length
          ? fields[nameAt]
          : fields[fields.length - (header.names.length - nameAt)];
      samples.push({ cpu: parseFloat(at(cpuAt)), idlew: parseFloat(at(idlewAt)) });
      break;
    }
  }
  return samples;
}

/** Median of a list of numbers; NaN for an empty one. */
export function median(numbers) {
  if (!numbers.length) return NaN;
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** CPU percent = cputime seconds gained over the window / wall seconds × 100; null with no span. */
export function cpuPercent(firstSeconds, lastSeconds, wallSeconds) {
  if (!(wallSeconds > 0)) return null;
  return ((lastSeconds - firstSeconds) / wallSeconds) * 100;
}

const numberFlag = (flag, value, minimum) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum)
    throw new Error(`${flag} needs a number of at least ${minimum}`);
  return number;
};

/** CLI args -> { app, minutes, interval, settle, wakeupSeconds, json, out }; throws on bad input. */
export function parseArgs(argv) {
  const options = {
    app: null,
    minutes: 10,
    interval: 5,
    settle: 60,
    wakeupSeconds: defaultWakeupSeconds,
    json: false,
    out: null,
  };
  const args = [...argv];
  while (args.length) {
    const arg = args.shift();
    if (arg === '--json') options.json = true;
    else if (arg === '--minutes') options.minutes = numberFlag(arg, args.shift(), 1);
    else if (arg === '--interval') options.interval = numberFlag(arg, args.shift(), 1);
    else if (arg === '--settle') options.settle = numberFlag(arg, args.shift(), 0);
    else if (arg === '--wakeup-seconds') options.wakeupSeconds = numberFlag(arg, args.shift(), 5);
    else if (arg === '--out') {
      options.out = args.shift();
      if (!options.out) throw new Error('--out needs a file');
    } else if (arg.startsWith('-')) throw new Error(`unknown argument ${arg}`);
    else if (!options.app) options.app = arg;
    else throw new Error(`unexpected argument ${arg}`);
  }
  if (!options.app) throw new Error(usage);
  return options;
}

/** The report fields a table row shows ('n/a' for a number that could not be measured). */
export function shown(value, unit = '') {
  if (value == null || Number.isNaN(value)) return 'n/a';
  return `${value}${unit}`;
}

/** The last `maxLines` of `lines` — run.output keeps only a tail so a chatty app cannot grow it. */
export function tailLines(lines, maxLines = maxOutputLines) {
  return lines.length > maxLines ? lines.slice(-maxLines) : lines;
}

// ---------- running ----------

const delay = ms => new Promise(r => setTimeout(r, ms));
const safeJson = text => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};
const round = (number, places) => Math.round(number * 10 ** places) / 10 ** places;
const ps = args => spawnSync('ps', args, { encoding: 'utf8', timeout: 10_000 }).stdout ?? '';
const psTree = () => parsePsTree(ps(['-axo', 'pid=,ppid=,command=']));

const spawned = new Set();
// Every pid this run ever saw as its own process or descendant: main, engine, renderers and
// anything found under them by ppid. The cleanup sweep kills exactly these pids — never a name or
// command-line match — so a helper reparented to launchd still dies and other apps stay safe.
// Each pid is stored with its start time (`ps -o lstart=`): the OS may hand a dead helper's number to an
// unrelated process, and the sweep only signals a pid whose start time still matches.
export const seenPids = new Map();
let dataDir;

const startOf = pid => ps(['-o', 'lstart=', '-p', String(pid)]).trim();

/** Remembers a pid and when it started, once. */
function rememberPid(pid) {
  if (!pid || seenPids.has(pid)) return;
  const started = startOf(pid);
  if (started) seenPids.set(pid, started);
}

/**
 * Adds child.pid and its current ppid-descendants to seenPids — only while the child is alive.
 * Once it has exited its number is already reusable by the OS: recording it then would store an
 * unrelated process with its own start time, and the sweep would SIGKILL an innocent process.
 * Helpers the child leaves behind are already in seenPids from scans made while it lived.
 */
export function noteDescendants(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  rememberPid(child.pid);
  for (const pid of descendantsOf(psTree(), child.pid)) rememberPid(pid);
}

/** SIGKILLs every pid ever seen that still has the start time it had then; dead ones are ignored. */
function sweepSeenPids() {
  for (const [pid, started] of seenPids) {
    if (startOf(pid) !== started) continue;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

/**
 * Crash net, synchronous for process.on('exit'): collect the descendants, kill the parents, scan
 * once more for anything born in between, then sweep every pid ever seen — even when a child
 * already exited, because its helpers may live on reparented to launchd.
 */
function killNow() {
  for (const child of spawned) noteDescendants(child);
  for (const child of spawned) {
    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }
  for (const child of spawned) noteDescendants(child);
  sweepSeenPids();
  removeDataDir();
}

/** Guarded rm -rf: non-empty, under os.tmpdir(), carrying the mkdtemp marker. */
function removeDataDir() {
  if (!dataDir) return;
  const safe = dataDir.startsWith(tmpdir()) && basename(dataDir).startsWith(tempPrefix);
  if (safe) rmSync(dataDir, { recursive: true, force: true });
}

/** Registers the crash net: only inside main(), so importing the module for tests installs nothing. */
function watchCrashes() {
  process.on('exit', killNow);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      killNow();
      process.exit(signal === 'SIGINT' ? 130 : 143);
    });
  }
}

async function stopApp(child) {
  // Descendants are collected before SIGTERM too: a child the app's death orphans is reparented to
  // launchd at once, and a later ppid scan would never find it again. The seen-pids sweep runs even
  // when the app already exited on its own (child.exitCode set), reaching helpers a ppid scan can
  // no longer see.
  noteDescendants(child);
  if (child.exitCode === null) {
    child.kill('SIGTERM');
    const deadline = Date.now() + sigtermWaitMs;
    while (child.exitCode === null && Date.now() < deadline) await delay(200);
    noteDescendants(child);
    if (child.exitCode === null) child.kill('SIGKILL');
    await delay(500);
  }
  noteDescendants(child);
  sweepSeenPids();
}

/**
 * Spawns the app binary exactly like verify-hardening-real-engine.mjs and watches its output.
 * spawn() drops env entries whose value is undefined, so the APLOS_TEST_* overrides are explicitly
 * undefined: a parent env leaking APLOS_TEST_SHOW_WINDOWS or APLOS_TEST_KEYCHAIN=login would show a
 * window or touch the real login keychain, and a leaked APLOS_TEST_CDP_PORT would pin the debug
 * port instead of letting argv's --remote-debugging-port=0 pick a random one. `dir` defaults to the
 * run's mkdtemp APLOS_DATA_DIR and is a parameter only so tests can pass one.
 */
export function launchApp(exe, dir = dataDir) {
  const child = spawn(exe, ['--remote-debugging-port=0'], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: undefined,
      APLOS_TEST_KEYCHAIN: undefined,
      APLOS_TEST_SHOW_WINDOWS: undefined,
      APLOS_TEST_CDP_PORT: undefined,
      APLOS_TEST: '1',
      APLOS_DATA_DIR: dir,
      APLOS_ENGINE: 'real',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  spawned.add(child);
  const run = { child, output: [], port: null };
  run.engineReady = new Promise((resolveReady, rejectReady) => {
    run.resolveReady = resolveReady;
    run.rejectReady = rejectReady;
  });
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', chunk => {
      const text = chunk.toString();
      run.output = tailLines(run.output.concat(text.split('\n')));
      const match = text.match(devToolsPort);
      if (match) run.port = Number(match[1]);
      if (text.includes(readyLine)) run.resolveReady();
    });
  child.on('error', error => {
    run.rejectReady(new Error(`the app could not be launched: ${error?.message ?? error}`));
  });
  child.on('exit', code => {
    const reason =
      code === releaseRefusalExit
        ? 'the app refused --remote-debugging-port, so it was built with APLOS_RELEASE_BUILD=1; run this against a local build (npm run package -w @aplos/desktop)'
        : `the app exited (code ${code}) before the engine was ready`;
    run.rejectReady(new Error(reason));
  });
  // A late rejection after the ready race resolved must not be an unhandled rejection.
  run.engineReady.catch(() => {});
  return run;
}

async function waitEngineReady(run) {
  await Promise.race([
    run.engineReady,
    delay(engineReadyTimeoutMs).then(() => {
      throw new Error('engine did not report ready within 45 s');
    }),
  ]);
}

/** A clear, tagged error for a DevTools I/O deadline; callers rethrow it past their soft catches. */
const devToolsTimeout = message => Object.assign(new Error(message), { devToolsTimeout: true });

/** fetch() with a hard deadline; a timeout raises a clear tagged error instead of a bare AbortError. */
export async function devToolsFetch(url, options = {}, timeoutMs = devToolsIoTimeoutMs) {
  try {
    return await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    if (error?.name === 'TimeoutError')
      throw devToolsTimeout(`DevTools request timed out after ${timeoutMs} ms: ${url}`);
    throw error;
  }
}

async function listTargets(run) {
  if (!run.port) return [];
  try {
    return await (await devToolsFetch(`http://127.0.0.1:${run.port}/json/list`)).json();
  } catch (error) {
    // A wedged DevTools port is fatal; a refused one just means the app is not up yet.
    if (error?.devToolsTimeout) throw error;
    return [];
  }
}

/** Polls /json/list until a `page` target exists or the wait runs out; returns the last list. */
async function pageTargets(run, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let pages = [];
  for (;;) {
    pages = (await listTargets(run)).filter(target => target.type === 'page');
    if (pages.length || Date.now() > deadline || run.child.exitCode !== null) return pages;
    await delay(300);
  }
}

/** Runtime.evaluate on one page target over its own WebSocket (the verify script's CDP pattern). */
export async function evaluateOn(target, expression, timeoutMs = devToolsIoTimeoutMs) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  try {
    await new Promise((resolveOpen, rejectOpen) => {
      const timer = setTimeout(() => {
        rejectOpen(
          devToolsTimeout(`CDP WebSocket to ${target.id} did not open within ${timeoutMs} ms`),
        );
      }, timeoutMs);
      ws.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolveOpen();
        },
        { once: true },
      );
      ws.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          rejectOpen(new Error(`CDP WebSocket to ${target.id} failed to open`));
        },
        { once: true },
      );
    });
    const answered = new Promise(res => {
      ws.addEventListener('message', event => {
        const message = safeJson(event.data);
        if (message?.id === 1) res(message);
      });
    });
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression } }));
    let timer;
    const deadline = new Promise(res => {
      timer = setTimeout(res, 10_000);
    });
    await Promise.race([answered, deadline]);
    clearTimeout(timer);
  } finally {
    ws.close();
  }
}

/** Counts the page targets that remain after `ms` of polling. */
async function pagesRemaining(run, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    const pages = (await listTargets(run)).filter(target => target.type === 'page');
    if (!pages.length || Date.now() > deadline || run.child.exitCode !== null) return pages.length;
    await delay(300);
  }
}

/** Closes every page window: window.close() first, /json/close for any that stay. */
async function closeAllWindows(run) {
  for (const page of await pageTargets(run, pageWaitMs)) {
    try {
      await evaluateOn(page, 'window.close()');
    } catch (error) {
      // A wedged CDP channel is fatal; a refused socket just means the target already closed.
      if (error?.devToolsTimeout) throw error;
    }
  }
  let left = await pagesRemaining(run, closeWaitMs);
  if (left) {
    for (const page of await listTargets(run)) {
      if (page.type !== 'page') continue;
      try {
        await devToolsFetch(`http://127.0.0.1:${run.port}/json/close/${page.id}`, {
          method: 'PUT',
        });
      } catch (error) {
        // DevTools http going away with the app is fine — the poll below decides — but a wedged
        // port is fatal.
        if (error?.devToolsTimeout) throw error;
      }
    }
    left = await pagesRemaining(run, 10_000);
  }
  return left;
}

/** The app's CFBundleShortVersionString, or 'unknown'. */
function appVersion(appPath) {
  const run = spawnSync(
    '/usr/libexec/PlistBuddy',
    ['-c', 'Print:CFBundleShortVersionString', join(appPath, 'Contents', 'Info.plist')],
    { encoding: 'utf8', timeout: 10_000 },
  );
  const version = (run.stdout ?? '').trim();
  return run.status === 0 && version ? version : 'unknown';
}

/**
 * Launches the app, waits for the engine, closes every window and waits out --settle. Relaunches
 * once with the window hidden when closing the windows quit the app. Returns { run, mode }.
 */
async function launchResident(options, exe, notes) {
  let run = launchApp(exe);
  await waitEngineReady(run);
  let mode = 'resident';
  const remaining = await closeAllWindows(run);
  await delay(quitGraceMs);
  if (run.child.exitCode !== null) {
    notes.push('closing the windows quit the app; relaunched and measured with the window hidden');
    mode = 'window-hidden';
    run = launchApp(exe);
    await waitEngineReady(run);
  } else if (remaining) {
    notes.push(`${remaining} page target(s) stayed open; the run is not fully resident`);
    mode = 'window-open';
  }

  // The settle wait lets startup and first-sync work finish before the first sample counts.
  if (options.settle > 0) {
    if (!options.json)
      console.error(`settling ${options.settle} s so startup work is not counted as idle`);
    await delay(options.settle * 1000);
  }
  if (run.child.exitCode !== null)
    throw new Error(`the app exited (code ${run.child.exitCode}) during the settle period`);
  return { run, mode };
}

/**
 * One ps sample per --interval across the --minutes window; follows a restarted engine pid.
 * Returns { readings, mainKb, rendererKb, restarts, exitedEarly, enginePid }.
 */
async function sampleWindow({ options, run, enginePid, pids, rendererIds, notes }) {
  const state = { readings: [], mainKb: [], rendererKb: [], restarts: 0, exitedEarly: false };
  const endAt = Date.now() + options.minutes * 60_000;
  for (;;) {
    const at = Date.now();
    // Every pid ever seen goes into seenPids so cleanup can reach it even after reparenting.
    noteDescendants(run.child);
    for (const pid of pids) rememberPid(pid);
    let rows = parsePsSample(ps(['-o', 'pid=,rss=,pcpu=,time=', '-p', pids.join(',')]));
    if (!rows.has(enginePid) && run.child.exitCode === null) {
      // The supervisor restarts a dead engine; follow it and let the CPU window restart.
      const next = chooseEngineProcess(psTree(), run.child.pid);
      if (next && next.pid !== enginePid) {
        notes.push(`engine restarted during the window: pid ${enginePid} -> ${next.pid}`);
        state.restarts++;
        enginePid = next.pid;
        pids.push(enginePid);
        rememberPid(enginePid);
        rows = parsePsSample(ps(['-o', 'pid=,rss=,pcpu=,time=', '-p', pids.join(',')]));
      }
    }
    const engine = rows.get(enginePid);
    if (engine)
      state.readings.push({ at, pid: enginePid, rssKb: engine.rssKb, cputime: engine.cputime });
    const main = rows.get(run.child.pid);
    if (main) state.mainKb.push(main.rssKb);
    const rendererSum = rendererIds.reduce((sum, pid) => sum + (rows.get(pid)?.rssKb ?? 0), 0);
    if (rendererIds.length) state.rendererKb.push(rendererSum);
    if (!options.json)
      console.error(
        `sample ${state.readings.length} · engine ${engine ? shown(round(engine.rssKb / kbPerMb, 1), ' MB') : 'gone'} · pid ${enginePid}`,
      );
    if (run.child.exitCode !== null) {
      notes.push(`the app exited (code ${run.child.exitCode}) part-way through the window`);
      state.exitedEarly = true;
      break;
    }
    const left = endAt - Date.now();
    if (left <= 0) break;
    await delay(Math.min(options.interval * 1000, left));
  }
  return { ...state, enginePid };
}

/**
 * Resident-mode re-check after the window: a page target recreated mid-window (e.g. by app
 * 'activate') flips the mode to 'window-open' with a note; the run is not failed for it.
 */
async function recheckResident(run, mode, notes) {
  if (mode !== 'resident' || run.child.exitCode !== null) return mode;
  try {
    const reopened = (await listTargets(run)).filter(target => target.type === 'page');
    if (!reopened.length) return mode;
    notes.push(
      `${reopened.length} page target(s) reopened during the window; the run was not fully resident`,
    );
    return 'window-open';
  } catch (error) {
    notes.push(`the post-window DevTools check failed (${error?.message ?? error})`);
    return mode;
  }
}

/**
 * One `top -l <seconds+1>` run; the engine's idle wake-ups/sec of samples 2..seconds+1 (sample 1 is
 * invalid per man top). The spawn is bounded at seconds + 30 so a stuck top cannot hang the run.
 */
function engineWakeups(enginePid, seconds, notes) {
  const top = spawnSync(
    'top',
    ['-l', String(seconds + 1), '-pid', String(enginePid), '-stats', 'pid,cpu,idlew'],
    { encoding: 'utf8', timeout: (seconds + 30) * 1000 },
  ).stdout;
  const samples = parseTopSamples(top ?? '', enginePid).map(sample => sample.idlew);
  if (!samples.length)
    notes.push('top printed no post-first samples for the engine; wake-ups not measured');
  return samples;
}

/** The JSON/table report from the finished window state. */
export function buildReport({ options, appPath, mode, pick, state, wakeupSamples, notes }) {
  const { readings, mainKb, rendererKb, restarts, exitedEarly, enginePid } = state;
  // The CPU window covers only the final engine pid: a restart resets cputime, so readings from a
  // previous pid would mix lifetimes.
  const cpuReadings = readings.filter(r => r.pid === enginePid);
  const windowSeconds = (readings.at(-1).at - readings[0].at) / 1000;
  const cpuWallSeconds =
    cpuReadings.length >= 2 ? (cpuReadings.at(-1).at - cpuReadings[0].at) / 1000 : 0;
  const cpu =
    cpuReadings.length >= 2
      ? cpuPercent(cpuReadings[0].cputime, cpuReadings.at(-1).cputime, cpuWallSeconds)
      : null;
  const rssMb = readings.map(r => r.rssKb / kbPerMb);
  const expectedSeconds = options.minutes * 60;
  // A partial window is reported but can never pass a budget: under 80% of --minutes measured (or
  // the app dying mid-window) means complete:false and exit 1.
  const expectedReadings = Math.ceil(expectedSeconds / options.interval);
  const complete =
    !exitedEarly &&
    windowSeconds >= 0.8 * expectedSeconds &&
    readings.length >= 0.8 * expectedReadings;
  return {
    app: appPath,
    appVersion: appVersion(appPath),
    mode,
    complete,
    samples: readings.length,
    settleSeconds: options.settle,
    windowSeconds: round(windowSeconds, 1),
    windowExpectedSeconds: expectedSeconds,
    enginePid,
    enginePickedBy: pick.how,
    engineRestarts: restarts,
    idleEngineRssMb: round(median(rssMb), 1),
    idleEngineRssMaxMb: round(Math.max(...rssMb), 1),
    idleCpuPercent: cpu === null ? null : round(cpu, 2),
    idleWakeupsPerSec: wakeupSamples.length ? round(median(wakeupSamples), 1) : null,
    idleWakeupsPerSecMax: wakeupSamples.length ? round(Math.max(...wakeupSamples), 1) : null,
    wakeupSeconds: options.wakeupSeconds,
    wakeupSamples: wakeupSamples.length,
    mainRssMb: mainKb.length ? round(median(mainKb) / kbPerMb, 1) : null,
    rendererRssMb: rendererKb.length ? round(median(rendererKb) / kbPerMb, 1) : 0,
    notes,
  };
}

async function measure(options, exe, appPath) {
  const notes = [];
  const launched = await launchResident(options, exe, notes);
  const { run } = launched;
  const pick = chooseEngineProcess(psTree(), run.child.pid);
  if (!pick)
    throw new Error('no --type=utility child of the app main pid (is the real engine running?)');
  const rendererIds = rendererPids(psTree(), run.child.pid);
  const pids = [...new Set([pick.pid, run.child.pid, ...rendererIds])];
  const state = await sampleWindow({
    options,
    run,
    enginePid: pick.pid,
    pids,
    rendererIds,
    notes,
  });
  const mode = await recheckResident(run, launched.mode, notes);
  const wakeupSamples = engineWakeups(state.enginePid, options.wakeupSeconds, notes);
  if (!state.readings.length) throw new Error('the engine never answered a ps sample');
  return buildReport({ options, appPath, mode, pick, state, wakeupSamples, notes });
}

function printReport(report) {
  console.log(`measure-idle: ${report.app}`);
  console.log(`app version: ${report.appVersion} · mode: ${report.mode}`);
  if (!report.complete)
    console.log(
      `INCOMPLETE    only ${report.windowSeconds} s of the ${report.windowExpectedSeconds} s window was measured; these are partial results, not a budget pass`,
    );
  console.log(
    `samples: ${report.samples} over ${report.windowSeconds} s · settle ${report.settleSeconds} s · engine pid ${report.enginePid} (${report.enginePickedBy})`,
  );
  console.log(
    `engine RSS    median ${shown(report.idleEngineRssMb, ' MB')}   max ${shown(report.idleEngineRssMaxMb, ' MB')}`,
  );
  console.log(`engine CPU    ${shown(report.idleCpuPercent, ' %')} of wall-clock (cputime delta)`);
  console.log(
    `wake-ups      median ${shown(report.idleWakeupsPerSec, ' /s')}   max ${shown(report.idleWakeupsPerSecMax, ' /s')} (${report.wakeupSamples} samples over ${report.wakeupSeconds} s)`,
  );
  console.log(
    `context       main ${shown(report.mainRssMb, ' MB')}   renderers ${shown(report.rendererRssMb, ' MB')} (median)`,
  );
  for (const note of report.notes) console.log(`note: ${note}`);
}

async function main() {
  if (process.platform !== 'darwin') {
    console.error('measure-idle: macOS only (ps/top formats and the .app layout are darwin)');
    process.exit(2);
  }
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  const appPath = resolve(options.app);
  const exe = join(appPath, 'Contents/MacOS/Aplos Mail');
  if (!existsSync(exe)) {
    console.error(`measure-idle: no executable at ${exe}`);
    process.exit(2);
  }
  dataDir = mkdtempSync(join(tmpdir(), tempPrefix));
  watchCrashes();
  let code = 0;
  try {
    const report = await measure(options, exe, appPath);
    if (options.out) writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`);
    if (options.json) console.log(JSON.stringify(report));
    else printReport(report);
    if (!report.complete) code = 1;
  } catch (error) {
    console.error(`measure-idle: ${error?.message ?? error}`);
    code = 1;
  } finally {
    for (const child of spawned) await stopApp(child);
    removeDataDir();
  }
  process.exit(code);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error?.message ?? error);
    process.exit(2);
  });
}
