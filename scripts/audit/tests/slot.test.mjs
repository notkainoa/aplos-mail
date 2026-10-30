import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runSlot } from '../slot.mjs';

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

// APLOS_SCRATCH_SWEEP=0 keeps spawned slot runs from reporting on the real tmpdir; the report
// itself is covered below through runSlot's injected sweep option.
const run = (name, env = {}) =>
  spawnSync(process.execPath, [slot, name, '--root', root], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_STEP_SUMMARY: '', APLOS_SCRATCH_SWEEP: '0', ...env },
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

describe('slot scratch sweep', () => {
  const captured = fn => {
    const lines = [];
    const original = console.log;
    console.log = line => lines.push(line);
    try {
      return { status: fn(), lines };
    } finally {
      console.log = original;
    }
  };
  const fakeSweep = outcome => {
    const calls = [];
    const sweep = options => {
      calls.push(options);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    };
    return { calls, sweep };
  };

  it('reports stale dirs once, never asks the sweep to delete, prints at most one line', () => {
    const { calls, sweep } = fakeSweep({
      removed: ['/tmp/aplos-scratch-a-abc123'],
      kept: 2,
      failed: [],
      bytesFreedApprox: 5e6,
    });
    const { status, lines } = captured(() => runSlot('test:visual', root, '', { sweep, env: {} }));
    assert.equal(status, 0);
    assert.equal(calls.length, 1);
    assert.notEqual(calls[0]?.delete, true, 'slot must never request deletion');
    assert.deepEqual(lines, [
      'scratch: 1 stale scratch dir(s) (~4.8 MB); run npm run scratch:sweep -- --delete',
    ]);
  });

  it('prints nothing when the report found no stale dirs', () => {
    const { sweep } = fakeSweep({ removed: [], kept: 3, failed: [], bytesFreedApprox: 0 });
    const { status, lines } = captured(() => runSlot('test:visual', root, '', { sweep, env: {} }));
    assert.equal(status, 0);
    assert.deepEqual(lines, []);
  });

  it('skips the report on APLOS_SCRATCH_SWEEP=0 and on GITHUB_ACTIONS', () => {
    for (const env of [{ APLOS_SCRATCH_SWEEP: '0' }, { GITHUB_ACTIONS: 'true' }]) {
      const { calls, sweep } = fakeSweep({ removed: ['/x'], kept: 0, bytesFreedApprox: 1 });
      const { status } = captured(() => runSlot('test:visual', root, '', { sweep, env }));
      assert.equal(status, 0);
      assert.equal(calls.length, 0, JSON.stringify(env));
    }
  });

  it('never lets a report failure fail the slot', () => {
    const { sweep } = fakeSweep(new Error('tmpdir exploded'));
    const { status } = captured(() => runSlot('test:visual', root, '', { sweep, env: {} }));
    assert.equal(status, 0);
  });

  it('does not report for pending or unknown slots', () => {
    const { calls, sweep } = fakeSweep({ removed: ['/x'], kept: 0, bytesFreedApprox: 1 });
    captured(() => runSlot('check:openapi', root, '', { sweep, env: {} }));
    runSlot('typo', root, '', { sweep, env: {} });
    assert.equal(calls.length, 0);
  });
});
