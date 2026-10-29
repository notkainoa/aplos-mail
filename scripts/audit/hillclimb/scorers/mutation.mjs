#!/usr/bin/env node
// Mutation scorer (roadmap 5.1c): Stryker with the built-in command test runner, which fits the
// repo's `node --import tsx --test` setup. score = killed+timeout mutants over valid mutants, as
// a percent, for the files matching --scope. --scope is REQUIRED (mutating the whole repo is too
// slow) and --tests names the test files the command runner runs per mutant.
//
// --max-mutants (default 200) bounds the run: the mutants of the scoped files are enumerated with
// Stryker's instrumenter, ordered deterministically (file, line, column, mutator) and sampled at
// an even stride; the sample's locations become `mutate` line:column ranges. A range also runs
// any mutant fully inside it, so the executed count can slightly exceed the sample.
// --timeout-sec (default 600) bounds the whole Stryker run; each test run is capped at 30 s.
// Typical runtime: tens of seconds to a few minutes depending on scope and test count.
//   node scripts/audit/hillclimb/scorers/mutation.mjs --scope <glob> --tests <glob>
//     [--max-mutants <n>] [--timeout-sec <n>] [--runner node|electron-node]
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ScorerError,
  artifactsDir,
  emitScore,
  expandGlobs,
  parseArgs,
  readJsonFile,
  repoRoot,
  runCli,
  runLogged,
} from './util.mjs';

const strykerBin = join(repoRoot, 'node_modules', '@stryker-mutator', 'core', 'bin', 'stryker.js');
const reportFile = join(artifactsDir, 'mutation-report.json');
const runConfigFile = join(artifactsDir, '.stryker-last-run.config.mjs');
// Per-test-run cap inside Stryker; --timeout-sec bounds the whole run instead.
const perRunTimeoutMs = 30_000;
const MUTABLE = /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/;

const KILLED = new Set(['Killed', 'Timeout']);
const VALID = new Set(['Killed', 'Timeout', 'Survived', 'NoCoverage']);
const SURVIVED = new Set(['Survived', 'NoCoverage']);

export function parseArgsMutation(argv) {
  const options = parseArgs(argv, {
    values: { '--scope': 'scope', '--tests': 'tests' },
    numbers: {
      '--max-mutants': { key: 'maxMutants', default: 200 },
      '--timeout-sec': { key: 'timeoutSec', default: 600 },
    },
    strings: {
      '--runner': { key: 'runner', default: 'node', oneOf: ['node', 'electron-node'] },
      '--cwd': { key: 'cwd', default: repoRoot },
    },
  });
  if (options.scope.length === 0)
    throw new ScorerError('mutation needs --scope <glob> (mutating the whole repo is too slow)');
  if (options.tests.length === 0) throw new ScorerError('mutation needs --tests <glob>');
  return options;
}

/**
 * The mutants Stryker would place in `files` (repo-relative paths), enumerated with its own
 * instrumenter so the sampling below matches exactly what a run creates. Per-file calls keep the
 * file attribution stable.
 */
export async function enumerateMutants(files, root = repoRoot) {
  const { Instrumenter } = await import('@stryker-mutator/instrumenter');
  // The scorer runs tests silently; the instrumenter only needs a shape-compatible logger.
  const logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    trace() {},
    fatal() {},
    isDebugEnabled: () => false,
  };
  const instrumenter = new Instrumenter(logger);
  const options = { plugins: [], excludedMutations: [], ignorers: [] };
  const all = [];
  for (const file of files) {
    const content = readFileSync(join(root, file), 'utf8');
    const { mutants } = await instrumenter.instrument(
      [{ name: file, mutate: true, content }],
      options,
    );
    for (const mutant of mutants) all.push({ ...mutant, fileName: file });
  }
  return all;
}

const byPosition = (a, b) =>
  a.fileName.localeCompare(b.fileName) ||
  a.location.start.line - b.location.start.line ||
  a.location.start.column - b.location.start.column ||
  a.mutatorName.localeCompare(b.mutatorName);

/**
 * A deterministic even-stride sample of at most `max` mutants: index floor(i * n / max) spreads
 * the pick across the sorted list instead of taking a prefix, so a cap still covers the scope.
 */
export function sampleMutants(mutants, max) {
  const sorted = [...mutants].sort(byPosition);
  if (sorted.length <= max) return sorted;
  return Array.from({ length: max }, (_, i) => sorted[Math.floor((i * sorted.length) / max)]);
}

/**
 * `mutate` ranges selecting the sampled mutants: each mutant's own location as a
 * file:startLine:startCol-endLine:endCol pattern (lines are 1-based in the pattern, 0-based in
 * the report), with touching ranges merged so the list stays short.
 */
export function mutatePatterns(mutants) {
  const byFile = new Map();
  for (const mutant of mutants) {
    const list = byFile.get(mutant.fileName) ?? [];
    list.push(mutant.location);
    byFile.set(mutant.fileName, list);
  }
  const patterns = [];
  for (const [file, locations] of [...byFile.entries()].sort()) {
    let open = null;
    for (const loc of locations.sort(compareLocations)) {
      if (open && touches(open, loc)) open.end = loc.end;
      else {
        if (open) patterns.push(formatRange(file, open));
        open = { start: { ...loc.start }, end: { ...loc.end } };
      }
    }
    if (open) patterns.push(formatRange(file, open));
  }
  return patterns;
}

const compareLocations = (a, b) => a.start.line - b.start.line || a.start.column - b.start.column;

const touches = (a, b) =>
  a.end.line > b.start.line || (a.end.line === b.start.line && a.end.column >= b.start.column);

const formatRange = (file, range) =>
  `${file}:${range.start.line + 1}:${range.start.column}-${range.end.line + 1}:${range.end.column}`;

/** The per-run config file layering sampled mutate ranges and the test command on the base. */
export function renderRunConfig({ mutate, tests, runner, reportFile }) {
  // The wrapper is addressed absolutely: it runs with the sandbox as cwd, which may hold a
  // fixture tree (not this repo's) where scripts/audit/... does not exist.
  const command = [
    process.execPath,
    join(repoRoot, 'scripts', 'audit', 'hillclimb', 'scorers', 'stryker-run.mjs'),
    '--runner',
    runner,
    ...tests,
  ].join(' ');
  return [
    `import base from ${JSON.stringify('../../../stryker.config.mjs')};`,
    'export default {',
    '  ...base,',
    `  mutate: ${JSON.stringify(mutate, null, 2)},`,
    `  commandRunner: { command: ${JSON.stringify(command)} },`,
    `  timeoutMS: ${perRunTimeoutMs},`,
    `  jsonReporter: { fileName: ${JSON.stringify(reportFile)} },`,
    '};',
    '',
  ].join('\n');
}

/** Flattened mutant rows of a mutation-testing-report-schema JSON file. */
export function reportMutants(report) {
  const mutants = [];
  for (const [file, data] of Object.entries(report.files ?? {})) {
    for (const mutant of data.mutants ?? []) mutants.push({ ...mutant, fileName: file });
  }
  return mutants;
}

/** score = killed+timeout over valid mutants (errors and ignored mutants are not valid). */
export function scoreMutation(mutants) {
  const valid = mutants.filter(mutant => VALID.has(mutant.status));
  const killed = valid.filter(mutant => KILLED.has(mutant.status)).length;
  // Report lines are 0-based (Stryker positions); +1 in the detail so it reads like an editor line.
  const survivors = mutants
    .filter(mutant => SURVIVED.has(mutant.status))
    .sort(byPosition)
    .map(
      mutant =>
        `${mutant.fileName}:${mutant.location.start.line + 1} ${mutant.mutatorName} (${mutant.status.toLowerCase()})`,
    );
  const errored = mutants.filter(
    mutant => !VALID.has(mutant.status) && mutant.status !== 'Ignored',
  );
  const details = [
    ...survivors,
    ...errored.map(
      mutant =>
        `${mutant.fileName}:${(mutant.location?.start?.line ?? -1) + 1} ${mutant.mutatorName} (${mutant.status.toLowerCase()})`,
    ),
  ];
  return {
    score: valid.length === 0 ? 0 : Math.round((killed / valid.length) * 10_000) / 100,
    details,
  };
}

async function main(argv) {
  const options = parseArgsMutation(argv);
  const cwd = options.cwd;
  const scopeFiles = expandGlobs(options.scope, cwd).filter(file => MUTABLE.test(file));
  if (scopeFiles.length === 0)
    throw new ScorerError(`--scope matched no source files: ${options.scope.join(', ')}`);
  const tests = expandGlobs(options.tests, cwd);
  if (tests.length === 0)
    throw new ScorerError(`--tests matched no files: ${options.tests.join(', ')}`);
  const mutants = await enumerateMutants(scopeFiles, cwd);
  if (mutants.length === 0)
    throw new ScorerError('--scope produced no mutants (nothing mutable in the matched files)');
  const mutate = mutatePatterns(
    sampleMutants(mutants, Math.max(1, Math.floor(options.maxMutants))),
  );
  writeFileSync(
    runConfigFile,
    renderRunConfig({ mutate, tests, runner: options.runner, reportFile }),
  );
  const run = runLogged('mutation', [process.execPath, strykerBin, 'run', runConfigFile], {
    cwd,
    timeoutMs: options.timeoutSec * 1000,
  });
  if (run.error?.code === 'ETIMEDOUT')
    throw new ScorerError(`stryker run exceeded --timeout-sec ${options.timeoutSec}`);
  if (run.error) throw new ScorerError(`stryker failed to start: ${run.error.message}`);
  const report = readJsonFile(reportFile, 'stryker mutation report');
  const { score, details } = scoreMutation(reportMutants(report));
  emitScore(score, details);
}

runCli(import.meta.url, main);
