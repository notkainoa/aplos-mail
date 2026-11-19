import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { collectTestFiles, findNonCompliant, run } from '../check-scratch.mjs';
import { scratchDir } from '../scratch.mjs';

const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'check-scratch.mjs');

const write = (root, file, text) => {
  const path = join(root, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

const leakyMkdtemp =
  "import { mkdtempSync } from 'node:fs';\n" +
  "import { tmpdir } from 'node:os';\n" +
  "const dir = mkdtempSync(join(tmpdir(), 'aplos-leak-'));\n";
const cleanMkdtemp = leakyMkdtemp + 'after(() => rmSync(dir, { recursive: true }));\n';
const helperUse =
  "import { scratchDir } from '../../../scripts/audit/scratch.mjs';\n" +
  'const dir = scratchDir();\n';
const leakyMkdir = "mkdirSync(join(os.tmpdir(), 'aplos-leak'), { recursive: true });\n";
const noScratch = "console.log('no tmp here');\n";

const fixture = () => {
  const root = scratchDir('check-scratch-fix');
  write(root, 'apps/desktop/tests/helper.test.ts', helperUse);
  write(root, 'apps/desktop/tests/manual.test.ts', cleanMkdtemp);
  write(root, 'apps/desktop/tests/leaky.test.ts', leakyMkdtemp);
  write(root, 'apps/desktop/src/util/leaky-src.test.ts', leakyMkdtemp);
  write(root, 'packages/engine/tests/leaky-mkdir.test.ts', leakyMkdir);
  write(root, 'tests/e2e/plain.ts', noScratch);
  write(root, 'scripts/tools/leaky-script.test.mjs', leakyMkdtemp);
  return root;
};

describe('check-scratch.mjs', () => {
  it('finds only the test files that create scratch dirs without cleanup', () => {
    const root = fixture();
    assert.deepEqual(findNonCompliant(root), [
      'apps/desktop/src/util/leaky-src.test.ts',
      'apps/desktop/tests/leaky.test.ts',
      'packages/engine/tests/leaky-mkdir.test.ts',
      'scripts/tools/leaky-script.test.mjs',
    ]);
  });

  it('collects test files from every scanned root and skips node_modules', () => {
    const root = fixture();
    write(root, 'apps/desktop/tests/node_modules/pkg/leaky.test.ts', leakyMkdtemp);
    const files = collectTestFiles(root);
    assert.ok(files.includes('apps/desktop/tests/helper.test.ts'));
    assert.ok(files.includes('apps/desktop/src/util/leaky-src.test.ts'));
    assert.ok(files.includes('packages/engine/tests/leaky-mkdir.test.ts'));
    assert.ok(files.includes('tests/e2e/plain.ts'));
    assert.ok(files.includes('scripts/tools/leaky-script.test.mjs'));
    assert.equal(
      files.some(f => f.includes('node_modules')),
      false,
    );
  });

  it('report mode exits 0 and strict mode only fails files outside the baseline', () => {
    const root = fixture();
    assert.equal(run(root), 0);
    const baselineDir = join(root, 'scripts', 'audit');
    mkdirSync(baselineDir, { recursive: true });
    const baseline = join(baselineDir, 'scratch-baseline.json');
    writeFileSync(
      baseline,
      JSON.stringify([
        'apps/desktop/src/util/leaky-src.test.ts',
        'apps/desktop/tests/leaky.test.ts',
        'packages/engine/tests/leaky-mkdir.test.ts',
      ]),
    );
    assert.equal(run(root, { strict: true }), 1); // leaky-script.test.mjs is new
    assert.equal(run(root, { updateBaseline: true }), 0);
    assert.deepEqual(JSON.parse(readFileSync(baseline, 'utf8')), findNonCompliant(root));
    assert.equal(run(root, { strict: true }), 0);
  });

  it('runs on the real repo: report mode prints the summary and exits 0', () => {
    const result = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /check:scratch: \d+ file\(s\) create scratch dirs without cleanup/);
  });
});
