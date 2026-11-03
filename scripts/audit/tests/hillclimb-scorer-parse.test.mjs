// Pure-function tests for the hill-climb scorers (roadmap 5.1c): the parsing and scoring maths
// run against inline fixtures of each tool's real output, so the heavy tools never run here.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  c8Args,
  rowsForScope,
  scoreFiles,
  summaryFiles,
  testCommand,
} from '../hillclimb/scorers/coverage.mjs';
import {
  mutatePatterns,
  parseArgsMutation,
  reportMutants,
  renderRunConfig,
  sampleMutants,
  scoreMutation,
} from '../hillclimb/scorers/mutation.mjs';
import {
  owningManifests,
  reportFromRun as knipReport,
  scoreKnip,
  scoredFindings,
} from '../hillclimb/scorers/knip.mjs';
import {
  reportFromRun as depcruiseReport,
  scoreDepcruise,
  scoredViolations,
} from '../hillclimb/scorers/depcruise.mjs';
import { fixWorkspaceLinks, runnerArgs } from '../hillclimb/scorers/stryker-run.mjs';
import {
  ScorerError,
  TAMPER_PATTERNS,
  emitScore,
  findTampering,
  inScope,
  isExcluded,
  makeRunDir,
  parseArgs,
  requireScopeMatch,
  scopeFiles,
} from '../hillclimb/scorers/util.mjs';

test('util parseArgs: repeatable values, numbers, strings and errors', () => {
  const options = parseArgs(['--scope', 'a/**', '--scope', 'b/**', '--timeout-sec', '5'], {
    values: { '--scope': 'scope' },
    numbers: { '--timeout-sec': { key: 'timeoutSec', default: 60 } },
    strings: { '--runner': { key: 'runner', default: 'node', oneOf: ['node', 'x'] } },
  });
  assert.deepEqual(options.scope, ['a/**', 'b/**']);
  assert.equal(options.timeoutSec, 5);
  assert.equal(options.runner, 'node');
  assert.throws(() => parseArgs(['--bogus'], {}), ScorerError);
  assert.throws(
    () =>
      parseArgs(['--timeout-sec', 'nan'], {
        numbers: { '--timeout-sec': { key: 't', default: 1 } },
      }),
    ScorerError,
  );
  assert.throws(
    () =>
      parseArgs(['--runner', 'y'], {
        strings: { '--runner': { key: 'r', default: 'node', oneOf: ['node'] } },
      }),
    ScorerError,
  );
  assert.throws(() => parseArgs(['--scope'], { values: { '--scope': 's' } }), ScorerError);
});

test('util inScope: empty scope matches all, glob semantics match the boundary rule', () => {
  assert.equal(inScope('a/b.ts', []), true);
  assert.equal(inScope('packages/engine/src/x.ts', ['packages/engine/src/**']), true);
  assert.equal(inScope('packages/engine/src', ['packages/engine/src/**']), true);
  assert.equal(inScope('packages/engine/src/x.ts', ['packages/engine/src']), false);
  assert.equal(inScope('apps/web/src/x.ts', ['packages/**']), false);
});

test('util emitScore writes one JSON line, capped at 10 details of 200 chars', () => {
  const writes = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = chunk => writes.push(chunk);
  try {
    emitScore(
      -7,
      Array.from({ length: 12 }, (_, i) => `line ${i} ` + 'x'.repeat(300)),
    );
  } finally {
    process.stdout.write = original;
  }
  assert.equal(writes.length, 1);
  const line = JSON.parse(writes[0]);
  assert.equal(line.score, -7);
  assert.equal(line.details.length, 10);
  assert.equal(line.details[0].length, 200);
  assert.throws(() => emitScore(Number.POSITIVE_INFINITY, []), ScorerError);
});

// --- coverage -------------------------------------------------------------

test('coverage summaryFiles: per-file rows sorted, total skipped, abs paths made relative', () => {
  const summary = {
    total: { lines: { covered: 8, total: 13, pct: 61.5 } },
    '/root/src/b.ts': { lines: { covered: 3, total: 10, pct: 30 } },
    '/root/src/a.ts': { lines: { covered: 5, total: 5, pct: 100 } },
  };
  assert.deepEqual(summaryFiles(summary, '/root'), [
    { file: 'src/a.ts', covered: 5, total: 5, pct: 100 },
    { file: 'src/b.ts', covered: 3, total: 10, pct: 30 },
  ]);
});

test('coverage scoreFiles: weighted line percent, worst file first', () => {
  const { score, details } = scoreFiles([
    { file: 'src/a.ts', covered: 9, total: 10, pct: 90 },
    { file: 'src/b.ts', covered: 1, total: 10, pct: 10 },
    { file: 'src/empty.ts', covered: 0, total: 0, pct: 100 },
    { file: 'src/hidden.ts', covered: 0, total: 20, pct: 0, absent: true },
  ]);
  assert.equal(score, 25);
  assert.deepEqual(details, [
    'src/hidden.ts 0.0% (0/20), absent from c8 report',
    'src/b.ts 10.0% (1/10)',
    'src/a.ts 90.0% (9/10)',
  ]);
  assert.equal(scoreFiles([]).score, 0);
});

test('coverage rowsForScope: the denominator is authoritative, absent files count 0%', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hillclimb-rows-'));
  try {
    writeFileSync(join(dir, 'hasreport.js'), 'export const a = 1;\nexport const b = 2;\n');
    writeFileSync(join(dir, 'absent.js'), 'export const c = 3;\nexport const d = 4;\n');
    const reportRows = [{ file: 'hasreport.js', covered: 2, total: 2, pct: 100 }];
    const rows = rowsForScope(reportRows, ['absent.js', 'hasreport.js'], dir);
    assert.deepEqual(rows, [
      { file: 'absent.js', covered: 0, total: 2, pct: 0, absent: true },
      { file: 'hasreport.js', covered: 2, total: 2, pct: 100 },
    ]);
    // No scope: the reported files are the rows, unchanged.
    assert.deepEqual(rowsForScope(reportRows, null, dir), reportRows);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('coverage testCommand and c8Args shape', () => {
  assert.deepEqual(testCommand('node', ['t1.test.ts']).slice(1), [
    '--import',
    'tsx',
    '--test',
    't1.test.ts',
  ]);
  const electron = testCommand('electron-node', ['t.test.ts']);
  assert.match(electron[1], /electron-node\.mjs$/);
  const args = c8Args({
    scopes: ['packages/engine/src/**'],
    runner: 'node',
    files: ['t.test.ts'],
    reportDir: '/r',
  });
  assert.ok(args.includes('--all'));
  assert.ok(args.includes('--include'));
  assert.ok(args.includes('packages/engine/src/**'));
  assert.ok(args.includes('--exclude'));
  assert.ok(args.includes('**/tests/**'));
});

// --- mutation -------------------------------------------------------------

const loc = (sl, sc, el = sl, ec = sc + 1) => ({
  start: { line: sl, column: sc },
  end: { line: el, column: ec },
});
const mutant = (fileName, line, column, mutatorName = 'Mut', status = 'Survived') => ({
  fileName,
  mutatorName,
  status,
  location: loc(line, column),
});

test('mutation sampleMutants: deterministic even stride over sorted mutants', () => {
  const mutants = [
    mutant('b.ts', 5, 0),
    mutant('a.ts', 9, 0),
    mutant('a.ts', 1, 0),
    mutant('a.ts', 1, 4),
  ];
  const all = sampleMutants(mutants, 10);
  assert.deepEqual(
    all.map(m => `${m.fileName}:${m.location.start.line}:${m.location.start.column}`),
    ['a.ts:1:0', 'a.ts:1:4', 'a.ts:9:0', 'b.ts:5:0'],
  );
  const capped = sampleMutants(mutants, 2);
  assert.equal(capped.length, 2);
  assert.deepEqual(capped, sampleMutants(mutants, 2));
  // Stride floor(i * 4 / 2) picks indexes 0 and 2 of the sorted list.
  assert.equal(capped[0].location.start.line, 1);
  assert.equal(capped[1].location.start.line, 9);
});

test('mutation mutatePatterns: 1-based line, 0-based column ranges; touching ranges merge', () => {
  assert.deepEqual(mutatePatterns([mutant('src/a.ts', 0, 2, 'Mut', 'x')]), ['src/a.ts:1:2-1:3']);
  const merged = mutatePatterns([
    mutant('src/a.ts', 0, 0, 'Mut', 'x'),
    mutant('src/a.ts', 0, 1, 'Mut', 'x'),
    mutant('src/b.ts', 2, 0, 'Mut', 'x'),
  ]);
  assert.deepEqual(merged, ['src/a.ts:1:0-1:2', 'src/b.ts:3:0-3:1']);
});

test('mutation scoreMutation: killed+timeout over valid; survivors listed first', () => {
  const mutants = [
    mutant('src/a.ts', 0, 0, 'BlockStatement', 'Killed'),
    mutant('src/a.ts', 1, 0, 'EqualityOperator', 'Survived'),
    mutant('src/a.ts', 2, 0, 'ArithmeticOperator', 'Timeout'),
    mutant('src/a.ts', 3, 0, 'ConditionalExpression', 'NoCoverage'),
    mutant('src/a.ts', 4, 0, 'Broken', 'CompileError'),
    mutant('src/a.ts', 5, 0, 'IgnoredMutant', 'Ignored'),
  ];
  const { score, details } = scoreMutation(mutants);
  assert.equal(score, 50); // 2 of 4 valid mutants killed
  assert.deepEqual(details, [
    'ignored: 1',
    'src/a.ts:2 EqualityOperator (survived)',
    'src/a.ts:4 ConditionalExpression (nocoverage)',
    'src/a.ts:5 Broken (compileerror)',
  ]);
  assert.equal(scoreMutation([]).score, 0);
});

test('mutation scoreMutation: timeouts count as kills only up to 10% of valid mutants', () => {
  // 4 valid mutants: the cap is 1, so 3 timeouts only count as a single kill.
  const mutants = [
    mutant('src/a.ts', 0, 0, 'Mut', 'Timeout'),
    mutant('src/a.ts', 1, 0, 'Mut', 'Timeout'),
    mutant('src/a.ts', 2, 0, 'Mut', 'Timeout'),
    mutant('src/a.ts', 3, 0, 'Mut', 'Survived'),
  ];
  const { score, details } = scoreMutation(mutants);
  assert.equal(score, 25);
  assert.ok(details.some(line => /past the 10% cap/.test(line)));
  // 20 valid mutants: the cap is 2, so 3 timeouts count as 2 kills.
  const twenty = [
    ...Array.from({ length: 3 }, (_, i) => mutant('src/a.ts', i, 0, 'Mut', 'Timeout')),
    ...Array.from({ length: 17 }, (_, i) => mutant('src/a.ts', i + 3, 0, 'Mut', 'Killed')),
  ];
  assert.equal(scoreMutation(twenty).score, (19 / 20) * 100);
});

test('mutation reportMutants flattens the report files map', () => {
  const report = {
    files: {
      'src/a.ts': { mutants: [{ id: '1', status: 'Killed' }] },
      'src/b.ts': {
        mutants: [
          { id: '2', status: 'Survived' },
          { id: '3', status: 'Killed' },
        ],
      },
    },
  };
  assert.deepEqual(
    reportMutants(report).map(m => `${m.fileName}#${m.id}`),
    ['src/a.ts#1', 'src/b.ts#2', 'src/b.ts#3'],
  );
});

test('mutation parseArgs requires --scope and --tests', () => {
  assert.throws(() => parseArgsMutation(['--tests', 'tests/**']), /needs --scope/);
  assert.throws(() => parseArgsMutation(['--scope', 'src/**']), /needs --tests/);
  const ok = parseArgsMutation(['--scope', 'src/**', '--tests', 'tests/**', '--max-mutants', '30']);
  assert.equal(ok.maxMutants, 30);
  assert.equal(ok.runner, 'node');
});

test('mutation renderRunConfig layers mutate ranges, command and report on the base config', () => {
  const config = renderRunConfig({
    mutate: ['src/a.ts:1:0-1:2'],
    runner: 'node',
    reportFile: '/tmp/report.json',
  });
  assert.match(config, /mutate: \[\s*"src\/a\.ts:1:0-1:2"\s*\]/);
  // The command names no file: test paths travel in a JSON file via the env var instead.
  assert.match(
    config,
    /commandRunner: \{ command: "'[^']*' '[^']*stryker-run\.mjs' --runner node" \}/,
  );
  assert.doesNotMatch(config, /\.test\.ts/);
  assert.match(config, /jsonReporter: \{ fileName: "\/tmp\/report\.json" \}/);
  assert.match(config, /import base from "file:\/\/.*stryker\.config\.mjs"/);
});

// --- knip -----------------------------------------------------------------

const knipIssue = (
  file,
  { files = [], exports = [], dependencies = [], devDependencies = [] } = {},
) => ({
  file,
  files: files.map(name => ({ name })),
  exports: exports.map(name => ({ name })),
  dependencies: dependencies.map(name => ({ name })),
  devDependencies: devDependencies.map(name => ({ name })),
});

test('knip scoredFindings: files 3, exports 1, dependencies 3; scope filters', () => {
  const issues = [
    knipIssue('apps/web/src/dead.ts', { files: ['dead.ts'] }),
    knipIssue('apps/web/package.json', { dependencies: ['leftpad'], devDependencies: ['other'] }),
    knipIssue('apps/web/src/a.ts', { exports: ['unused1', 'unused2'] }),
    knipIssue('packages/engine/src/x.ts', { exports: ['nope'] }),
  ];
  const all = scoredFindings(issues, []);
  assert.deepEqual(
    all.map(r => `${r.file}:${r.weight}`),
    [
      'apps/web/src/dead.ts:3',
      'apps/web/package.json:6',
      'apps/web/src/a.ts:2',
      'packages/engine/src/x.ts:1',
    ],
  );
  const scoped = scoredFindings(issues, ['apps/web/**']);
  assert.equal(scoped.length, 3);
});

test('knip scoreKnip: score is -(weights), worst file first', () => {
  const rows = [
    { file: 'b.ts', files: 0, exports: 2, dependencies: 0, weight: 2 },
    { file: 'a.ts', files: 1, exports: 0, dependencies: 0, weight: 3 },
  ];
  const { score, details } = scoreKnip(rows);
  assert.equal(score, -5);
  assert.deepEqual(details, [
    'a.ts: 1 unused file (weight 3)',
    'b.ts: 2 unused exports (weight 2)',
  ]);
});

test('knip reportFromRun parses JSON after leading log noise and fails on no report', () => {
  const report = { issues: [knipIssue('x.ts', { files: ['x.ts'] })] };
  const run = { status: 1, stdout: `knip v6\n${JSON.stringify(report)}`, stderr: '' };
  assert.equal(knipReport(run).issues.length, 1);
  assert.throws(
    () => knipReport({ status: 2, stdout: '', stderr: 'bad config\nmore' }),
    /bad config/,
  );
});

// --- depcruise --------------------------------------------------------------

const violation = (from, to, name, severity, type = 'dependency') => ({
  type,
  from,
  to,
  rule: { name, severity },
});

test('depcruise scoredViolations: errors 3, warnings 1, cycles 2; scope filters from', () => {
  const violations = [
    violation('packages/engine/src/a.ts', 'node:fs', 'engine-core-no-node', 'error'),
    violation(
      'packages/engine/src/x.ts',
      'packages/engine/src/y.ts',
      'no-circular-engine',
      'error',
      'cycle',
    ),
    violation('packages/x/a.ts', 'apps/web/z.ts', 'packages-no-apps', 'warn'),
    violation('other/a.ts', 'x', 'whatever', 'error'),
  ];
  const rows = scoredViolations(violations, ['packages/**']);
  assert.deepEqual(
    rows.map(r => `${r.rule.name}:${r.weight}`),
    ['engine-core-no-node:3', 'no-circular-engine:2', 'packages-no-apps:1'],
  );
});

test('depcruise scoreDepcruise: score is -(weights), details are from -> to (rule)', () => {
  const rows = scoredViolations(
    [
      violation('b.ts', 'node:fs', 'engine-core-no-node', 'error'),
      violation('a.ts', 'c.ts', 'no-circular-engine', 'error', 'cycle'),
    ],
    [],
  );
  const { score, details } = scoreDepcruise(rows);
  assert.equal(score, -5);
  assert.deepEqual(details, [
    'b.ts -> node:fs (engine-core-no-node)',
    'a.ts -> c.ts (no-circular-engine)',
  ]);
});

test('depcruise reportFromRun parses JSON after noise and fails on no report', () => {
  const report = { summary: { violations: [] } };
  assert.deepEqual(
    depcruiseReport({ status: 0, stdout: JSON.stringify(report), stderr: '' }).summary.violations,
    [],
  );
  assert.throws(() => depcruiseReport({ status: 1, stdout: '', stderr: 'nope' }), /nope/);
});

// --- stryker-run -----------------------------------------------------------

test('stryker-run fixWorkspaceLinks points @aplos links at the sandbox tree', () => {
  const root = mkdtempSync(join(tmpdir(), 'hillclimb-stryrun-'));
  const real = join(root, 'real');
  const sandbox = join(root, 'sandbox');
  mkdirSync(join(real, 'node_modules', '@aplos'), { recursive: true });
  mkdirSync(join(real, 'node_modules', 'leftpad'), { recursive: true });
  mkdirSync(join(real, 'packages', 'engine'), { recursive: true });
  mkdirSync(join(real, 'apps', 'desktop'), { recursive: true });
  symlinkSync('../../packages/engine', join(real, 'node_modules', '@aplos', 'engine'));
  symlinkSync('../../apps/desktop', join(real, 'node_modules', '@aplos', 'desktop'));
  mkdirSync(join(sandbox, 'packages', 'engine'), { recursive: true });
  mkdirSync(join(sandbox, 'apps', 'desktop'), { recursive: true });
  symlinkSync(join(real, 'node_modules'), join(sandbox, 'node_modules'));

  assert.equal(fixWorkspaceLinks(sandbox), true);
  assert.equal(
    readlinkSync(join(sandbox, 'node_modules', 'leftpad')),
    join(real, 'node_modules', 'leftpad'),
  );
  assert.equal(
    readlinkSync(join(sandbox, 'node_modules', '@aplos', 'engine')),
    join('..', '..', 'packages', 'engine'),
  );
  assert.equal(fixWorkspaceLinks(sandbox), false); // already a real directory now

  const plain = join(root, 'plain');
  mkdirSync(plain, { recursive: true });
  assert.equal(fixWorkspaceLinks(plain), false);
  rmSync(root, { recursive: true, force: true });
});

test('stryker-run runnerArgs: node and electron-node runners', () => {
  assert.deepEqual(runnerArgs('node', ['a.test.ts']), ['--import', 'tsx', '--test', 'a.test.ts']);
  const electron = runnerArgs('electron-node', ['a.test.ts']);
  assert.match(electron[0], /scripts[\\/]audit[\\/]electron-node\.mjs$/);
});

// --- denominator and tamper helpers ------------------------------------------------

test('util isExcluded and scopeFiles: the fixed exclude set is applied once', () => {
  assert.equal(isExcluded('packages/engine/tests/x.test.ts'), true);
  assert.equal(isExcluded('packages/engine/src/x.test.ts'), true);
  assert.equal(isExcluded('packages/engine/src/x.d.ts'), true);
  assert.equal(isExcluded('apps/web/dist/out.js'), true);
  assert.equal(isExcluded('packages/engine/src/x.ts'), false);
  const dir = makeExcludedFixture();
  try {
    assert.deepEqual(scopeFiles(['hillclimb-excludes/**'], dir), [
      'hillclimb-excludes/src/kept.ts',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('util requireScopeMatch: an unmatched scope throws a ScorerError', () => {
  const dir = makeExcludedFixture();
  try {
    assert.deepEqual(requireScopeMatch(['hillclimb-excludes/**'], dir), [
      'hillclimb-excludes/src/kept.ts',
      'hillclimb-excludes/tests/x.test.ts',
    ]);
    assert.throws(
      () => requireScopeMatch(['hillclimb-excludes/nope/**'], dir),
      /--scope matched no repo files/,
    );
    assert.deepEqual(requireScopeMatch([], dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('util findTampering names file:line for every directive spelling', () => {
  const cases = [
    ['coverage', '/* v8 ignore next */\nexport const a = 1;\n', 'f.js:1'],
    ['coverage', 'export const a = 1; /* C8 IGNORE next */\n', 'f.js:1'],
    ['coverage', '// istanbul ignore file\nexport const a = 1;\n', 'f.js:1'],
    ['coverage', '/* node:coverage disable */\nexport const a = 1;\n', 'f.js:1'],
    ['mutation', '// Stryker disable\nexport const a = 1;\n', 'f.js:1'],
    ['mutation', 'export const a = globalThis.__stryker__;\n', 'f.js:1'],
    ['mutation', 'export const a = globalThis.STRYKER_ACTIVE_MUTANT;\n', 'f.js:1'],
    ['knip', '/** @public */\nexport const a = 1;\n', 'f.js:1'],
    ['knip', '/** @internal */\nexport const a = 1;\n', 'f.js:1'],
    ['knip', '/** @lintignore */\nexport const a = 1;\n', 'f.js:1'],
    ['knip', '/** @knipignore */\nexport const a = 1;\n', 'f.js:1'],
  ];
  const dir = mkdtempSync(join(tmpdir(), 'hillclimb-tamper-'));
  try {
    for (const [kind, text, expected] of cases) {
      writeFileSync(join(dir, 'f.js'), text);
      assert.deepEqual(findTampering(['f.js'], TAMPER_PATTERNS[kind], dir), [expected], kind);
    }
    writeFileSync(join(dir, 'f.js'), 'export const a = 1;\n');
    for (const kind of Object.keys(TAMPER_PATTERNS))
      assert.deepEqual(findTampering(['f.js'], TAMPER_PATTERNS[kind], dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('util makeRunDir: fresh directories under artifacts/hillclimb/scorers', () => {
  const a = makeRunDir('check');
  const b = makeRunDir('check');
  assert.notEqual(a, b);
  assert.match(a, /artifacts[\\/]hillclimb[\\/]scorers[\\/]check-/);
  rmSync(a, { recursive: true, force: true });
  rmSync(b, { recursive: true, force: true });
});

// A fixture tree exercising the exclude set: a source file and a test file.
function makeExcludedFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'hillclimb-excludes-'));
  mkdirSync(join(dir, 'hillclimb-excludes', 'src'), { recursive: true });
  mkdirSync(join(dir, 'hillclimb-excludes', 'tests'), { recursive: true });
  writeFileSync(join(dir, 'hillclimb-excludes', 'src', 'kept.ts'), 'export const a = 1;\n');
  writeFileSync(
    join(dir, 'hillclimb-excludes', 'tests', 'x.test.ts'),
    "import { test } from 'node:test';\ntest('x', () => {});\n",
  );
  return dir;
}

// --- knip manifests ---------------------------------------------------------------

test('knip owningManifests: scoped files map to their owning package.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hillclimb-manifests-'));
  try {
    mkdirSync(join(dir, 'packages', 'engine', 'src'), { recursive: true });
    mkdirSync(join(dir, 'packages', 'emulators', 'src'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), '{}\n');
    writeFileSync(join(dir, 'packages', 'engine', 'package.json'), '{}\n');
    writeFileSync(join(dir, 'packages', 'emulators', 'package.json'), '{}\n');
    assert.deepEqual(
      owningManifests(
        ['packages/engine/src/a.ts', 'packages/engine/src/deep/b.ts', 'packages/emulators/c.ts'],
        dir,
      ),
      ['packages/emulators/package.json', 'packages/engine/package.json'],
    );
    assert.deepEqual(owningManifests(['scripts/tool.mjs'], dir), ['package.json']);
    assert.deepEqual(owningManifests([], dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('knip scoredFindings counts dependency findings on a scoped manifest', () => {
  const issues = [
    knipIssue('packages/engine/package.json', { dependencies: ['leftpad'] }),
    knipIssue('packages/engine/src/x.ts', { exports: ['unused'] }),
  ];
  // Scope the source tree plus its owning manifest, as main() does.
  const scopes = ['packages/engine/src/**', 'packages/engine/package.json'];
  const rows = scoredFindings(issues, scopes);
  assert.deepEqual(
    rows.map(r => `${r.file}:${r.weight}`),
    ['packages/engine/package.json:3', 'packages/engine/src/x.ts:1'],
  );
  // Without the manifest the dependency finding is invisible to the same scope.
  assert.deepEqual(
    scoredFindings(issues, ['packages/engine/src/**']).map(r => r.file),
    ['packages/engine/src/x.ts'],
  );
});
