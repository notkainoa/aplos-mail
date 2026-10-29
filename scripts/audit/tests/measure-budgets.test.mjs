import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  applyRecords,
  billedMinutes,
  ciJobNames,
  compare,
  directoryBytes,
  findEntries,
  jobMinutes,
  maxJobMinutes,
  measureRows,
  newestMinutes,
  createdSince,
  ciUnreadableReason,
  measurers,
  parseArgs,
  serialise,
} from '../measure-budgets.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, '..', 'measure-budgets.mjs');
const temps = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'measure-budgets-'));
  temps.push(dir);
  return dir;
};
after(() => temps.forEach(dir => rmSync(dir, { recursive: true, force: true })));

const row = (overrides = {}) => ({
  id: 'size.example',
  owner: 'plat-ci',
  environment: 'every merge',
  gate: 'tighten-only',
  calibration: 'set',
  value: 100,
  unit: 'bytes',
  dueBy: '2026-11-07',
  maxAgeDays: null,
  lastMeasured: null,
  ...overrides,
});
const other = { ...row({ id: 'ui.other', owner: 'ui-foundation', gate: 'hard-3x', value: 8 }) };

describe('measure-budgets sizing', () => {
  it('sums files at any depth and filters by extension', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'assets', 'deep'), { recursive: true });
    writeFileSync(join(dir, 'index.html'), 'x'.repeat(10));
    writeFileSync(join(dir, 'assets', 'app.js'), 'x'.repeat(100));
    writeFileSync(join(dir, 'assets', 'deep', 'app.css'), 'x'.repeat(20));
    assert.equal(directoryBytes(dir), 130);
    assert.equal(directoryBytes(dir, ['.js', '.css']), 120);
    assert.equal(directoryBytes(join(dir, 'missing')), 0);
  });

  it('finds .app directories without descending into them', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'mac-arm64', 'Aplos Mail.app', 'Contents', 'Nested.app'), {
      recursive: true,
    });
    assert.deepEqual(findEntries(dir, '.app'), [join(dir, 'mac-arm64', 'Aplos Mail.app')]);
  });
});

describe('measure-budgets compare and ratchet', () => {
  it('fails above the limit and allows alertPct on top of it', () => {
    assert.equal(compare(row(), 100), 'ok');
    assert.equal(compare(row(), 101), 'FAIL');
    assert.equal(compare(row({ alertPct: 10 }), 110), 'ok');
    assert.equal(compare(row({ alertPct: 10 }), 111), 'FAIL');
    assert.equal(compare(row({ value: null, calibration: 'calibrate' }), 5e9), 'ok');
  });

  it('sets a calibrate row from its first measurement and fills the unit and maxAgeDays', () => {
    const empty = row({ calibration: 'calibrate', value: null, unit: null });
    const { rows } = applyRecords(
      { rows: [empty] },
      { 'size.example': { measured: 42, unit: 'bytes' } },
      '2026-10-28',
    );
    assert.equal(rows[0].value, 42);
    assert.equal(rows[0].unit, 'bytes');
    assert.equal(rows[0].lastMeasured, '2026-10-28');
    assert.equal(rows[0].maxAgeDays, 30);
  });

  it('lowers a tighten-only value only with --tighten, and never raises it', () => {
    const result = measured => ({ 'size.example': { measured, unit: 'bytes' } });
    const record = (measured, options) =>
      applyRecords({ rows: [row()] }, result(measured), '2026-10-28', options).rows[0];
    assert.equal(record(60, {}).value, 100);
    assert.equal(record(60, { tighten: true }).value, 60);
    assert.equal(record(150, { tighten: true }).value, 100);
    assert.equal(record(60, {}).lastMeasured, '2026-10-28');
  });
});

describe('measure-budgets record', () => {
  it('changes only measured plat-ci rows and keeps the file formatting', () => {
    const register = {
      $comment: 'c',
      version: 2,
      rows: [row(), row({ id: 'size.unmeasured' }), other],
    };
    const text = serialise(register);
    assert.equal(serialise(JSON.parse(text)), text, 'round-trips byte for byte');
    const results = {
      'size.example': { measured: 10, unit: 'bytes' },
      'ui.other': { measured: 1, unit: 'ms' },
    };
    const next = applyRecords(JSON.parse(text), results, '2026-10-28', { tighten: true });
    assert.deepEqual(next.rows[1], register.rows[1], 'an unmeasured plat-ci row is untouched');
    assert.deepEqual(
      next.rows[2],
      other,
      "another lane's row is untouched even if a result names it",
    );
    assert.equal(next.rows[0].value, 10);
    assert.equal(next.$comment, 'c');
    const changed = { ...next.rows[0], value: 100, lastMeasured: null, maxAgeDays: null };
    assert.deepEqual(changed, register.rows[0], 'only value, lastMeasured and maxAgeDays moved');
  });

  it('keeps the real budgets.json in its serialised form', () => {
    const text = readFileSync(join(here, '..', '..', '..', 'budgets.json'), 'utf8');
    assert.equal(serialise(JSON.parse(text)), text);
  });
});

describe('measure-budgets run', () => {
  it('skips rows whose artifact is absent instead of failing', async () => {
    const root = tempDir();
    const register = {
      rows: [
        row({ id: 'size.renderer-bundle' }),
        row({ id: 'size.app-bundle' }),
        row({ id: 'size.app-zip' }),
        row({ id: 'time.unit-suite' }),
        other,
      ],
    };
    const outcomes = await measureRows(register, root);
    assert.equal(outcomes.length, 4, 'only plat-ci rows with a measurer');
    for (const { result } of outcomes) assert.match(result.skip, /\S/);
  });

  it('measures the renderer build output and honours --only', async () => {
    const root = tempDir();
    const dist = join(root, 'apps', 'desktop', 'dist', 'renderer');
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, 'a.js'), 'x'.repeat(30));
    writeFileSync(join(dist, 'a.png'), 'x'.repeat(500));
    const register = {
      rows: [
        row({ id: 'size.renderer-bundle', value: null, calibration: 'calibrate' }),
        row({ id: 'size.app-zip' }),
      ],
    };
    const outcomes = await measureRows(register, root, { only: ['size.renderer-bundle'] });
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].result.measured, 30);
  });

  it('parses its flags and rejects unknown ones', () => {
    assert.deepEqual(parseArgs(['--record', '--tighten', '--only', 'a,b']), {
      record: true,
      tighten: true,
      timeUnitSuite: false,
      ci: false,
      only: ['a', 'b'],
    });
    assert.equal(parseArgs(['--ci']).ci, true);
    assert.throws(() => parseArgs(['--nope']), /unknown argument/);
  });

  it('exits 0 and prints skipped lines from the command line when nothing is built', () => {
    const run = spawnSync(process.execPath, [script, '--only', 'time.unit-suite'], {
      encoding: 'utf8',
    });
    assert.equal(run.status, 0);
    assert.match(run.stdout, /time\.unit-suite\s+skipped\s+not measurable here/);
  });
});

// A job of a `gh run view --json jobs` payload: `seconds` of wall-clock on a fixed start.
const ciJob = (name, seconds, conclusion = 'success') => ({
  name,
  status: 'completed',
  conclusion,
  startedAt: '2026-10-28T10:00:00Z',
  completedAt: new Date(Date.parse('2026-10-28T10:00:00Z') + seconds * 1000).toISOString(),
});

describe('measure-budgets CI rows', () => {
  it('times a job that ran and treats a skipped job as not run', () => {
    assert.equal(jobMinutes(ciJob('Unit tests', 90)), 1.5);
    assert.equal(jobMinutes(ciJob(ciJobNames.macosJob, 0, 'skipped')), null);
    assert.equal(jobMinutes({ name: 'no timestamps' }), null);
  });

  it('measures the longer of the named jobs, or nothing when none ran', () => {
    const jobs = [
      ciJob(ciJobNames.staticJob, 140),
      ciJob(ciJobNames.unitJob, 382),
      ciJob(ciJobNames.e2eBrowserJob, 67),
      ciJob(ciJobNames.macosJob, 0, 'skipped'),
    ];
    const staticUnit = [ciJobNames.staticJob, ciJobNames.unitJob];
    assert.equal(maxJobMinutes(jobs, staticUnit), 382 / 60);
    assert.equal(maxJobMinutes(jobs, [ciJobNames.macosJob]), null);
    assert.equal(maxJobMinutes([], staticUnit), null);
  });

  it('bills each job rounded up to whole minutes, macOS at 10x', () => {
    const jobs = [
      ciJob('Detect changes', 8), // 1
      ciJob(ciJobNames.staticJob, 136), // 3
      ciJob(ciJobNames.macosJob, 72), // 2 * 10
      ciJob('Website (typecheck, build)', 0, 'skipped'), // never ran
    ];
    assert.equal(billedMinutes(jobs), 24);
  });

  it('measures ci.* rows from injected run data and skips without --ci or gh', async () => {
    const run = [
      ciJob(ciJobNames.staticJob, 140),
      ciJob(ciJobNames.unitJob, 382),
      ciJob(ciJobNames.e2eBrowserJob, 67),
      ciJob(ciJobNames.macosJob, 0, 'skipped'),
    ];
    const options = { ci: true, ciRuns: [run, run] };
    const staticUnit = await measurers['ci.wall-clock-static-unit'](null, options);
    assert.equal(staticUnit.unit, 'min');
    assert.equal(staticUnit.measured, 6.4);
    const e2e = await measurers['ci.wall-clock-e2e-browser'](null, options);
    assert.equal(e2e.measured, 1.2);
    const macos = await measurers['ci.wall-clock-macos'](null, options);
    assert.equal(macos.skip, 'no completed macOS run in the last 30 days');
    const billed = await measurers['ci.billed-minutes'](null, options);
    assert.equal(billed.unit, 'minutes');
    assert.equal(billed.measured, 2 * billedMinutes(run));
    const off = await measurers['ci.billed-minutes'](null, {});
    assert.match(off.skip, /--ci/);
    const noRuns = await measurers['ci.billed-minutes'](null, { ci: true, ciRuns: [] });
    assert.equal(noRuns.skip, ciUnreadableReason);
  });

  it('wall-clock rows scan newest-first for the first run where the named jobs ran', async () => {
    const newest = [
      ciJob(ciJobNames.staticJob, 100),
      ciJob(ciJobNames.e2eBrowserJob, 0, 'skipped'),
    ];
    const older = [ciJob(ciJobNames.staticJob, 200), ciJob(ciJobNames.e2eBrowserJob, 90)];
    assert.equal(newestMinutes([newest, older], [ciJobNames.e2eBrowserJob]), 1.5);
    assert.equal(newestMinutes([newest, older], [ciJobNames.staticJob]), 100 / 60);
    assert.equal(newestMinutes([newest, older], [ciJobNames.macosJob]), null);
    const e2e = await measurers['ci.wall-clock-e2e-browser'](null, {
      ci: true,
      ciRuns: [newest, older],
    });
    assert.equal(e2e.measured, 1.5);
  });

  it('createdSince is the date of the start of the window', () => {
    assert.equal(createdSince(new Date('2026-10-29T12:00:00Z'), 30), '>=2026-09-29');
  });
});
