import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkBudgets } from '../check-budgets.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const now = new Date('2026-10-27T12:00:00Z');
const row = (overrides = {}) => ({
  id: 'ui.example',
  owner: 'ui-foundation',
  environment: 'packaged build',
  gate: 'hard-3x',
  calibration: 'set',
  value: 8,
  unit: 'ms',
  maxAgeDays: 30,
  lastMeasured: '2026-10-20',
  ...overrides,
});
const check = (...rows) => checkBudgets({ rows }, now);

describe('check-budgets', () => {
  it('is green for a fresh measurement', () => {
    const { errors, awaiting } = check(row());
    assert.deepEqual(errors, []);
    assert.deepEqual(awaiting, []);
  });

  it('is red when the owner is missing', () => {
    const { errors } = check(row({ owner: undefined }));
    assert.deepEqual(errors, ['ui.example: missing owner']);
  });

  it('is red when the environment or gate is missing, or the gate is unknown', () => {
    assert.match(check(row({ environment: '' })).errors[0], /missing environment/);
    assert.match(check(row({ gate: undefined })).errors[0], /missing gate/);
    assert.match(check(row({ gate: 'whenever' })).errors[0], /unknown gate/);
  });

  it('is red when a measurement is older than maxAgeDays', () => {
    const { errors } = check(row({ lastMeasured: '2026-08-01', maxAgeDays: 30 }));
    assert.equal(errors.length, 1);
    assert.match(errors[0], /stale/);
  });

  it('is red for a duplicate id', () => {
    assert.match(check(row(), row()).errors[0], /duplicate id/);
  });

  it('is red for a measured row without maxAgeDays', () => {
    assert.match(check(row({ maxAgeDays: null })).errors[0], /maxAgeDays/);
  });

  it('reports a never-measured row as awaiting first measurement, not as a failure', () => {
    const { errors, awaiting } = check(
      row({ calibration: 'calibrate', lastMeasured: null, maxAgeDays: null }),
    );
    assert.deepEqual(errors, []);
    assert.match(awaiting[0], /awaiting first measurement/);
  });

  it('needs a source when the value is null', () => {
    assert.match(check(row({ value: null, unit: null })).errors[0], /source/);
    assert.deepEqual(
      check(row({ value: null, unit: null, source: 'plans/40 Q3', lastMeasured: null })).errors,
      [],
    );
  });

  it('accepts the committed budgets.json; the CLI exits non-zero when an owner is deleted', () => {
    const file = join(here, '..', '..', '..', 'budgets.json');
    const register = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(checkBudgets(register, now).errors, []);
    assert.ok(register.rows.length >= 30);
    const script = join(here, '..', 'check-budgets.mjs');
    assert.equal(spawnSync(process.execPath, [script, file]).status, 0);

    const dir = mkdtempSync(join(tmpdir(), 'aplos-budgets-test-'));
    try {
      delete register.rows[0].owner;
      const broken = join(dir, 'budgets.json');
      writeFileSync(broken, JSON.stringify(register));
      const result = spawnSync(process.execPath, [script, broken], { encoding: 'utf8' });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /missing owner/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
