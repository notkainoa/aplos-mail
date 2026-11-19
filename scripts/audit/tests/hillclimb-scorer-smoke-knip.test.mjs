// Real smoke run of the knip scorer on a tiny fixture project (~3 s): an unused file must cost
// 3 points under the file-weight rule. The scorer runs knip --production by default, so the
// fixture marks its production patterns with `!`; an export only a test imports is dead
// production code until --include-tests counts the test as a user.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureProject, lastJson, removeFixture, run } from './hillclimb-fixture.mjs';

const fixture = () =>
  fixtureProject({
    'knip.json': JSON.stringify({
      entry: ['src/index.js!', 'tests/**/*.test.js'],
      project: ['src/**/*.js!', 'tests/**/*.js'],
    }),
    'src/index.js': "import { used } from './used.js';\nexport const main = used;\n",
    'src/used.js': 'export const used = 1;\n',
    'src/dead.js': 'export const dead = 2;\n',
    'src/testonly.js': 'export const testonly = 2;\n',
    'tests/x.test.js': "import { testonly } from '../src/testonly.js';\nconsole.log(testonly);\n",
  });

test('smoke: knip scores a fixture project end-to-end', { timeout: 60_000 }, () => {
  const dir = fixture();
  try {
    const result = run('knip.mjs', ['--cwd', dir]);
    assert.equal(result.status, 0, result.stderr);
    const json = lastJson(result);
    // Production scoring: dead.js and testonly.js are unused files at weight 3 each.
    assert.equal(json.score, -6);
    assert.deepEqual(json.details, [
      'src/dead.js: 1 unused file (weight 3)',
      'src/testonly.js: 1 unused file (weight 3)',
    ]);
  } finally {
    removeFixture(dir);
  }
});

test(
  'smoke: knip --include-tests counts a test file as a user of an export',
  { timeout: 60_000 },
  () => {
    const dir = fixture();
    try {
      const result = run('knip.mjs', ['--cwd', dir, '--include-tests']);
      assert.equal(result.status, 0, result.stderr);
      const json = lastJson(result);
      // Test-inclusive scoring: testonly.js is used by tests/x.test.js, only dead.js counts.
      assert.equal(json.score, -3);
      assert.deepEqual(json.details, ['src/dead.js: 1 unused file (weight 3)']);
    } finally {
      removeFixture(dir);
    }
  },
);
