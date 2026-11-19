// Real smoke run of the mutation scorer on a tiny fixture project. Stryker's sandbox copy plus
// per-mutant test runs take minutes rather than seconds, so this one is gated behind
// HILLCLIMB_SLOW=1 and run manually to prove the path works.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SLOW, fixtureProject, lastJson, removeFixture, run } from './hillclimb-fixture.mjs';

test(
  'smoke: mutation scores a fixture project end-to-end (HILLCLIMB_SLOW=1)',
  { timeout: 300_000, skip: !SLOW && 'set HILLCLIMB_SLOW=1 to run the slow Stryker smoke' },
  () => {
    const dir = fixtureProject({
      'package.json': '{ "name": "fixture", "private": true, "type": "module" }\n',
      'src/calc.js': 'export const add = (a, b) => a + b;\nexport const isZero = x => x === 0;\n',
      'tests/calc.test.js':
        "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add, isZero } from '../src/calc.js';\ntest('add', () => assert.equal(add(1, 2), 3));\ntest('isZero', () => { assert.equal(isZero(0), true); assert.equal(isZero(1), false); });\n",
    });
    try {
      const result = run('mutation.mjs', [
        '--cwd',
        dir,
        '--scope',
        'src/**',
        '--tests',
        'tests/*.test.js',
        '--max-mutants',
        '30',
        '--timeout-sec',
        '240',
      ]);
      assert.equal(result.status, 0, result.stderr);
      const json = lastJson(result);
      assert.equal(typeof json.score, 'number');
      assert.ok(json.score >= 0 && json.score <= 100);
    } finally {
      removeFixture(dir);
    }
  },
);
