import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const slot = join(dirname(fileURLToPath(import.meta.url)), '..', 'slot.mjs');
const root = mkdtempSync(join(tmpdir(), 'aplos-slot-test-'));
writeFileSync(
  join(root, 'package.json'),
  JSON.stringify({
    name: 'fixture',
    scripts: { 'check:tokens': 'node -e "process.exit(3)"', 'test:visual': 'node -e "console.log(\'ran\')"' },
  }),
);
after(() => rmSync(root, { recursive: true, force: true }));

const run = name => spawnSync(process.execPath, [slot, name, '--root', root], { encoding: 'utf8' });

describe('slot.mjs', () => {
  it('propagates a failing script as a non-zero exit', () => {
    const result = run('check:tokens');
    assert.equal(result.status, 3);
  });

  it('runs a passing script and exits 0', () => {
    const result = run('test:visual');
    assert.equal(result.status, 0);
    assert.match(result.stdout, /ran/);
  });

  it('reports a missing script as pending with its owner and exits 0', () => {
    const result = run('check:openapi');
    assert.equal(result.status, 0);
    assert.match(result.stdout, /pending: check:openapi \(owner: eng-contract \/ eng-host\)/);
  });

  it('names an unknown missing script as unassigned', () => {
    const result = run('check:nothing');
    assert.equal(result.status, 0);
    assert.match(result.stdout, /pending: check:nothing \(owner: unassigned\)/);
  });

  it('exits 2 without a name', () => {
    const result = spawnSync(process.execPath, [slot, '--root', root], { encoding: 'utf8' });
    assert.equal(result.status, 2);
  });
});
