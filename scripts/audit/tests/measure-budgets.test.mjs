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
  medianMinutes,
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
    const ok = jobs => ({ conclusion: 'success', jobs });
    const options = { ci: true, ciRuns: [ok(run), ok(run)], ciComplete: true };
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
    const ok = jobs => ({ conclusion: 'success', jobs });
    const newest = ok([
      ciJob(ciJobNames.staticJob, 100),
      ciJob(ciJobNames.e2eBrowserJob, 0, 'skipped'),
    ]);
    const older = ok([ciJob(ciJobNames.staticJob, 200), ciJob(ciJobNames.e2eBrowserJob, 90)]);
    assert.equal(
      newestMinutes([newest, older], name => name === ciJobNames.e2eBrowserJob),
      1.5,
    );
    assert.equal(
      newestMinutes([newest, older], name => name === ciJobNames.staticJob),
      100 / 60,
    );
    assert.equal(
      newestMinutes([newest, older], name => name === ciJobNames.macosJob),
      null,
    );
    const e2e = await measurers['ci.wall-clock-e2e-browser'](null, {
      ci: true,
      ciRuns: [newest, older],
    });
    assert.equal(e2e.measured, 1.5);
  });

  it('static-unit takes the longest of the static job and every "Unit tests (...)" job', async () => {
    const run = {
      conclusion: 'success',
      jobs: [
        ciJob(ciJobNames.staticJob, 110),
        ciJob('Unit tests (engine, Electron Node)', 151),
        ciJob('Unit tests (desktop 1/2)', 139),
        ciJob('Website (typecheck, build)', 400),
      ],
    };
    const result = await measurers['ci.wall-clock-static-unit'](null, { ci: true, ciRuns: [run] });
    assert.equal(result.measured, 2.6);
  });

  it('static-unit is the median of the newest five green runs, leaving out web-only runs', async () => {
    const unitName = 'Unit tests (desktop 1/2)';
    const run = seconds => ({
      conclusion: 'success',
      jobs: [ciJob(ciJobNames.staticJob, seconds), ciJob(unitName, seconds - 20)],
    });
    // A web-only run: Static ran, the unit jobs were skipped (zero length).
    const webOnly = seconds => ({
      conclusion: 'success',
      jobs: [ciJob(ciJobNames.staticJob, seconds), ciJob(unitName, 0, 'skipped')],
    });
    const failed = { conclusion: 'failure', jobs: [ciJob(ciJobNames.staticJob, 900)] };
    const runs = [
      run(300),
      failed,
      webOnly(60),
      run(200),
      run(210),
      webOnly(50),
      run(230),
      run(240),
      run(900),
    ];
    const isStaticUnit = name => name === ciJobNames.staticJob || name === unitName;
    const isUnit = name => name === unitName;
    // newest five green desktop runs: 300, 200, 210, 230, 240 s -> median 230 s; web-only and failed runs
    // and the 900 s sixth run do not count.
    assert.equal(medianMinutes(runs, isStaticUnit, 5, isUnit), 230 / 60);
    assert.equal(medianMinutes(runs, isStaticUnit, 2, isUnit), 250 / 60);
    assert.equal(medianMinutes([failed], isStaticUnit), null);
    assert.equal(medianMinutes([webOnly(60)], isStaticUnit, 5, isUnit), null);
    assert.equal(
      medianMinutes([webOnly(60)], isStaticUnit),
      1,
      'without the rule the web-only run counts',
    );
    assert.equal(
      medianMinutes([run(120)], name => name === ciJobNames.macosJob),
      null,
    );
    const result = await measurers['ci.wall-clock-static-unit'](null, { ci: true, ciRuns: runs });
    assert.equal(result.measured, 3.9);
    const newest = await measurers['ci.wall-clock-e2e-browser'](null, { ci: true, ciRuns: runs });
    assert.match(newest.skip, /no completed browser E2E/);
  });

  it('wall-clock rows ignore runs that did not succeed', () => {
    const failed = { conclusion: 'failure', jobs: [ciJob(ciJobNames.staticJob, 600)] };
    const green = { conclusion: 'success', jobs: [ciJob(ciJobNames.staticJob, 120)] };
    assert.equal(
      newestMinutes([failed, green], name => name === ciJobNames.staticJob),
      2,
    );
  });

  it('bills jobs that failed or were cancelled, not skipped or unfinished ones', () => {
    const jobs = [
      ciJob(ciJobNames.staticJob, 61, 'failure'), // 2
      ciJob(ciJobNames.unitJob, 30, 'cancelled'), // 1
      ciJob('Website (typecheck, build)', 0, 'skipped'),
      {
        name: 'running',
        conclusion: '',
        startedAt: '2026-10-28T10:00:00Z',
        completedAt: '0001-01-01T00:00:00Z',
      },
    ];
    assert.equal(billedMinutes(jobs), 3);
  });

  it('ci.billed-minutes is skipped, never partial, when the month was not fully read', async () => {
    const run = { conclusion: 'success', jobs: [ciJob(ciJobNames.staticJob, 120)] };
    const partial = await measurers['ci.billed-minutes'](null, {
      ci: true,
      ciRuns: [run],
      ciComplete: false,
      ciProblems: ['gh run view 7: gh timed out after 30 s'],
    });
    assert.match(partial.skip, /incomplete month.*gh run view 7: gh timed out/);
    const wall = await measurers['ci.wall-clock-static-unit'](null, {
      ci: true,
      ciRuns: [run],
      ciComplete: false,
    });
    assert.equal(wall.measured, 2);
  });

  it('createdSince is the date of the start of the window', () => {
    assert.equal(createdSince(new Date('2026-10-29T12:00:00Z'), 30), '>=2026-09-29');
  });
});

// A fake `gh` first on PATH answers by subcommand; FAKE_GH_MODE picks the scenario. The CLI is run for
// real against the repo's budgets.json (read only: no --record), so the exit codes are the real ones.
const fakeGh = `#!${process.execPath}
const [sub, verb] = process.argv.slice(2);
const mode = process.env.FAKE_GH_MODE;
const jobs = [{ name: 'Static (format, lint, types, audit)', conclusion: 'success', startedAt: '2026-10-28T10:00:00Z', completedAt: '2026-10-28T10:02:00Z' }];
if (sub === 'run' && verb === 'list') {
  if (mode === 'list-fails') { console.error('HTTP 401: bad credentials'); process.exit(1); }
  if (mode === 'empty') { console.log('[]'); process.exit(0); }
  const count = 3;
  console.log(JSON.stringify(Array.from({ length: count }, (_, i) => ({ databaseId: i + 1, conclusion: 'success', status: mode === 'running' && i === 0 ? 'in_progress' : 'completed' }))));
} else if (sub === 'run' && verb === 'view') {
  if (mode === 'view-fails' && process.argv[4] === '2') { console.error('HTTP 502'); process.exit(1); }
  console.log(JSON.stringify({ jobs }));
}
`;

const runWithFakeGh = (mode, extraArgs = []) => {
  const dir = tempDir();
  writeFileSync(join(dir, 'gh'), fakeGh, { mode: 0o755 });
  return spawnSync(
    process.execPath,
    [script, '--ci', '--only', 'ci.billed-minutes,ci.wall-clock-static-unit', ...extraArgs],
    {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, FAKE_GH_MODE: mode },
    },
  );
};

describe('measure-budgets --ci against a fake gh', () => {
  it('measures a fully read month', () => {
    const run = runWithFakeGh('ok');
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /ci\.billed-minutes\s+6 minutes/);
    assert.match(run.stdout, /ci\.wall-clock-static-unit\s+2 min/);
  });

  it('skips billed minutes when the run list hit the cap', () => {
    const run = runWithFakeGh('cap', ['--ci-run-limit', '3']);
    assert.match(run.stdout, /ci\.billed-minutes\s+skipped.*incomplete month.*3-run limit/);
    assert.match(run.stderr, /3-run limit/);
  });

  it('treats an in-progress run as an incomplete month', () => {
    const run = runWithFakeGh('running');
    assert.match(
      run.stdout,
      /ci\.billed-minutes\s+skipped.*run 1 still in_progress|gh run view 1: run still in_progress/,
    );
    assert.match(run.stdout, /ci\.wall-clock-static-unit\s+2 min/);
  });

  it('rejects a bad --ci-run-limit', () => {
    assert.throws(() => parseArgs(['--ci-run-limit', '0']), /positive integer/);
    assert.equal(parseArgs(['--ci-run-limit', '5']).ciRunLimit, 5);
  });

  it('skips billed minutes when one gh run view fails, naming the step', () => {
    const run = runWithFakeGh('view-fails');
    assert.match(run.stdout, /ci\.billed-minutes\s+skipped.*gh run view 2: HTTP 502/);
    assert.match(run.stdout, /ci\.wall-clock-static-unit\s+2 min/);
  });

  it('exits 2 and names the step when gh run list fails', () => {
    const run = runWithFakeGh('list-fails');
    assert.equal(run.status, 2);
    assert.match(run.stderr, /ci: gh run list: HTTP 401: bad credentials/);
  });

  it('exits 2 and names the step when the list is empty', () => {
    const run = runWithFakeGh('empty');
    assert.equal(run.status, 2);
    assert.match(run.stderr, /ci: gh run list: no CI runs in the last 30 days/);
  });
});
