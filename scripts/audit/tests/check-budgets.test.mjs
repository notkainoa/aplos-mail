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
  dueBy: '2026-11-06',
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

  it('is red when a never-measured row is past its dueBy date, and green before it', () => {
    const unmeasured = { lastMeasured: null, maxAgeDays: null, calibration: 'calibrate' };
    assert.match(check(row({ ...unmeasured, dueBy: '2026-10-26' })).errors[0], /overdue/);
    const today = check(row({ ...unmeasured, dueBy: '2026-10-27' }));
    assert.deepEqual(today.errors, []);
    assert.match(today.awaiting[0], /due by 2026-10-27/);
    assert.match(check(row({ dueBy: undefined })).errors[0], /dueBy/);
  });

  it('is red for a value that is not a non-negative number', () => {
    assert.match(check(row({ value: 'fast' })).errors[0], /must be a number/);
    assert.match(check(row({ value: -5 })).errors[0], /must be a number/);
    assert.match(check(row({ value: Number.NaN })).errors[0], /must be a number/);
    assert.deepEqual(check(row({ value: 0, unit: 'refusals' })).errors, []);
  });

  it('is red for ids that differ only in case or whitespace, and for a malformed id', () => {
    assert.match(check(row(), row({ id: 'UI.example' })).errors.join(), /id must be/);
    assert.match(check(row({ id: 'ui.example ' })).errors[0], /id must be/);
    assert.match(check(row(), row({ id: 'ui.example' })).errors[0], /duplicate id/);
  });

  it('accepts the release gate and checks alertPct', () => {
    assert.deepEqual(check(row({ gate: 'release' })).errors, []);
    assert.deepEqual(check(row({ alertPct: 10 })).errors, []);
    assert.match(check(row({ alertPct: -1 })).errors[0], /alertPct/);
  });

  it('needs a source when the value is null', () => {
    assert.match(check(row({ value: null, unit: null })).errors[0], /source/);
    assert.deepEqual(
      check(
        row({
          value: null,
          unit: null,
          source: 'plans/40 Q3',
          lastMeasured: null,
          maxAgeDays: null,
        }),
      ).errors,
      [],
    );
  });

  it('accepts the committed budgets.json; the CLI exits non-zero when an owner is deleted', () => {
    const file = join(here, '..', '..', '..', 'budgets.json');
    const register = JSON.parse(readFileSync(file, 'utf8'));
    // A recorded measurement may postdate the fixed `now`, so check as of the latest one.
    const measured = register.rows.map(r => new Date(r.lastMeasured ?? 0));
    const asOf = new Date(Math.max(now, ...measured));
    assert.deepEqual(checkBudgets(register, asOf).errors, []);
    for (const id of [
      'views.window-rerun',
      'sanitizer.p99',
      'ui.home-100k-first-rows',
      'sync.archive-2000-units',
    ]) {
      assert.ok(
        register.rows.some(r => r.id === id),
        `${id} is in the register`,
      );
    }
    assert.ok(register.rows.length >= 50);
    const script = join(here, '..', 'check-budgets.mjs');
    assert.equal(
      spawnSync(process.execPath, [script, file, '--now', asOf.toISOString().slice(0, 10)]).status,
      0,
    );
    assert.equal(
      spawnSync(process.execPath, [script, file, '--now', '2027-01-01']).status,
      1,
      'overdue rows fail',
    );

    const dir = mkdtempSync(join(tmpdir(), 'aplos-budgets-test-'));
    try {
      delete register.rows[0].owner;
      const broken = join(dir, 'budgets.json');
      writeFileSync(broken, JSON.stringify(register));
      const result = spawnSync(process.execPath, [script, broken, '--now', '2026-10-27'], {
        encoding: 'utf8',
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /missing owner/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
