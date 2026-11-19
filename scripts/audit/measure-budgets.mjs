#!/usr/bin/env node
// Budget measurement (plan 40 Q3 deliverable 6). Usage:
//   node scripts/audit/measure-budgets.mjs [--record] [--tighten] [--only <id,...>] [--time-unit-suite] [--ci [--ci-run-limit <n>]]
// Measures the rows owned by plat-ci (bundle and package sizes, unit-suite time, CI wall-clock and billed
// minutes) and compares each with its budgets.json limit. An artifact that is absent is reported as
// "not measurable here" and never fails. --ci reads the ci.* rows from the revamp runs of the CI workflow
// created in the last 30 days with `gh` (30 s limit per call): wall-clock rows use the newest successful
// run in which the named jobs ran (static-unit: the median over the newest 5 such runs);
// ci.billed-minutes sums every job that ran in every run in the window,
// whatever its outcome (the row is per month) and is skipped, never partial, when the run list hit the
// cap or any gh step failed. Without --ci each ci.* row is skipped; with --ci, if no run could be read at
// all, the failing gh steps are printed and the exit code is 2.
// Exit 1 when a measured row is over its limit. --record writes lastMeasured (today, UTC) for the rows it
// measured, and a value only for a calibrate row with no value yet or, with --tighten, a tighten-only row
// measured below its limit. Rows owned by anyone else are never touched.
import { spawnSync } from 'node:child_process';
import { builtinModules } from 'node:module';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const owner = 'plat-ci';
export const defaultMaxAgeDays = 30;
// MB here is MiB, what `du -sm` prints and what the plan's 369 MB baseline was read from.
const bytesPerMb = 1024 * 1024;
const bundleExtensions = ['.js', '.mjs', '.css'];

// Directory sizing

/** Every file under `dir` at any depth, as absolute paths. Symlinks are not followed or counted. */
export function listFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(path);
    return entry.isFile() ? [path] : [];
  });
}

const hasExtension = (path, extensions) => extensions.some(ext => path.endsWith(ext));

/** Total bytes of the files under `dir`, optionally only those with one of `extensions`. */
export function directoryBytes(dir, extensions) {
  const files = listFiles(dir).filter(file => !extensions || hasExtension(file, extensions));
  return files.reduce((sum, file) => sum + statSync(file).size, 0);
}

/** Directories and files under `dir` (to `depth` levels) whose name ends with `suffix`. */
export function findEntries(dir, suffix, depth = 3) {
  if (depth < 0 || !existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.name.endsWith(suffix)) return [path];
    return entry.isDirectory() ? findEntries(path, suffix, depth - 1) : [];
  });
}

const toMb = bytes => bytes / bytesPerMb;
const roundUp = (number, places) => Math.ceil(number * 10 ** places) / 10 ** places;

// Comparing and ratcheting

/** The most a measurement may be: the row value plus its alertPct allowance. Null when there is no value. */
export function limitOf(row) {
  if (row.value == null) return null;
  return row.alertPct ? row.value * (1 + row.alertPct / 100) : row.value;
}

/** 'ok' or 'FAIL' for a measurement against the row's limit; a row with no limit yet is 'ok'. */
export function compare(row, measured) {
  const limit = limitOf(row);
  return limit != null && measured > limit ? 'FAIL' : 'ok';
}

/** The value to write back: the first measurement of a calibrate row, or a lower one with --tighten. */
export function nextValue(row, measured, { tighten = false } = {}) {
  if (row.value == null) return row.calibration === 'calibrate' ? measured : row.value;
  const lower = measured < row.value;
  return tighten && row.gate === 'tighten-only' && lower ? measured : row.value;
}

/** Returns a copy of the register with plat-ci rows updated from `results` ({ id: { measured, unit } }). */
export function applyRecords(register, results, today, options = {}) {
  const rows = register.rows.map(row => {
    const result = results[row.id];
    if (row.owner !== owner || !result) return row;
    return recordRow(row, result, today, options);
  });
  return { ...register, rows };
}

function recordRow(row, result, today, options) {
  const value = nextValue(row, result.measured, options);
  const next = { ...row, value, lastMeasured: today };
  if (value != null && next.unit == null) next.unit = result.unit;
  if (value != null && next.maxAgeDays == null) next.maxAgeDays = defaultMaxAgeDays;
  return next;
}

/** budgets.json text: 2-space JSON and a final newline, exactly as the file is kept. */
export function serialise(register) {
  return `${JSON.stringify(register, null, 2)}\n`;
}

// Measurers: each returns { measured, unit } or { skip: reason }

const missing = reason => ({ skip: reason });

function measureRenderer(root) {
  const dir = join(root, 'apps', 'desktop', 'dist', 'renderer');
  if (!existsSync(dir))
    return missing(`${relative(root, dir)} is absent (run npm run build -w @aplos/desktop)`);
  return { measured: directoryBytes(dir, bundleExtensions), unit: 'bytes' };
}

function packageDirs(root) {
  return ['release', 'dist'].map(name => join(root, 'apps', 'desktop', name));
}

function measureApp(root) {
  const apps = packageDirs(root).flatMap(dir => findEntries(dir, '.app'));
  if (apps.length === 0) return missing('no packaged .app under apps/desktop/release or dist');
  const biggest = Math.max(...apps.map(app => directoryBytes(app)));
  return { measured: roundUp(toMb(biggest), 1), unit: 'MB' };
}

function measureZip(root) {
  const zips = packageDirs(root).flatMap(dir => findEntries(dir, '.zip', 1));
  if (zips.length === 0) return missing('no packaged .zip under apps/desktop/release or dist');
  const biggest = Math.max(...zips.map(zip => statSync(zip).size));
  return { measured: roundUp(toMb(biggest), 1), unit: 'MB' };
}

const nodeModules = [
  ...new Set(builtinModules.map(name => name.replace(/^node:/, '').split('/')[0])),
];

/** Bundles the engine source (legacy/ excluded) the way packages/engine/tests/portability.test.ts does. */
export async function bundleEngine(srcDir, esbuild) {
  const legacy = join(srcDir, 'legacy');
  const files = listFiles(srcDir).filter(file => /\.tsx?$/.test(file) && !file.endsWith('.d.ts'));
  const entries = files.filter(file => !file.startsWith(legacy));
  const contents = entries
    .map((file, i) => `export * as m${i} from './${relative(srcDir, file).split('\\').join('/')}';`)
    .join('\n');
  const result = await esbuild.build({
    stdin: { contents, resolveDir: srcDir, loader: 'ts' },
    bundle: true,
    platform: 'neutral',
    format: 'esm',
    mainFields: ['module', 'main'],
    target: 'es2022',
    // The budget is for the bundle that ships, so it is measured minified like portability.test.ts does.
    minify: true,
    write: false,
    logLevel: 'silent',
    external: ['node:*', 'electron', ...nodeModules, ...nodeModules.map(name => `${name}/*`)],
  });
  return new TextEncoder().encode(result.outputFiles[0].text).length;
}

async function measureEngine(root) {
  const srcDir = join(root, 'packages', 'engine', 'src');
  if (!existsSync(srcDir)) return missing('packages/engine/src is absent');
  const esbuild = await import('esbuild').catch(() => null);
  if (!esbuild) return missing('esbuild is not installed (run npm install)');
  return { measured: await bundleEngine(srcDir, esbuild), unit: 'bytes' };
}

function measureSuite(root, options) {
  if (!options.timeUnitSuite) return missing('pass --time-unit-suite to run npm test and time it');
  const started = Date.now();
  const run = spawnSync('npm', ['test'], { cwd: root, stdio: 'ignore' });
  if (run.status !== 0)
    return missing(`npm test exited ${run.status ?? run.signal}, so its time means nothing`);
  return { measured: roundUp((Date.now() - started) / 1000, 1), unit: 's' };
}

// CI rows: --ci reads job timings of the latest successful revamp CI runs with `gh`. A skipped
// job has no wall-clock (its timestamps are meaningless), so only jobs that ran are measured.
export const ciJobNames = {
  staticJob: 'Static (format, lint, types, audit)',
  unitJob: 'Unit tests',
  e2eBrowserJob: 'Browser E2E (headless, loopback only)',
  macosJob: 'Desktop on macOS (typecheck, test, build)',
};

// A billed macOS runner minute costs ten Linux minutes on the free allowance.
const macosMinuteMultiplier = 10;
const macosJobs = new Set([ciJobNames.macosJob]);

/** A job's wall-clock in minutes from startedAt to completedAt; null when the job did not run. */
export function jobMinutes(job) {
  if (job?.conclusion !== 'success') return null;
  const started = Date.parse(job.startedAt ?? '');
  const completed = Date.parse(job.completedAt ?? '');
  if (Number.isNaN(started) || Number.isNaN(completed)) return null;
  return (completed - started) / 60_000;
}

/** The longest wall-clock of the jobs `match` accepts, in minutes; null when none ran. */
export function maxJobMinutesWhere(jobs, match) {
  const minutes = jobs
    .filter(job => match(job.name))
    .map(jobMinutes)
    .filter(value => value != null);
  return minutes.length ? Math.max(...minutes) : null;
}

/** The longest wall-clock of the jobs named `names`, in minutes; null when none of them ran. */
export function maxJobMinutes(jobs, names) {
  return maxJobMinutesWhere(jobs, name => names.includes(name));
}

// A job that failed, timed out or was cancelled mid-run still bills; a skipped job (bogus timestamps) or
// one still running (no completedAt) does not.
const billedConclusions = new Set(['success', 'failure', 'cancelled', 'timed_out']);

/** Wall-clock minutes of a job that really ran, whatever its outcome; null otherwise. */
export function ranMinutes(job) {
  if (!billedConclusions.has(job?.conclusion)) return null;
  const started = Date.parse(job.startedAt ?? '');
  const completed = Date.parse(job.completedAt ?? '');
  if (Number.isNaN(started) || Number.isNaN(completed) || completed < started) return null;
  return (completed - started) / 60_000;
}

/** One run's billed minutes: every job that ran (any outcome) rounded up to whole minutes, macOS at 10x. */
export function billedMinutes(jobs) {
  return jobs.reduce((sum, job) => {
    const minutes = ranMinutes(job);
    if (minutes == null) return sum;
    return sum + Math.ceil(minutes) * (macosJobs.has(job.name) ? macosMinuteMultiplier : 1);
  }, 0);
}

export const ciUnreadableReason = 'no CI runs could be read (see the gh messages above)';
const ghTimeoutMs = 30_000;
const ciWindowDays = 30;
const ciRunLimit = 300;

/**
 * Runs `gh` and parses its JSON. Returns { value } or { problem } where the problem names the step
 * and why it failed (gh missing, timed out, non-zero exit with its first stderr line, or non-JSON).
 */
function ghJson(step, args, cwd) {
  const run = spawnSync('gh', args, { cwd, encoding: 'utf8', timeout: ghTimeoutMs });
  if (run.error?.code === 'ETIMEDOUT') return { problem: `${step}: gh timed out after 30 s` };
  if (run.error)
    return { problem: `${step}: gh unavailable (${run.error.code ?? run.error.message})` };
  if (run.status !== 0) {
    const reason =
      String(run.stderr ?? '')
        .trim()
        .split('\n')[0] || `exit ${run.status}`;
    return { problem: `${step}: ${reason}` };
  }
  try {
    return { value: JSON.parse(run.stdout) };
  } catch {
    return { problem: `${step}: gh printed no JSON` };
  }
}

/** The `--created` filter for runs from the last `days` days: `>=YYYY-MM-DD`. */
export function createdSince(now, days) {
  return `>=${new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)}`;
}

/**
 * Every revamp CI run created in the last 30 days (any outcome: failed and cancelled runs bill too,
 * newest first, at most `limit`, default ciRunLimit), as { runs: [{ conclusion, jobs }], problems, complete }.
 * `complete` is false when the list hit the cap or any gh step failed, so a caller must not treat the
 * runs as the whole month. Each failing step is named in `problems`.
 */
export function fetchCiRuns(root, now = new Date(), limit = ciRunLimit) {
  const list = ghJson(
    'gh run list',
    ['run', 'list', '--branch', 'revamp', '--workflow', 'CI']
      .concat(['--created', createdSince(now, ciWindowDays), '--limit', String(limit)])
      .concat(['--json', 'databaseId,conclusion,status']),
    root,
  );
  if (list.problem) return { runs: [], problems: [list.problem], complete: false };
  if (!Array.isArray(list.value)) {
    return { runs: [], problems: ['gh run list: unexpected output'], complete: false };
  }
  if (list.value.length === 0) {
    return { runs: [], problems: ['gh run list: no CI runs in the last 30 days'], complete: false };
  }
  const problems = [];
  if (list.value.length >= limit) {
    problems.push(
      `gh run list: hit the ${limit}-run limit; older runs in the window are not counted`,
    );
  }
  const runs = [];
  for (const entry of list.value) {
    const step = `gh run view ${entry.databaseId}`;
    if (entry.status !== 'completed') {
      problems.push(`${step}: run still ${entry.status ?? 'unfinished'}, its jobs are not final`);
      continue;
    }
    const view = ghJson(step, ['run', 'view', String(entry.databaseId), '--json', 'jobs'], root);
    if (view.problem) problems.push(view.problem);
    else if (Array.isArray(view.value?.jobs))
      runs.push({ conclusion: entry.conclusion, jobs: view.value.jobs });
    else problems.push(`${step}: no jobs array`);
  }
  return { runs, problems, complete: problems.length === 0 };
}

/** The reason a ci.* row cannot be measured here, or null when it can. */
function ciUnavailable(options) {
  if (!options.ci) return 'pass --ci to read GitHub Actions runs';
  if (!options.ciRuns?.length) return ciUnreadableReason;
  return null;
}

/** The longest wall-clock of the jobs `match` accepts in the newest successful run where any ran; null when none did. */
export function newestMinutes(runs, match) {
  for (const run of runs) {
    if (run.conclusion !== 'success') continue;
    const minutes = maxJobMinutesWhere(run.jobs, match);
    if (minutes != null) return minutes;
  }
  return null;
}

// One runner hiccup can add a minute to a single run, so this row is judged on the median of the last
// few green runs, not the newest one. The limit itself is unchanged.
const medianRunCount = 5;

/** True when the jobs `match` accepts exist and every one of them was skipped. */
const allSkipped = (jobs, match) => {
  const matching = jobs.filter(job => match(job.name));
  return matching.length > 0 && matching.every(job => job.conclusion === 'skipped');
};

/**
 * The median of each run's longest matching job over the newest `count` successful runs where `match`
 * ran; null when none did. A run whose `unless` jobs were all skipped is left out (a web-only run
 * skips the unit jobs, so its short Static job alone would hide a slow desktop run).
 */
export function medianMinutes(runs, match, count = medianRunCount, unless = () => false) {
  const minutes = runs
    .filter(run => run.conclusion === 'success' && !allSkipped(run.jobs, unless))
    .map(run => maxJobMinutesWhere(run.jobs, match))
    .filter(value => value != null)
    .slice(0, count)
    .sort((a, b) => a - b);
  if (minutes.length === 0) return null;
  const middle = Math.floor(minutes.length / 2);
  if (minutes.length % 2 === 1) return minutes[middle];
  return (minutes[middle - 1] + minutes[middle]) / 2;
}

function measureCiWallClock(options, match, absence, pick = newestMinutes) {
  const unavailable = ciUnavailable(options);
  if (unavailable) return missing(unavailable);
  const minutes = pick(options.ciRuns, match);
  if (minutes == null) return missing(absence);
  return { measured: roundUp(minutes, 1), unit: 'min' };
}

const named = names => name => names.includes(name);

// The static-unit wall-clock is the longest of the static job and every "Unit tests (...)" job, so it
// stays right whether the unit suite is one job or split across several.
const isStaticUnitJob = name =>
  typeof name === 'string' && (name.startsWith('Static (') || name.startsWith(ciJobNames.unitJob));

const isUnitJob = name => typeof name === 'string' && name.startsWith(ciJobNames.unitJob);

// A web-only run skips the unit jobs and does not count.
const staticUnitMedian = (runs, match) => medianMinutes(runs, match, medianRunCount, isUnitJob);

const measureCiStaticUnit = (root, options) =>
  measureCiWallClock(
    options,
    isStaticUnitJob,
    'no completed static or unit job in the last 30 days',
    staticUnitMedian,
  );

const measureCiE2eBrowser = (root, options) =>
  measureCiWallClock(
    options,
    named([ciJobNames.e2eBrowserJob]),
    'no completed browser E2E job in the last 30 days',
  );

const measureCiMacos = (root, options) =>
  measureCiWallClock(
    options,
    named([ciJobNames.macosJob]),
    'no completed macOS run in the last 30 days',
  );

/**
 * Billed minutes of every revamp CI run created in the last 30 days, whatever its outcome (the row is
 * per month). A partial sum would be written as a tighten-only limit by --record, so when the list hit
 * the run cap or any gh step failed the row is skipped, naming the first problem.
 */
function measureCiBilled(root, options) {
  const unavailable = ciUnavailable(options);
  if (unavailable) return missing(unavailable);
  if (options.ciComplete === false) {
    const why = options.ciProblems?.[0] ?? 'some runs were not read';
    return missing(`incomplete month, not a sum worth recording: ${why}`);
  }
  const total = options.ciRuns.reduce((sum, run) => sum + billedMinutes(run.jobs), 0);
  return { measured: total, unit: 'minutes' };
}

export const measurers = {
  'size.engine-bundle': measureEngine,
  'size.renderer-bundle': measureRenderer,
  'size.app-bundle': measureApp,
  'size.app-zip': measureZip,
  'time.unit-suite': measureSuite,
  'ci.wall-clock-static-unit': measureCiStaticUnit,
  'ci.wall-clock-e2e-browser': measureCiE2eBrowser,
  'ci.wall-clock-macos': measureCiMacos,
  'ci.billed-minutes': measureCiBilled,
};

// Running

const isCiRow = row => row.id.startsWith('ci.');

/** Measures the chosen plat-ci rows. Returns [{ row, result }] where result is a measurement or a skip. */
export async function measureRows(register, root, options = {}) {
  const only = options.only ?? null;
  const rows = register.rows.filter(row => row.owner === owner && row.id in measurers);
  const chosen = rows.filter(row => !only || only.includes(row.id));
  const context = { ...options };
  if (options.ci && context.ciRuns === undefined && chosen.some(isCiRow)) {
    const fetched = fetchCiRuns(root, new Date(), options.ciRunLimit);
    context.ciRuns = fetched.runs;
    context.ciComplete = fetched.complete;
    context.ciProblems = fetched.problems;
    for (const problem of fetched.problems) console.error(`ci: ${problem}`);
  }
  const outcomes = [];
  for (const row of chosen) outcomes.push({ row, result: await measurers[row.id](root, context) });
  return outcomes;
}

const withUnit = (value, unit) => `${value}${unit ? ` ${unit}` : ''}`;

/** One report line: id, measured, limit, ok/FAIL/skipped. */
export function formatLine({ row, result }) {
  if (result.skip) return `${row.id}  skipped  not measurable here: ${result.skip}`;
  const limit = limitOf(row);
  const shown = limit == null ? 'none yet' : withUnit(limit, row.unit);
  return `${row.id}  ${withUnit(result.measured, result.unit)}  limit ${shown}  ${compare(row, result.measured)}`;
}

/** The { id: { measured, unit } } map of the rows that really were measured. */
export function measuredResults(outcomes) {
  const entries = outcomes
    .filter(({ result }) => !result.skip)
    .map(({ row, result }) => [row.id, result]);
  return Object.fromEntries(entries);
}

const flags = {
  '--record': 'record',
  '--tighten': 'tighten',
  '--time-unit-suite': 'timeUnitSuite',
  '--ci': 'ci',
};

// A smaller run cap for tests, so the cap path does not spawn hundreds of processes.
const numberFlags = { '--ci-run-limit': 'ciRunLimit' };

function parseLimit(flag, value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error(`${flag} needs a positive integer`);
  return number;
}

export function parseArgs(argv) {
  const options = { record: false, tighten: false, timeUnitSuite: false, ci: false, only: null };
  const args = [...argv];
  while (args.length > 0) {
    const arg = args.shift();
    if (arg in flags) options[flags[arg]] = true;
    else if (arg in numberFlags) options[numberFlags[arg]] = parseLimit(arg, args.shift());
    else if (arg === '--only') options.only = (args.shift() ?? '').split(',').filter(Boolean);
    else throw new Error(`unknown argument ${arg}`);
  }
  return options;
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const file = join(root, 'budgets.json');
  const options = parseArgs(process.argv.slice(2));
  const register = JSON.parse(readFileSync(file, 'utf8'));
  const outcomes = await measureRows(register, root, options);
  for (const outcome of outcomes) console.log(formatLine(outcome));
  const failing = outcomes.filter(
    ({ row, result }) => !result.skip && compare(row, result.measured) === 'FAIL',
  );
  if (options.record) {
    const today = new Date().toISOString().slice(0, 10);
    const results = measuredResults(outcomes);
    writeFileSync(file, serialise(applyRecords(register, results, today, options)));
    console.log(`recorded ${Object.keys(results).length} row(s) in budgets.json`);
  }
  const unreadable =
    options.ci && outcomes.some(({ result }) => result.skip === ciUnreadableReason);
  if (unreadable) console.error('--ci was asked for but no CI runs could be read');
  process.exit(unreadable ? 2 : failing.length ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exit(2);
  });
}
