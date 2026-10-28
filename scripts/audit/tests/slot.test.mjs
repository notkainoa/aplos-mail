import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    scripts: {
      'check:tokens': 'node -e "process.exit(3)"',
      'test:visual': 'node -e "console.log(\'ran\')"',
    },
  }),
);
after(() => rmSync(root, { recursive: true, force: true }));

const run = (name, env = {}) =>
  spawnSync(process.execPath, [slot, name, '--root', root], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_STEP_SUMMARY: '', ...env },
  });

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

  it('exits 2 for an unknown or misspelled slot, even when the script exists', () => {
    for (const name of ['check:tokns', 'constructor', '__proto__', 'check:openapi; echo hi']) {
      const result = run(name);
      assert.equal(result.status, 2, name);
      assert.match(result.stderr, /unknown slot/);
      assert.doesNotMatch(result.stdout, /pending/);
    }
  });

  it('appends the pending line to GITHUB_STEP_SUMMARY when it is set', () => {
    const summary = join(root, 'summary.md');
    const result = run('check:contrast', { GITHUB_STEP_SUMMARY: summary });
    assert.equal(result.status, 0);
    assert.equal(
      readFileSync(summary, 'utf8'),
      '- pending: check:contrast (owner: ui-foundation)\n',
    );
  });

  it('exits 2 without a name', () => {
    const result = spawnSync(process.execPath, [slot, '--root', root], { encoding: 'utf8' });
    assert.equal(result.status, 2);
  });
});
