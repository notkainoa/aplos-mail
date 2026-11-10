#!/usr/bin/env node
// Idle-budget measurement (plan 40 Q3 deliverable 6; fills budgets.json rows idle.engine-rss,
// idle.cpu-10min and idle.wakeups). macOS only. Usage:
//   node scripts/audit/measure-idle.mjs <path-to-Aplos Mail.app> [--minutes 10] [--interval 5] [--json] [--out file.json]
//
// Launches the packaged app the way apps/desktop/scripts/verify-hardening-real-engine.mjs does:
// APLOS_TEST=1 + APLOS_ENGINE=real, a fresh mkdtemp APLOS_DATA_DIR and a random loopback
// --remote-debugging-port on argv. Never `open`, never a visible window, and never the real keychain
// or data dir (test mode uses Chromium's in-memory keychain and the given data dir;
// APLOS_TEST_KEYCHAIN stays unset). A release build ignores APLOS_TEST and refuses the debug port
// with exit 78 — this needs a local build (npm run package -w @aplos/desktop).
// Once "engine: real engine ready" is printed, every page window is closed over CDP
// (Runtime.evaluate window.close(), like verify-resident.mjs; the /json/close endpoint is the
// fallback for a window that ignores it). On macOS window-all-closed does not quit, so the app then
// sits in resident mode: no window, engine still running. If closing the windows quits the app it is
// relaunched once and measured with its window hidden, and the report says so in `mode`.
// Then for --minutes it runs `ps -o pid=,rss=,pcpu=,time= -p <engine,main,renderers>` every --interval
// seconds (pid= is added to the plan's column list so one call covers all of them) and ends with a
// single `top -l 2 -pid <engine> -stats pid,cpu,idlew`, reading the second sample's idle wake-ups per
// second. powermetrics needs sudo, so energy stays a hand check (the plan's note). MB is MiB: ps rss
// is in KB. The engine is the main pid's --type=utility child; the pick prefers the
// node.mojom.NodeService marker verify-release.mjs asserts on, then the --aplos-engine=real argument,
// then a sole utility child, then the lowest pid — `enginePickedBy` records which.
// Reports engine RSS (median and max over the samples), CPU percent for the whole window (ps cputime
// delta over wall time, never the instantaneous pcpu), wake-ups/sec, and main plus renderer RSS for
// context. --json prints { idleEngineRssMb, idleCpuPercent, idleWakeupsPerSec, ... }; --out writes the
// same object. Exit 0 when measured, 1 when the app or engine could not be measured, 2 on usage or
// environment errors. The finally always SIGTERMs then SIGKILLs the app, sweeps its descendants found
// by ppid (never a command-line match) and removes the temp dir; an exit handler does the same sweep
// so a crash leaves no process or directory behind.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const usage =
  'usage: node scripts/audit/measure-idle.mjs <path-to-Aplos Mail.app> [--minutes 10] [--interval 5] [--json] [--out file.json]';
// KB per MB: ps rss prints kilobytes, so rssKb / 1024 is MiB — the same MB measure-budgets uses.
const kbPerMb = 1024;
const tempPrefix = 'aplos-idle-';
const readyLine = 'engine: real engine ready';
const devToolsPort = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/;
const releaseRefusalExit = 78;
const engineReadyTimeoutMs = 45_000;
const pageWaitMs = 90_000;
const closeWaitMs = 15_000;
const residentSettleMs = 2_000;
const sigtermWaitMs = 15_000;

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
 * --type=utility. Prefers the node.mojom.NodeService marker (the one verify-release.mjs asserts on),
 * then the --aplos-engine=real argument the fork passes, then a sole utility child, then the lowest
 * pid (the engine is forked at boot, before any later utility child). Returns { pid, how } or null;
 * `how` records which rule picked it for the report.
 */
export function chooseEngineProcess(rows, mainPid) {
  const utilities = childrenOf(rows, mainPid).filter(row => row.command.includes('--type=utility'));
  if (!utilities.length) return null;
  const marker = utilities.find(row => row.command.includes('node.mojom.NodeService'));
  if (marker) return { pid: marker.pid, how: 'node.mojom.NodeService marker' };
  const real = utilities.find(row => row.command.includes('--aplos-engine=real'));
  if (real) return { pid: real.pid, how: '--aplos-engine=real argument' };
  if (utilities.length === 1) return { pid: utilities[0].pid, how: 'the only utility child' };
  const lowest = utilities.reduce((a, b) => (a.pid < b.pid ? a : b));
  return { pid: lowest.pid, how: `lowest pid of ${utilities.length} utility children` };
}

/**
 * The second `top -l 2 -stats pid,cpu,idlew` sample's row for `pid`: { cpu, idlew } or null. The
 * header of the second table names the columns; when a wider row appears (a COMMAND column holds
 * spaces) the named columns are read from the right. A dead pid still prints the header, just no row.
 */
export function parseTopSample(text, pid) {
  const lines = String(text).split('\n');
  const headers = [];
  lines.forEach((line, index) => {
    const names = line.trim().split(/\s+/);
    if (names[0] === 'PID' && names.includes('IDLEW')) headers.push({ index, names });
  });
  const second = headers[1];
  if (!second) return null;
  const idlewAt = second.names.indexOf('IDLEW');
  const cpuAt = second.names.indexOf('%CPU');
  if (idlewAt < 0 || cpuAt < 0) return null;
  for (const line of lines.slice(second.index + 1)) {
    const fields = line.trim().split(/\s+/);
    if (fields[0] !== String(pid)) continue;
    if (fields.length < second.names.length) return null;
    // A COMMAND column widens the row past the header count, so columns after it are read from
    // the right instead of the left.
    const at = nameAt =>
      fields.length === second.names.length
        ? fields[nameAt]
        : fields[fields.length - (second.names.length - nameAt)];
    return { cpu: parseFloat(at(cpuAt)), idlew: parseFloat(at(idlewAt)) };
  }
  return null;
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

/** CLI args -> { app, minutes, interval, json, out }; throws on anything unexpected. */
export function parseArgs(argv) {
  const options = { app: null, minutes: 10, interval: 5, json: false, out: null };
  const args = [...argv];
  while (args.length) {
    const arg = args.shift();
    if (arg === '--json') options.json = true;
    else if (arg === '--minutes') options.minutes = numberFlag(arg, args.shift(), 0);
    else if (arg === '--interval') options.interval = numberFlag(arg, args.shift(), 1);
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

// ---------- running ----------

const delay = ms => new Promise(r => setTimeout(r, ms));
const round = (number, places) => Math.round(number * 10 ** places) / 10 ** places;
const ps = args => spawnSync('ps', args, { encoding: 'utf8' }).stdout ?? '';
const psTree = () => parsePsTree(ps(['-axo', 'pid=,ppid=,command=']));

const spawned = new Set();
let dataDir;

/** SIGKILLs every process we spawned and its descendants found by ppid, then removes the temp dir. */
function killNow() {
  for (const child of spawned) {
    if (child.exitCode !== null) continue;
    for (const pid of descendantsOf(psTree(), child.pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }
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
  // launchd at once, and a later ppid scan would never find it again.
  const descendants = new Set();
  const collect = () => {
    for (const pid of descendantsOf(psTree(), child.pid)) descendants.add(pid);
  };
  if (child.exitCode === null) {
    collect();
    child.kill('SIGTERM');
    const deadline = Date.now() + sigtermWaitMs;
    while (child.exitCode === null && Date.now() < deadline) await delay(200);
    collect();
    if (child.exitCode === null) child.kill('SIGKILL');
    await delay(500);
    collect();
  }
  for (const pid of descendants) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

/** Spawns the app binary exactly like verify-hardening-real-engine.mjs and watches its output. */
function launchApp(exe) {
  const child = spawn(exe, ['--remote-debugging-port=0'], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: undefined,
      APLOS_TEST: '1',
      APLOS_DATA_DIR: dataDir,
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
      run.output.push(text);
      const match = text.match(devToolsPort);
      if (match) run.port = Number(match[1]);
      if (text.includes(readyLine)) run.resolveReady();
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

async function listTargets(run) {
  if (!run.port) return [];
  try {
    return await (await fetch(`http://127.0.0.1:${run.port}/json/list`)).json();
  } catch {
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
async function evaluateOn(target, expression) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  try {
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });
    const answered = new Promise(res => {
      ws.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        if (message.id === 1) res(message);
      });
    });
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression } }));
    await Promise.race([answered, delay(10_000)]);
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
    } catch {
      // The target closed or refused the socket; the poll below decides.
    }
  }
  let left = await pagesRemaining(run, closeWaitMs);
  if (left) {
    for (const page of await listTargets(run)) {
      if (page.type !== 'page') continue;
      try {
        await fetch(`http://127.0.0.1:${run.port}/json/close/${page.id}`, { method: 'PUT' });
      } catch {
        // DevTools http went away with the app; the poll below decides.
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
    { encoding: 'utf8' },
  );
  const version = (run.stdout ?? '').trim();
  return run.status === 0 && version ? version : 'unknown';
}

async function measure(options, exe, appPath) {
  const notes = [];
  let run = launchApp(exe);
  await waitEngineReady(run);
  let mode = 'resident';
  const remaining = await closeAllWindows(run);
  await delay(residentSettleMs);
  if (run.child.exitCode !== null) {
    notes.push('closing the windows quit the app; relaunched and measured with the window hidden');
    mode = 'window-hidden';
    run = launchApp(exe);
    await waitEngineReady(run);
  } else if (remaining) {
    notes.push(`${remaining} page target(s) stayed open; the run is not fully resident`);
    mode = 'window-open';
  }

  const pick = chooseEngineProcess(psTree(), run.child.pid);
  if (!pick)
    throw new Error('no --type=utility child of the app main pid (is the real engine running?)');
  let enginePid = pick.pid;
  const rendererIds = rendererPids(psTree(), run.child.pid);
  const pids = [...new Set([enginePid, run.child.pid, ...rendererIds])];

  const readings = [];
  const mainKb = [];
  const rendererKb = [];
  let restarts = 0;
  const endAt = Date.now() + options.minutes * 60_000;
  for (;;) {
    const at = Date.now();
    let rows = parsePsSample(ps(['-o', 'pid=,rss=,pcpu=,time=', '-p', pids.join(',')]));
    if (!rows.has(enginePid) && run.child.exitCode === null) {
      // The supervisor restarts a dead engine; follow it and let the CPU window restart.
      const next = chooseEngineProcess(psTree(), run.child.pid);
      if (next && next.pid !== enginePid) {
        notes.push(`engine restarted during the window: pid ${enginePid} -> ${next.pid}`);
        restarts++;
        enginePid = next.pid;
        pids.push(enginePid);
        rows = parsePsSample(ps(['-o', 'pid=,rss=,pcpu=,time=', '-p', pids.join(',')]));
      }
    }
    const engine = rows.get(enginePid);
    if (engine) readings.push({ at, pid: enginePid, rssKb: engine.rssKb, cputime: engine.cputime });
    const main = rows.get(run.child.pid);
    if (main) mainKb.push(main.rssKb);
    const rendererSum = rendererIds.reduce((sum, pid) => sum + (rows.get(pid)?.rssKb ?? 0), 0);
    if (rendererIds.length) rendererKb.push(rendererSum);
    if (!options.json)
      console.error(
        `sample ${readings.length} · engine ${engine ? shown(round(engine.rssKb / kbPerMb, 1), ' MB') : 'gone'} · pid ${enginePid}`,
      );
    if (run.child.exitCode !== null) {
      notes.push(`the app exited (code ${run.child.exitCode}) part-way through the window`);
      break;
    }
    const left = endAt - Date.now();
    if (left <= 0) break;
    await delay(Math.min(options.interval * 1000, left));
  }

  const top = spawnSync('top', ['-l', '2', '-pid', String(enginePid), '-stats', 'pid,cpu,idlew'], {
    encoding: 'utf8',
    timeout: 30_000,
  }).stdout;
  const wakeups = parseTopSample(top ?? '', enginePid);
  if (!wakeups) notes.push('top printed no second sample for the engine; wake-ups not measured');
  if (!readings.length) throw new Error('the engine never answered a ps sample');

  // The CPU window covers only the current engine pid: a restart resets cputime, so readings from a
  // previous pid would mix lifetimes.
  const lastPid = readings.at(-1).pid;
  const cpuReadings = readings.filter(r => r.pid === lastPid);
  const wallSeconds = (cpuReadings.at(-1).at - cpuReadings[0].at) / 1000;
  const cpu =
    cpuReadings.length >= 2
      ? cpuPercent(cpuReadings[0].cputime, cpuReadings.at(-1).cputime, wallSeconds)
      : null;
  const rssMb = readings.map(r => r.rssKb / kbPerMb);
  const report = {
    app: appPath,
    appVersion: appVersion(appPath),
    mode,
    samples: readings.length,
    windowSeconds: round(wallSeconds, 1),
    enginePid,
    enginePickedBy: pick.how,
    engineRestarts: restarts,
    idleEngineRssMb: round(median(rssMb), 1),
    idleEngineRssMaxMb: round(Math.max(...rssMb), 1),
    idleCpuPercent: cpu === null ? null : round(cpu, 2),
    idleWakeupsPerSec: wakeups?.idlew ?? null,
    mainRssMb: mainKb.length ? round(median(mainKb) / kbPerMb, 1) : null,
    rendererRssMb: rendererKb.length ? round(median(rendererKb) / kbPerMb, 1) : 0,
    notes,
  };
  return report;
}

function printReport(report) {
  console.log(`measure-idle: ${report.app}`);
  console.log(`app version: ${report.appVersion} · mode: ${report.mode}`);
  console.log(
    `samples: ${report.samples} over ${report.windowSeconds} s · engine pid ${report.enginePid} (${report.enginePickedBy})`,
  );
  console.log(
    `engine RSS    median ${shown(report.idleEngineRssMb, ' MB')}   max ${shown(report.idleEngineRssMaxMb, ' MB')}`,
  );
  console.log(`engine CPU    ${shown(report.idleCpuPercent, ' %')} of wall-clock (cputime delta)`);
  console.log(`wake-ups      ${shown(report.idleWakeupsPerSec, ' /s')} (top -l 2 second sample)`);
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
