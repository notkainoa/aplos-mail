// Real smoke run of the depcruise scorer on a tiny fixture project (~2 s): one 2-node cycle is
// one circular edge at weight 2.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureProject, lastJson, removeFixture, run } from './hillclimb-fixture.mjs';

test('smoke: depcruise scores a fixture project end-to-end', { timeout: 60_000 }, () => {
  const dir = fixtureProject({
    '.dependency-cruiser.cjs': `module.exports = {
      forbidden: [
        { name: 'no-cycles', severity: 'error', from: {}, to: { circular: true } },
      ],
      options: { tsPreCompilationDeps: false },
    };\n`,
    'src/a.js': "import './b.js';\nexport const a = 1;\n",
    'src/b.js': "import './a.js';\nexport const b = 2;\n",
  });
  try {
    const result = run('depcruise.mjs', ['--cwd', dir, '--scope', 'src/**']);
    assert.equal(result.status, 0, result.stderr);
    const json = lastJson(result);
    assert.equal(json.score, -2);
    // The last detail line reports the measured run time; the rest are findings.
    assert.match(json.details.at(-1), /^depcruise ran \d+\.\d s$/);
    assert.ok(
      json.details.slice(0, -1).every(line => / -> .* \(no-cycles\)$/.test(line)),
      json.details.join(', '),
    );
  } finally {
    removeFixture(dir);
  }
});
