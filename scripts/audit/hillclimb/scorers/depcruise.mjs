#!/usr/bin/env node
// Layer-rule scorer (roadmap 5.1c): runs dependency-cruiser with the repo's .dependency-cruiser.cjs
// (which mirrors the aplos/boundaries ESLint zones) and weights the violations whose `from` file is
// inside --scope: errors 3, warnings 1, circular edges 2. score = -(total).
// --scope also becomes the cruise entry arguments, so a target can score only its own paths; with no
// scope the source roots `packages` and `apps` are cruised. details = `from -> to (rule)`, then a
// trailing `depcruise ran X s` line. An empty scope fails hard: scoring nothing would print 0,
// the penalty score's maximum.
// Typical runtime: a few seconds with the doNotFollow/includeOnly options in .dependency-cruiser.cjs.
//   node scripts/audit/hillclimb/scorers/depcruise.mjs [--scope <glob>]... [--timeout-sec <n, default 300>]
import { join } from 'node:path';
import {
  ScorerError,
  emitScore,
  inScope,
  parseArgs,
  repoRoot,
  requireScopeMatch,
  runCli,
  runLogged,
} from './util.mjs';

const depcruiseBin = join(
  repoRoot,
  'node_modules',
  'dependency-cruiser',
  'bin',
  'dependency-cruiser.mjs',
);

export const errorWeight = 3;
export const warnWeight = 1;
export const circularWeight = 2;

export function parseArgsDepcruise(argv) {
  return parseArgs(argv, {
    values: { '--scope': 'scope' },
    numbers: { '--timeout-sec': { key: 'timeoutSec', default: 300 } },
    strings: { '--cwd': { key: 'cwd', default: repoRoot } },
  });
}

const severityWeight = severity => (severity === 'error' ? errorWeight : warnWeight);

/**
 * dependency-cruiser's JSON report carries violations on summary.violations:
 * { type, from, to, rule: { name, severity } }. A circular edge keeps its rule's severity but is
 * priced by its circularity (weight 2), not the severity, per the scorer contract.
 */
export function scoredViolations(violations, scopes) {
  const rows = [];
  for (const violation of violations) {
    if (!inScope(violation.from, scopes)) continue;
    const weight =
      violation.type === 'cycle' ? circularWeight : severityWeight(violation.rule.severity);
    rows.push({ ...violation, weight });
  }
  return rows;
}

export function scoreDepcruise(rows) {
  const total = rows.reduce((sum, row) => sum + row.weight, 0);
  const worst = [...rows].sort(
    (a, b) => b.weight - a.weight || a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
  );
  const details = worst.map(row => `${row.from} -> ${row.to} (${row.rule.name})`);
  return { score: -total, details };
}

/** Like knip, depcruise exits non-zero on findings; the JSON report on stdout is the result. */
export function reportFromRun(run) {
  const stdout = String(run.stdout ?? '');
  const start = stdout.indexOf('{');
  if (start !== -1) {
    try {
      return JSON.parse(stdout.slice(start));
    } catch {
      /* fall through to the failure below */
    }
  }
  const firstErr =
    String(run.stderr ?? '')
      .trim()
      .split('\n')[0] || `exit ${run.status}`;
  throw new ScorerError(`dependency-cruiser produced no report: ${firstErr}`);
}

async function main(argv) {
  const options = parseArgsDepcruise(argv);
  // Check the scope names real files before cruising: an empty match would report 0 findings,
  // which is the best possible penalty score for work that never happened.
  requireScopeMatch(options.scope, options.cwd);
  const args = options.scope.length > 0 ? options.scope : ['packages', 'apps'];
  const configFile = join(options.cwd, '.dependency-cruiser.cjs');
  const run = runLogged(
    'depcruise',
    [process.execPath, depcruiseBin, '--config', configFile, '--output-type', 'json', ...args],
    { cwd: options.cwd, timeoutMs: options.timeoutSec * 1000 },
  );
  if (run.error?.code === 'ETIMEDOUT')
    throw new ScorerError(`dependency-cruiser timed out after ${options.timeoutSec} s`);
  if (run.error) throw new ScorerError(`dependency-cruiser failed to start: ${run.error.message}`);
  const report = reportFromRun(run);
  const { score, details } = scoreDepcruise(
    scoredViolations(report.summary?.violations ?? [], options.scope),
  );
  // The run time always survives the 10-line details cap: nine findings at most, then timing.
  emitScore(score, [
    ...details.slice(0, 9),
    `depcruise ran ${(run.elapsedMs / 1000).toFixed(1)} s`,
  ]);
}

runCli(import.meta.url, main);
