// CLI contract tests for the hill-climb scorers (roadmap 5.1c): --scope required for mutation
// and a non-zero exit with exactly one stderr line on a bad argument. These spawn the scorer
// with arguments that fail before any heavy tool runs, so the file stays fast.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { run } from './hillclimb-fixture.mjs';

for (const scorer of ['coverage.mjs', 'mutation.mjs', 'knip.mjs', 'depcruise.mjs']) {
  test(`${scorer}: a bad argument exits non-zero with exactly one stderr line`, () => {
    const result = run(scorer, ['--bogus-arg']);
    assert.notEqual(result.status, 0);
    const stderrLines = result.stderr.trim().split('\n').filter(Boolean);
    assert.equal(stderrLines.length, 1);
    assert.match(stderrLines[0], /bogus-arg/);
  });
}

test('mutation.mjs: --scope is required', () => {
  const result = run('mutation.mjs', ['--tests', 'packages/engine/tests/**/*.test.ts']);
  assert.notEqual(result.status, 0);
  const stderrLines = result.stderr.trim().split('\n').filter(Boolean);
  assert.equal(stderrLines.length, 1);
  assert.match(stderrLines[0], /--scope/);
});
