#!/usr/bin/env node
// Dead-code scorer (roadmap 5.1c): runs knip with the repo's knip.json and weights the findings
// that land inside --scope: unused files 3, unused exports 1, unused dependencies 3.
// score = -(weighted findings). knip always runs over the whole repo — an unused export is only
// unused when nothing anywhere imports it — and the scope restricts which findings count.
// Unused-dependency findings sit on the owning workspace's package.json, not on the scoped
// files, so each owning manifest joins the report scope.
// details = the worst-offending files first.
// By default knip runs with --production so test files cannot count as users of an export
// (an export only a test imports is still dead production code); --include-tests scores the
// test-inclusive graph instead.
// Typical runtime: ~10-20 s over the whole monorepo.
//   node scripts/audit/hillclimb/scorers/knip.mjs [--scope <glob>]... [--include-tests]
//     [--timeout-sec <n, default 120>]
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  ScorerError,
  emitScore,
  inScope,
  parseArgs,
  refuseTampering,
  repoRoot,
  requireScopeMatch,
  runCli,
  runLogged,
} from './util.mjs';

const knipBin = join(repoRoot, 'node_modules', 'knip', 'bin', 'knip.js');

export const fileWeight = 3;
export const exportWeight = 1;
export const dependencyWeight = 3;

export function parseArgsKnip(argv) {
  return parseArgs(argv, {
    values: { '--scope': 'scope' },
    flags: { '--include-tests': 'includeTests' },
    numbers: { '--timeout-sec': { key: 'timeoutSec', default: 120 } },
    strings: { '--cwd': { key: 'cwd', default: repoRoot } },
  });
}

/**
 * The package.json files owning `files` (repo-relative paths under `root`): for each file the
 * nearest ancestor directory containing a package.json. Unused-dependency findings are
 * reported on the manifest, not on the files that declared the dependencies, so a scoped run
 * must count the manifests of the scoped files.
 */
export function owningManifests(files, root = repoRoot) {
  const manifests = new Set();
  const cache = new Map();
  for (const file of files) {
    let dir = dirname(file);
    const chain = [];
    let owner;
    while (owner === undefined) {
      if (cache.has(dir)) {
        owner = cache.get(dir);
      } else {
        chain.push(dir);
        if (existsSync(join(root, dir, 'package.json'))) owner = dir;
        else if (dir === '.' || dir === '') owner = null;
        else dir = dirname(dir);
      }
    }
    for (const visited of chain) cache.set(visited, owner);
    if (owner) manifests.add(owner === '.' ? 'package.json' : `${owner}/package.json`);
  }
  return [...manifests].sort();
}

/**
 * knip's JSON report is an array of per-file entries: { file, files, exports, types, dependencies,
 * devDependencies, ... }, each member array holding { name, line?, ... } findings. Exported types,
 * enum members and namespace members count as unused exports — they are dead exports too.
 * `unlisted` (imported but undeclared packages) is a different bug class and stays uncounted.
 */
export function scoredFindings(issues, scopes) {
  const rows = [];
  for (const issue of issues) {
    const file = issue.file;
    if (!inScope(file, scopes)) continue;
    const files = issue.files?.length ?? 0;
    const exports =
      (issue.exports?.length ?? 0) +
      (issue.types?.length ?? 0) +
      (issue.enumMembers?.length ?? 0) +
      (issue.namespaceMembers?.length ?? 0);
    const dependencies = (issue.dependencies?.length ?? 0) + (issue.devDependencies?.length ?? 0);
    const weight = files * fileWeight + exports * exportWeight + dependencies * dependencyWeight;
    if (weight > 0) rows.push({ file, files, exports, dependencies, weight });
  }
  return rows;
}

export function scoreKnip(rows) {
  const total = rows.reduce((sum, row) => sum + row.weight, 0);
  const worst = [...rows].sort((a, b) => b.weight - a.weight || a.file.localeCompare(b.file));
  const details = worst.map(row => {
    const parts = [
      row.files && `${row.files} unused file${row.files === 1 ? '' : 's'}`,
      row.exports && `${row.exports} unused export${row.exports === 1 ? '' : 's'}`,
      row.dependencies &&
        `${row.dependencies} unused dependenc${row.dependencies === 1 ? 'y' : 'ies'}`,
    ].filter(Boolean);
    return `${row.file}: ${parts.join(', ')} (weight ${row.weight})`;
  });
  return { score: -total, details };
}

/** knip prints the report even when it exits 1 for findings; only missing output is a failure. */
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
  throw new ScorerError(`knip produced no report: ${firstErr}`);
}

async function main(argv) {
  const options = parseArgsKnip(argv);
  // The scope must name real files and carry no knip-honoured JSDoc tags before knip runs:
  // an empty match would print 0 (the penalty score's maximum), and a @public/@internal tag
  // would mark an export used without any importer.
  const scopeFiles = requireScopeMatch(options.scope, options.cwd);
  refuseTampering(scopeFiles, 'knip', options.cwd);
  const args = [knipBin, '--reporter', 'json'];
  if (!options.includeTests) args.push('--production');
  const run = runLogged('knip', [process.execPath, ...args], {
    cwd: options.cwd,
    timeoutMs: options.timeoutSec * 1000,
  });
  if (run.error?.code === 'ETIMEDOUT')
    throw new ScorerError(`knip timed out after ${options.timeoutSec} s`);
  if (run.error) throw new ScorerError(`knip failed to start: ${run.error.message}`);
  const report = reportFromRun(run);
  const reportScopes = [...options.scope, ...owningManifests(scopeFiles, options.cwd)];
  const { score, details } = scoreKnip(scoredFindings(report.issues ?? [], reportScopes));
  emitScore(score, details);
}

runCli(import.meta.url, main);
