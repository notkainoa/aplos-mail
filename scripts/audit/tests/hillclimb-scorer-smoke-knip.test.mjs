// Real smoke run of the knip scorer on a tiny fixture project (~3 s): an unused file must cost
// 3 points under the file-weight rule.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureProject, lastJson, removeFixture, run } from './hillclimb-fixture.mjs';

test('smoke: knip scores a fixture project end-to-end', { timeout: 60_000 }, () => {
  const dir = fixtureProject({
    'knip.json': JSON.stringify({ entry: ['src/index.js'], project: ['src/**/*.js'] }),
    'src/index.js': "import { used } from './used.js';\nexport const main = used;\n",
    'src/used.js': 'export const used = 1;\n',
    'src/dead.js': 'export const dead = 2;\n',
  });
  try {
    const result = run('knip.mjs', ['--cwd', dir]);
    assert.equal(result.status, 0, result.stderr);
    const json = lastJson(result);
    assert.equal(typeof json.score, 'number');
    assert.ok(json.score <= -3, `expected dead.js to cost 3, got ${json.score}`);
  } finally {
    removeFixture(dir);
  }
});
