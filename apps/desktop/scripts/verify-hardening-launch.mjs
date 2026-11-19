// The launch rows of scripts/verify-hardening.mjs (run only with --launch-checks): a plain control
// launch, then hostile launches with debug ports, ELECTRON_RUN_AS_NODE and NODE_OPTIONS. Split out so
// each file stays under the lint line limit; verify-hardening.mjs re-exports everything here.
import { spawn as nodeSpawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

const row = (id, status, reason) => ({ id, status, reason });
const pass = (id, reason) => row(id, 'PASS', reason);
const fail = (id, reason) => row(id, 'FAIL', reason);
const firstLine = text =>
  String(text ?? '')
    .split('\n')
    .map(s => s.trim())
    .find(Boolean)
    ?.slice(0, 200) ?? '';

// Built at runtime so the marker never appears in the command line itself.
export const RUN_AS_NODE_MARKER = 'aplos-ran-as-node';
const RUN_AS_NODE_CODE = 'process.stdout.write(["aplos","ran","as","node"].join("-"))';
/**
 * The exit code the ADR 40-6 startup guard (src/main/security.ts, Q2 item 6) must use when it refuses a
 * debugging switch. A crash, a kill or a hand-off to a running copy also "exits", so only this code counts
 * as proof. Change it here and in the guard together.
 */
export const DEBUG_GUARD_EXIT_CODE = 78; // EX_CONFIG in sysexits.h
/**
 * `control` is a plain launch that must stay up until the timeout; without it, an app that crashes or exits
 * on every launch would pass every hostile row. `guardExit` cases must exit with DEBUG_GUARD_EXIT_CODE;
 * `stay` cases must behave like the control (keep running, run no Node code, expose no debugger).
 */
export const LAUNCH_CASES = [
  { id: 'launch-control', what: 'a plain launch', args: [], control: true },
  {
    id: 'launch-remote-debugging',
    what: '--remote-debugging-port=0',
    args: ['--remote-debugging-port=0'],
    guardExit: true,
  },
  { id: 'launch-inspect', what: '--inspect=0', args: ['--inspect=0'], guardExit: true },
  {
    id: 'launch-run-as-node',
    what: 'ELECTRON_RUN_AS_NODE=1 -e',
    args: ['-e', RUN_AS_NODE_CODE],
    env: { ELECTRON_RUN_AS_NODE: '1' },
    runAsNode: true,
    stay: true,
  },
  // Packaged Electron strips NODE_OPTIONS even with the fuse on, so this row cannot prove the fuse is off.
  {
    id: 'launch-node-options',
    what: 'NODE_OPTIONS=--inspect=0',
    args: [],
    env: { NODE_OPTIONS: '--inspect=0' },
    stay: true,
    note: 'behavioural smoke test only (packaged Electron ignores NODE_OPTIONS either way; the fuses row is the evidence)',
  },
  // Chromium on macOS also parses a switch with one leading dash, so a guard that only looks for "--" misses it.
  {
    id: 'launch-remote-debugging-dash',
    what: '-remote-debugging-port=0',
    args: ['-remote-debugging-port=0'],
    guardExit: true,
  },
];
/**
 * The `--launch-checks=guard` subset: only the launches that the debug guard must refuse. If the guard works,
 * each exits before the app is ready, so no window opens and no engine starts; release-build.mjs and the
 * Release workflow run these on the real release artifact (which has no test mode). They need no control
 * launch, because only the guard's own exit code passes.
 */
export const GUARD_CASES = LAUNCH_CASES.filter(testCase => testCase.guardExit);
const DEBUGGER_LINE = /DevTools listening on|Debugger listening on/;

/**
 * Pure verdict for one launch. `result` is what launchOnce returns plus `devtoolsFile`.
 * `controlPassed` says whether the plain launch stayed up; hostile rows are inconclusive without it.
 */
export function judgeLaunch(testCase, result, timeoutMs, controlPassed = true) {
  const { id, what } = testCase;
  const exitText = `exited (${result.signal ? `signal ${result.signal}` : `code ${result.code}`})`;
  const how = result.timedOut ? `still running after ${timeoutMs / 1000}s, then killed` : exitText;
  if (result.error) return fail(id, `could not start the app: ${firstLine(result.error.message)}`);
  if (DEBUGGER_LINE.test(result.output) || result.devtoolsFile)
    return fail(id, `${what} exposed a debugger`);
  // Node's own option parser rejects the leading --user-data-dir, so "bad option" also proves Node ran.
  if (
    testCase.runAsNode &&
    (result.output.includes(RUN_AS_NODE_MARKER) || /bad option:/.test(result.output))
  )
    return fail(id, 'ELECTRON_RUN_AS_NODE was honoured: the app ran as Node');
  if (testCase.control) {
    if (!result.timedOut)
      return fail(
        id,
        `a plain launch ${exitText} within ${timeoutMs / 1000}s (crashed, refused to start or handed off to a running copy), so the hostile launches prove nothing`,
      );
    return pass(id, `a plain launch stays up (${how})`);
  }
  if (!controlPassed)
    return fail(id, `${what}: inconclusive, the plain control launch did not stay up`);
  if (testCase.guardExit) {
    if (result.timedOut)
      return fail(id, `${what}: no debugger seen, but the app was ${how}; a release must exit`);
    if (result.signal || result.code !== DEBUG_GUARD_EXIT_CODE)
      return fail(
        id,
        `${what}: ${exitText}, not with the debug guard's code ${DEBUG_GUARD_EXIT_CODE} (a crash or hand-off is not proof)`,
      );
    return pass(
      id,
      `${what}: refused by the debug guard (exit code ${DEBUG_GUARD_EXIT_CODE}), no debugger`,
    );
  }
  if (!result.timedOut)
    return fail(id, `${what}: ${exitText} early, while a plain launch stays up`);
  return pass(
    id,
    `${what}: no debugger, no Node code ran, behaved like the plain launch (${how})${testCase.note ? `; ${testCase.note}` : ''}`,
  );
}

/** Starts the app once and collects its output; kills it after `timeoutMs`. `spawn` is injectable for tests. */
export function launchOnce({ spawn, executable, args, env, timeoutMs }) {
  return new Promise(done => {
    let output = '',
      timedOut = false,
      settled = false,
      child,
      grace;
    const finish = extra => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      done({ output, timedOut, ...extra });
    };
    // Created before spawn so `finish` can always clear it; a spawn failure settles first anyway.
    const timer = setTimeout(() => {
      timedOut = true;
      if (!child) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      } // the whole process group
      grace = setTimeout(() => finish({ code: null, signal: 'SIGKILL' }), 2000);
    }, timeoutMs);
    try {
      child = spawn(executable, args, { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    } catch (error) {
      return finish({ error });
    }
    const collect = chunk => {
      if (output.length < 1_000_000) output += String(chunk);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.on('error', error => finish({ error }));
    child.on('close', (code, signal) => finish({ code, signal }));
    // Chromium helpers can hold the pipes open, so do not wait for 'close' forever after 'exit'.
    child.on('exit', (code, signal) => {
      if (timedOut) return;
      clearTimeout(timer);
      grace = setTimeout(() => finish({ code, signal }), 500);
    });
  });
}

/** True when a process with this name is running (pgrep -x). A second launch would hand off to it. */
export const processRunning = name => spawnSync('pgrep', ['-x', '--', name]).status === 0;

export async function runLaunchChecks({
  executable,
  spawn = nodeSpawn,
  timeoutMs,
  baseEnv = process.env,
  makeTempDir = () => mkdtempSync(join(tmpdir(), 'aplos-hardening-')),
  removeDir = dir => rmSync(dir, { recursive: true, force: true }),
  exists = existsSync,
  isRunning = processRunning,
  only,
}) {
  const cases = only === 'guard' ? GUARD_CASES : LAUNCH_CASES;
  // A working guard exits in about a second, but the first launch of a freshly built binary can be slow
  // (macOS checks it), and a guard-mode timeout fails a release run, so give it room.
  const limit = timeoutMs ?? (only === 'guard' ? 20000 : 8000);
  // A running copy would take the single-instance hand-off (and raise its window), so every launch would "exit".
  // The guard subset is exempt: its launches exit before the hand-off, each has its own --user-data-dir (which
  // is what the single-instance lock is keyed on), and a release build must be checkable on a Mac that runs Aplos.
  if (only !== 'guard' && isRunning(basename(executable)))
    return cases.map(testCase =>
      fail(
        testCase.id,
        `not run: ${basename(executable)} is already running; quit it first so no launch hands off to it`,
      ),
    );
  const rows = [];
  let controlPassed = true;
  for (const testCase of cases) {
    if (!controlPassed) {
      rows.push(
        fail(testCase.id, `${testCase.what}: not run, the plain control launch did not stay up`),
      );
      continue;
    }
    const dir = makeTempDir();
    try {
      const env = { ...baseEnv, APLOS_DATA_DIR: dir };
      delete env.ELECTRON_RUN_AS_NODE;
      delete env.NODE_OPTIONS;
      Object.assign(env, testCase.env);
      const profile = join(dir, 'chromium');
      const result = await launchOnce({
        spawn,
        executable,
        args: [`--user-data-dir=${profile}`, ...testCase.args],
        env,
        timeoutMs: limit,
      });
      const devtoolsFile = exists(join(profile, 'DevToolsActivePort'));
      const verdict = judgeLaunch(testCase, { ...result, devtoolsFile }, limit, controlPassed);
      if (testCase.control) controlPassed = verdict.status === 'PASS';
      rows.push(verdict);
    } finally {
      removeDir(dir);
    }
  }
  return rows;
}
