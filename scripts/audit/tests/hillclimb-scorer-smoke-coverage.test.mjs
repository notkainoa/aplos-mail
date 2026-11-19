// Real smoke run of the coverage scorer on a tiny fixture project (~15 s, mostly tsx's cold
// load): one uncovered line inside the uncalled function must drop the score below 100.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureProject, lastJson, removeFixture, run } from './hillclimb-fixture.mjs';

test('smoke: coverage scores a fixture project end-to-end', { timeout: 60_000 }, () => {
  const dir = fixtureProject({
    'src/calc.js':
      'export const add = (a, b) => a + b;\nexport const sub = (a, b) => {\n  const diff = a - b;\n  return diff;\n};\n',
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
    const json = lastJson(result);
    assert.equal(typeof json.score, 'number');
    assert.ok(json.score > 0 && json.score < 100, `partial coverage expected, got ${json.score}`);
  } finally {
    removeFixture(dir);
  }
});
