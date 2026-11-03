// Tamper-resistance tests for the hill-climb scorers (roadmap 5.1c): an empty scope must fail
// (0 is a penalty score's maximum), an ignore/exclude directive in a scoped file must fail the
// run, a test file name must never reach the shell command line, and a report must come from a
// fresh per-run directory so a stale one can never be reused. Every failure happens before the
// heavy tool runs — except the coverage-artifact run — so the file stays fast.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fixtureProject, removeFixture, run, scorers } from './hillclimb-fixture.mjs';

// Scorer modules load through `scorers` so a HILLCLIMB_SCORERS_DIR override exercises an
// earlier revision too; the artifacts dir is derived the same way the scorers derive it.
const { renderRunConfig } = await import(join(scorers, 'mutation.mjs'));
const { TESTS_FILE_ENV } = await import(join(scorers, 'stryker-run.mjs'));
const artifactsDir = resolve(scorers, '..', '..', '..', '..', 'artifacts', 'hillclimb', 'scorers');

const stderrLines = run => run.stderr.trim().split('\n').filter(Boolean);

const assertFailsClean = (result, pattern) => {
  assert.notEqual(result.status, 0, `expected a non-zero exit, got ${result.status}`);
  const lines = stderrLines(result);
  assert.equal(lines.length, 1, `expected one stderr line, got ${result.stderr.slice(0, 300)}`);
  assert.match(lines[0], pattern);
};

// --- empty scope: scoring nothing is a failure, never the penalty maximum ---------------

test('knip.mjs: a scope matching no repo file fails instead of printing 0', () => {
  const dir = fixtureProject({
    'knip.json': JSON.stringify({ entry: ['src/index.js!'], project: ['src/**/*.js!'] }),
    'src/index.js': 'export const main = 1;\n',
  });
  try {
    const result = run('knip.mjs', ['--cwd', dir, '--scope', 'nonexistent/**']);
    assertFailsClean(result, /--scope matched no repo files/);
  } finally {
    removeFixture(dir);
  }
});

test('depcruise.mjs: a scope matching no repo file fails instead of printing 0', () => {
  const dir = fixtureProject({
    '.dependency-cruiser.cjs': 'module.exports = { forbidden: [] };\n',
    'src/a.js': 'export const a = 1;\n',
  });
  try {
    const result = run('depcruise.mjs', ['--cwd', dir, '--scope', 'nonexistent/**']);
    assertFailsClean(result, /--scope matched no repo files/);
  } finally {
    removeFixture(dir);
  }
});

test('coverage.mjs: a scope matching no scorable file fails instead of printing 0', () => {
  const dir = fixtureProject({
    'src/a.js': 'export const a = 1;\n',
    'tests/a.test.js': "import { test } from 'node:test';\ntest('a', () => {});\n",
  });
  try {
    const result = run('coverage.mjs', [
      '--cwd',
      dir,
      '--scope',
      'nonexistent/**',
      '--tests',
      'tests/*.test.js',
    ]);
    assertFailsClean(result, /--scope matched no scorable files/);
  } finally {
    removeFixture(dir);
  }
});

test('mutation.mjs: a scope matching no source file fails instead of printing 0', () => {
  const dir = fixtureProject({
    'package.json': '{ "name": "fixture", "private": true, "type": "module" }\n',
    'tests/a.test.js': "import { test } from 'node:test';\ntest('a', () => {});\n",
  });
  try {
    const result = run('mutation.mjs', [
      '--cwd',
      dir,
      '--scope',
      'nonexistent/**',
      '--tests',
      'tests/*.test.js',
    ]);
    assertFailsClean(result, /--scope matched no source files/);
  } finally {
    removeFixture(dir);
  }
});

// --- directive scans: a scoped file must not hide code from the scorer ------------------

for (const directive of [
  '/* v8 ignore next */',
  '/* c8 ignore next */',
  '/* istanbul ignore next */',
  '/* node:coverage disable */',
]) {
  test(`coverage.mjs: a scoped file containing ${directive} fails the run`, () => {
    const dir = fixtureProject({
      'src/a.js': `${directive}\nexport const a = 1;\n`,
      'tests/a.test.js': "import { test } from 'node:test';\ntest('a', () => {});\n",
    });
    try {
      const result = run('coverage.mjs', [
        '--cwd',
        dir,
        '--scope',
        'src/**',
        '--tests',
        'tests/*.test.js',
      ]);
      assertFailsClean(result, /coverage-exclude directive in scoped file src\/a\.js:1/);
    } finally {
      removeFixture(dir);
    }
  });
}

for (const marker of [
  '// Stryker disable',
  'export const a = globalThis.__stryker__;',
  'export const a = globalThis.STRYKER_ACTIVE_MUTANT;',
]) {
  test(`mutation.mjs: a scoped file containing "${marker.slice(0, 32)}" fails`, () => {
    const dir = fixtureProject({
      'package.json': '{ "name": "fixture", "private": true, "type": "module" }\n',
      'src/a.js': `${marker}\nexport const b = 1;\n`,
      'tests/a.test.js': "import { test } from 'node:test';\ntest('a', () => {});\n",
    });
    try {
      const result = run('mutation.mjs', [
        '--cwd',
        dir,
        '--scope',
        'src/**',
        '--tests',
        'tests/*.test.js',
      ]);
      assertFailsClean(result, /mutation-exclude directive in scoped file src\/a\.js:1/);
    } finally {
      removeFixture(dir);
    }
  });
}

for (const tag of ['@public', '@internal', '@lintignore', '@knipignore']) {
  test(`knip.mjs: a scoped file carrying a ${tag} tag fails the run`, () => {
    const dir = fixtureProject({
      'knip.json': JSON.stringify({ entry: ['src/index.js!'], project: ['src/**/*.js!'] }),
      'src/index.js': `/** ${tag} */\nexport const main = 1;\n`,
    });
    try {
      const result = run('knip.mjs', ['--cwd', dir, '--scope', 'src/**']);
      assertFailsClean(result, /knip-exclude directive in scoped file src\/index\.js:1/);
    } finally {
      removeFixture(dir);
    }
  });
}

// --- hostile file names: the test list travels in JSON, never the shell command ---------

test('a hostile test file name cannot inject into the stryker command', { timeout: 60_000 }, () => {
  const marker = join(tmpdir(), `hillclimb-pwned-${process.pid}`);
  const hostile = `a;touch ${marker};.test.js`;
  const dir = fixtureProject({
    'package.json': '{ "name": "fixture", "private": true, "type": "module" }\n',
    [`tests/${hostile}`]: "import { test } from 'node:test';\ntest('x', () => {});\n",
  });
  try {
    const testsFile = join(dir, 'tests.json');
    writeFileSync(testsFile, JSON.stringify([`tests/${hostile}`]));
    const config = renderRunConfig({
      mutate: [],
      tests: [`tests/${hostile}`],
      runner: 'node',
      reportFile: join(dir, 'r.json'),
    });
    const encoded = config.match(/commandRunner: \{ command: "(.*)" \}/);
    assert.ok(encoded, 'run config carries no commandRunner.command');
    const command = JSON.parse(`"${encoded[1]}"`);
    // The shell command carries no file name at all: the hostile path lives only in the
    // JSON document the env var points at.
    assert.doesNotMatch(command, /a;touch|\.test\.js/);
    // Executing it through a real shell (as Stryker's command runner does) must not inject.
    const result = spawnSync('/bin/sh', ['-c', command], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, [TESTS_FILE_ENV]: testsFile },
      timeout: 45_000,
    });
    assert.equal(existsSync(marker), false, 'the file name injected a shell command');
    assert.equal(result.status, 0, `stryker-run failed: ${result.stderr.slice(0, 300)}`);
  } finally {
    removeFixture(dir);
    rmSync(marker, { force: true });
  }
});

// --- stale artifacts: reports live in a fresh per-run directory -------------------------

test(
  'coverage.mjs writes its report to a per-run dir, not the old fixed path',
  { timeout: 60_000 },
  () => {
    const stale = join(artifactsDir, 'coverage', 'coverage-summary.json');
    rmSync(join(artifactsDir, 'coverage'), { recursive: true, force: true });
    const dir = fixtureProject({
      'src/calc.js': 'export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\n',
      'tests/calc.test.js':
        "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/calc.js';\ntest('add', () => assert.equal(add(1, 2), 3));\n",
    });
    try {
      const result = run('coverage.mjs', [
        '--cwd',
        dir,
        '--scope',
        'src/**',
        '--tests',
        'tests/*.test.js',
      ]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(existsSync(stale), false, 'a report was written to the fixed artifact path');
      const leftovers = existsSync(artifactsDir)
        ? readdirSync(artifactsDir).filter(name => name.startsWith('coverage-'))
        : [];
      assert.deepEqual(leftovers, [], 'per-run dirs were left behind');
    } finally {
      removeFixture(dir);
      rmSync(join(artifactsDir, 'coverage'), { recursive: true, force: true });
    }
  },
);

test(
  'mutation.mjs leaves no config or report at the old fixed artifact paths',
  { timeout: 60_000 },
  () => {
    for (const name of ['mutation-report.json', '.stryker-last-run.config.mjs'])
      rmSync(join(artifactsDir, name), { force: true });
    const dir = fixtureProject({
      'package.json': '{ "name": "fixture", "private": true, "type": "module" }\n',
      'src/calc.js': 'export const add = (a, b) => a + b;\n',
      'tests/calc.test.js':
        "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/calc.js';\ntest('add', () => assert.equal(add(1, 2), 3));\n",
    });
    try {
      // --timeout-sec 1 kills Stryker mid-run: even a run that dies early must not leave or
      // reuse artifacts at the fixed paths.
      const result = run('mutation.mjs', [
        '--cwd',
        dir,
        '--scope',
        'src/**',
        '--tests',
        'tests/*.test.js',
        '--timeout-sec',
        '1',
      ]);
      assert.notEqual(result.status, 0, 'a killed run must not produce a score');
      for (const name of ['mutation-report.json', '.stryker-last-run.config.mjs'])
        assert.equal(
          existsSync(join(artifactsDir, name)),
          false,
          `${name} was written to the fixed artifact path`,
        );
      const leftovers = existsSync(artifactsDir)
        ? readdirSync(artifactsDir).filter(name => name.startsWith('mutation-'))
        : [];
      assert.deepEqual(leftovers, [], 'per-run dirs were left behind');
    } finally {
      removeFixture(dir);
    }
  },
);
