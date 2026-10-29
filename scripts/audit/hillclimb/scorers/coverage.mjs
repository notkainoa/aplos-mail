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
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import {
  ScorerError,
  artifactsDir,
  emitScore,
  expandGlobs,
  inScope,
  parseArgs,
  readJsonFile,
  repoRoot,
  runCli,
  runLogged,
  toRepoPath,
} from './util.mjs';

// The report never covers test code, build output or vendored trees; they are not the unit the
// harness is trying to improve.
export const coverageExcludes = [
  'coverage/**',
  '**/node_modules/**',
  '**/dist/**',
  '**/release/**',
  '**/artifacts/**',
  '**/.stryker-tmp/**',
  '**/tests/**',
  'tests/**',
  '**/__tests__/**',
  '**/*.test.*',
  '**/*.d.ts',
  'mockups/**',
  'research/**',
];

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
      file => `${file.file} ${file.pct.toFixed(1)}% (${file.covered}/${file.total})`,
    ),
  };
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
  for (const glob of coverageExcludes) args.push('--exclude', glob);
  return args.concat(testCommand(runner, files));
}

async function main(argv) {
  const options = parseArgsCoverage(argv);
  // c8 keys its report by real path (macOS /var -> /private/var), so compare real to real.
  const cwd = realpathSync(options.cwd);
  const files = expandGlobs(options.tests, cwd);
  if (files.length === 0) {
    throw new ScorerError(`--tests matched no files: ${options.tests.join(', ')}`);
  }
  const reportDir = join(artifactsDir, 'coverage');
  const run = runLogged(
    'coverage',
    c8Args({ scopes: options.scope, runner: options.runner, files, reportDir }),
    { cwd, timeoutMs: options.timeoutSec * 1000 },
  );
  if (run.error?.code === 'ETIMEDOUT') {
    throw new ScorerError(`c8 timed out after ${options.timeoutSec} s`);
  }
  if (run.error) throw new ScorerError(`c8 failed to start: ${run.error.message}`);
  // A non-zero status usually means a test failed; the summary still scores, and the harness's
  // own test gate is what rejects the attempt.
  const summary = readJsonFile(join(reportDir, 'coverage-summary.json'), 'c8 summary report');
  const rows = summaryFiles(summary, cwd).filter(row => inScope(row.file, options.scope));
  if (rows.length === 0 && options.scope.length > 0) {
    throw new ScorerError(`--scope matched no files in the coverage report`);
  }
  const { score, details } = scoreFiles(rows);
  emitScore(score, details);
}

runCli(import.meta.url, main);
