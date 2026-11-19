#!/usr/bin/env node
// Line-coverage scorer (roadmap 5.1c). Runs c8 over the repo's own test runner,
// `node --import tsx --test <files>` (`--runner electron-node` swaps node for
// scripts/audit/electron-node.mjs: the engine DB suites must run under Electron's Node, see
// test:engine in the root package.json). score = covered-lines percent over the files matching
// --scope (repeatable, repo-relative), or over every file c8 reports when no scope is given;
// tests, node_modules and build output are always excluded. details = the least-covered files.
// Typical runtime: the test run plus ~1 s for c8 to write coverage-summary.json.
//   node scripts/audit/hillclimb/scorers/coverage.mjs --tests <glob> [--scope <glob>]...
//     [--runner node|electron-node] [--timeout-sec <n, default 300>]
//
// Two tamper guards: the denominator is expandGlobs(--scope) minus the shared exclude set, so
// a file cannot leave the score by taking a test-like name — a scoped file absent from the c8
// report counts as 0% covered over its own line count and is named in details. And a scoped
// file carrying a v8/c8/istanbul/node:coverage ignore directive fails the run outright: a
// scorer cannot stop such a comment, but it refuses to score tampered input.
import { readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  SCORE_EXCLUDES,
  ScorerError,
  emitScore,
  expandGlobs,
  makeRunDir,
  parseArgs,
  readJsonFile,
  refuseTampering,
  repoRoot,
  runCli,
  runLogged,
  scopeFiles,
  toRepoPath,
} from './util.mjs';

const c8Bin = join(repoRoot, 'node_modules', 'c8', 'bin', 'c8.js');
const electronNode = join(repoRoot, 'scripts', 'audit', 'electron-node.mjs');

/** The runner argv for a resolved test-file list; 'node' is `node --import tsx --test`. */
export function testCommand(runner, files) {
  if (runner === 'electron-node') {
    return [process.execPath, electronNode, '--import', 'tsx', '--test', ...files];
  }
  return [process.execPath, '--import', 'tsx', '--test', ...files];
}

export function parseArgsCoverage(argv) {
  const options = parseArgs(argv, {
    values: { '--tests': 'tests', '--scope': 'scope' },
    numbers: { '--timeout-sec': { key: 'timeoutSec', default: 300 } },
    strings: {
      '--runner': { key: 'runner', default: 'node', oneOf: ['node', 'electron-node'] },
      '--cwd': { key: 'cwd', default: repoRoot },
    },
  });
  if (options.tests.length === 0) throw new ScorerError('coverage needs --tests <glob>');
  return options;
}

/** Per-file rows of a c8 json-summary: { file, covered, total, pct }, repo-relative and sorted. */
export function summaryFiles(summary, root) {
  return Object.entries(summary)
    .filter(([file]) => file !== 'total')
    .map(([file, data]) => ({
      file: toRepoPath(file, root),
      covered: data.lines.covered,
      total: data.lines.total,
      pct: data.lines.pct,
    }))
    .sort((a, b) => a.file.localeCompare(b.file));
}

/** The score and details for the scoped rows: weighted line percent, worst files first. */
export function scoreFiles(files) {
  const coverable = files.filter(file => file.total > 0);
  const covered = coverable.reduce((sum, file) => sum + file.covered, 0);
  const total = coverable.reduce((sum, file) => sum + file.total, 0);
  const worst = [...coverable].sort(
    (a, b) =>
      a.pct - b.pct || b.total - b.covered - (a.total - a.covered) || a.file.localeCompare(b.file),
  );
  return {
    score: total === 0 ? 0 : Math.round((covered / total) * 10_000) / 100,
    details: worst.map(
      file =>
        `${file.file} ${file.pct.toFixed(1)}% (${file.covered}/${file.total})` +
        (file.absent ? ', absent from c8 report' : ''),
    ),
  };
}

/** Physical line count of `file` (absolute path); 0 when unreadable or empty. */
function lineCount(file) {
  try {
    const text = readFileSync(file, 'utf8');
    if (text.length === 0) return 0;
    const lines = text.split('\n').length;
    return text.endsWith('\n') ? lines - 1 : lines;
  } catch {
    return 0;
  }
}

/**
 * The denominator expressed as report rows. `denominator` (scoped files minus the exclude
 * set) is authoritative: a file in it that c8 never reported counts as 0% covered over its
 * own physical line count — slightly more lines than c8's coverable-line total, which is the
 * safe direction — and is flagged `absent` for the details list. A null denominator means no
 * scope was given: the reported files are the rows, as before.
 */
export function rowsForScope(reportRows, denominator, cwd) {
  if (!denominator) return reportRows;
  const byFile = new Map(reportRows.map(row => [row.file, row]));
  return denominator.map(file => {
    const row = byFile.get(file);
    if (row) return row;
    return { file, covered: 0, total: lineCount(join(cwd, file)), pct: 0, absent: true };
  });
}

/** c8 argv: the summary report is the only artifact read back; everything else goes to the log. */
export function c8Args({ scopes, runner, files, reportDir }) {
  const include = scopes.length ? scopes : ['**/*'];
  const args = [
    process.execPath,
    c8Bin,
    '--reporter=json-summary',
    `--report-dir=${reportDir}`,
    '--all',
    '--exclude-after-remap',
    '--src=.',
  ];
  for (const glob of include) args.push('--include', glob);
  for (const glob of SCORE_EXCLUDES) args.push('--exclude', glob);
  return args.concat(testCommand(runner, files));
}

async function main(argv) {
  const options = parseArgsCoverage(argv);
  // c8 keys its report by real path (macOS /var -> /private/var), so compare real to real.
  const cwd = realpathSync(options.cwd);
  // The denominator is what the scope names minus the fixed exclude set; it must exist and be
  // clean before any tool runs, so an empty scope or a tampered file fails fast.
  const denominator = options.scope.length ? scopeFiles(options.scope, cwd) : null;
  if (denominator && denominator.length === 0)
    throw new ScorerError(`--scope matched no scorable files: ${options.scope.join(', ')}`);
  refuseTampering(denominator ?? [], 'coverage', cwd);
  const files = expandGlobs(options.tests, cwd);
  if (files.length === 0) {
    throw new ScorerError(`--tests matched no files: ${options.tests.join(', ')}`);
  }
  const runDir = makeRunDir('coverage');
  try {
    const run = runLogged(
      'coverage',
      c8Args({ scopes: options.scope, runner: options.runner, files, reportDir: runDir }),
      { cwd, timeoutMs: options.timeoutSec * 1000 },
    );
    if (run.error?.code === 'ETIMEDOUT') {
      throw new ScorerError(`c8 timed out after ${options.timeoutSec} s`);
    }
    if (run.error) throw new ScorerError(`c8 failed to start: ${run.error.message}`);
    // A non-zero status usually means a test failed; the summary still scores, and the
    // harness's own test gate is what rejects the attempt. The summary only exists when c8
    // wrote it this run: the per-run dir makes a stale report impossible.
    const summary = readJsonFile(join(runDir, 'coverage-summary.json'), 'c8 summary report');
    const rows = rowsForScope(summaryFiles(summary, cwd), denominator, cwd);
    if (rows.length === 0) {
      throw new ScorerError('the coverage report held no files');
    }
    const { score, details } = scoreFiles(rows);
    emitScore(score, details);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
}

runCli(import.meta.url, main);
