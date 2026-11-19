import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  lutimesSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as scratch from '../scratch.mjs';
import { parseArgs, sweepStaleScratch } from '../scratch-sweep.mjs';

// Fallbacks keep this suite runnable against the previous scratch.mjs (safety proofs): the
// marker name predates the export, and scratchDir already existed.
const { scratchDir } = scratch;
const scratchMarkerName = scratch.scratchMarkerName ?? '.aplos-scratch.json';

const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'scratch-sweep.mjs');
const hour = 60 * 60 * 1000;
const aged = (path, hours) => {
  const time = new Date(Date.now() - hours * hour);
  utimesSync(path, time, time);
};

// Injectable liveness doubles: a dead pid, a live one, and markers that pretend both ways.
const deadKill = () => {
  throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
};
const aliveKill = () => true;
const staleMarker = { pid: 424243, startedAt: 'start-key-1', createdAt: 1 };

// Each test gets its own fake tmpdir (a real scratch dir, removed by the helper on exit) so
// sweeps can never see one another's fixtures.
const fixture = () => {
  const root = scratchDir('sweep-fix');
  const makeDir = (name, { hours = 0, marker } = {}) => {
    const path = join(root, name);
    mkdirSync(path);
    if (marker !== undefined) {
      const markerPath = join(path, scratchMarkerName);
      writeFileSync(markerPath, typeof marker === 'string' ? marker : JSON.stringify(marker));
      if (hours > 0) aged(markerPath, hours);
    }
    if (hours > 0) aged(path, hours);
    return path;
  };
  const makeFile = (name, hours = 0) => {
    const path = join(root, name);
    writeFileSync(path, 'x');
    if (hours > 0) aged(path, hours);
    return path;
  };
  const sweep = extra => sweepStaleScratch({ dir: root, ...extra });
  return { root, makeDir, makeFile, sweep };
};

// A pid that really is dead: a child that already exited. CLI tests cannot inject kill(), so
// the marker must name a real dead process.
const deadPid = () =>
  new Promise(resolve => {
    const child = spawn(process.execPath, ['-e', '']);
    child.on('exit', () => resolve(child.pid));
  });

const cli = (args, env = {}) =>
  spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });

describe('scratch-sweep.mjs', () => {
  it('reports stale marked dirs by default and deletes only with delete:true', () => {
    const { makeDir, sweep } = fixture();
    const old = makeDir('aplos-scratch-old-abc123', { hours: 5, marker: staleMarker });
    const report = sweep({ maxAgeHours: 4, kill: deadKill });
    assert.deepEqual(report.removed, [old]);
    assert.equal(existsSync(old), true, 'default must be report-only');
    const dry = sweep({ maxAgeHours: 4, dryRun: true, kill: deadKill });
    assert.deepEqual(dry.removed, [old]);
    assert.equal(existsSync(old), true, 'dryRun still reports only');
    const del = sweep({ maxAgeHours: 4, delete: true, kill: deadKill });
    assert.deepEqual(del.removed, [old]);
    assert.deepEqual(del.failed, []);
    assert.equal(existsSync(old), false);
  });

  it('keeps newer dirs and removes only those older than maxAgeHours', () => {
    const { makeDir, sweep } = fixture();
    const old = makeDir('aplos-scratch-old-abc123', { hours: 5, marker: staleMarker });
    const fresh = makeDir('aplos-scratch-new-def456', { hours: 1, marker: staleMarker });
    const { removed, kept } = sweep({ maxAgeHours: 4, delete: true, kill: deadKill });
    assert.deepEqual(removed, [old]);
    assert.equal(kept, 1);
    assert.equal(existsSync(old), false);
    assert.equal(existsSync(fresh), true);
  });

  it('keeps a stale marked dir whose owner pid is alive with a matching start key', () => {
    const { makeDir, sweep } = fixture();
    const dir = makeDir('aplos-scratch-live-abc123', { hours: 24, marker: staleMarker });
    const { removed, kept } = sweep({
      maxAgeHours: 4,
      delete: true,
      kill: aliveKill,
      startKey: () => 'start-key-1',
    });
    assert.deepEqual(removed, []);
    assert.equal(kept, 1);
    assert.equal(existsSync(dir), true, 'live work must survive even when the dir is old');
  });

  it('removes a stale dir whose live pid has a different start key (recycled pid)', () => {
    const { makeDir, sweep } = fixture();
    const dir = makeDir('aplos-scratch-recy-abc123', { hours: 24, marker: staleMarker });
    const { removed } = sweep({
      maxAgeHours: 4,
      delete: true,
      kill: aliveKill,
      startKey: () => 'other-key',
    });
    assert.deepEqual(removed, [dir]);
    assert.equal(existsSync(dir), false);
  });

  it('keeps the dir when a live pid’s start key cannot be determined', () => {
    const { makeDir, sweep } = fixture();
    const dir = makeDir('aplos-scratch-unkn-abc123', { hours: 24, marker: staleMarker });
    const { removed, kept } = sweep({
      maxAgeHours: 4,
      delete: true,
      kill: aliveKill,
      startKey: () => null,
    });
    assert.deepEqual(removed, []);
    assert.equal(kept, 1);
    assert.equal(existsSync(dir), true);
  });

  it('keeps the dir when the marker has no start key but the pid is alive', () => {
    const { makeDir, sweep } = fixture();
    const marker = { pid: 424243, createdAt: 1 };
    const dir = makeDir('aplos-scratch-noke-abc123', { hours: 24, marker });
    const { removed, kept } = sweep({
      maxAgeHours: 4,
      delete: true,
      kill: aliveKill,
      startKey: () => 'anything',
    });
    assert.deepEqual(removed, []);
    assert.equal(kept, 1);
    assert.equal(existsSync(dir), true);
  });

  it('keeps every lookalike that is not a marked scratch dir', () => {
    const { makeDir, makeFile, sweep } = fixture();
    // The names other agents use for their own working files; all older than the cutoff.
    const integrator = makeDir('aplos-integrator', { hours: 24 });
    const wip = join(integrator, 'wip.txt');
    writeFileSync(wip, 'live work');
    aged(wip, 24);
    aged(integrator, 24); // the wip write bumped the dir's mtime; age it last
    const css = makeFile('aplos-all.css', 24);
    const log = makeFile('aplos-baseline-dev.log', 24);
    const otherPrefix = makeDir('aplos-foo-abcdef', { hours: 24 });
    const shortSuffix = makeDir('aplos-scratch-test-abc', { hours: 24 });
    // Pattern-shaped names that are still not provably ours: no marker or a malformed one.
    const unmarked = makeDir('aplos-scratch-free-abc123', { hours: 24 });
    const badJson = makeDir('aplos-scratch-badj-def456', { hours: 24, marker: 'not json' });
    const scalar = makeDir('aplos-scratch-scal-abc999', { hours: 24, marker: '42' });
    const badPid = makeDir('aplos-scratch-pid--aaa111', {
      hours: 24,
      marker: { pid: 'x', createdAt: 1 },
    });
    const { removed, kept } = sweep({
      maxAgeHours: 4,
      delete: true,
      kill: deadKill,
      now: Date.now() + 100 * hour, // everything is old; only the gates can keep these
    });
    assert.deepEqual(removed, []);
    assert.equal(kept, 4, 'only the pattern-named dirs count as kept candidates');
    for (const path of [
      integrator,
      css,
      log,
      otherPrefix,
      shortSuffix,
      unmarked,
      badJson,
      scalar,
      badPid,
    ]) {
      assert.equal(existsSync(path), true, `${path} must survive`);
    }
    assert.equal(existsSync(join(integrator, 'wip.txt')), true);
  });

  it('keeps a socket file named like a scratch dir', async t => {
    const { root, sweep } = fixture();
    const sockPath = join(root, 'aplos-scratch-sock-abc123');
    const server = createServer();
    // Bound by a relative name from inside the fixture: macOS caps a socket address at 104 bytes, and
    // the full path under a runner's long TMPDIR is longer than that.
    const cwd = process.cwd();
    process.chdir(root);
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen('aplos-scratch-sock-abc123', resolve);
      });
    } finally {
      process.chdir(cwd);
    }
    t.after(() => server.close());
    assert.equal(lstatSync(sockPath).isSocket(), true);
    const { removed, kept } = sweep({
      delete: true,
      kill: deadKill,
      now: Date.now() + 100 * hour,
    });
    assert.deepEqual(removed, []);
    assert.equal(kept, 1);
    assert.equal(existsSync(sockPath), true);
  });

  it('never follows or removes a symlink named like a scratch dir', () => {
    const { root, makeDir, sweep } = fixture();
    const target = makeDir('target-dir', { hours: 24 });
    writeFileSync(join(target, 'data.txt'), 'precious');
    const link = join(root, 'aplos-scratch-link-abc123');
    symlinkSync(target, link, 'dir');
    if (typeof lutimesSync === 'function') {
      const time = new Date(Date.now() - 24 * hour);
      lutimesSync(link, time, time);
    }
    const { removed, kept } = sweep({
      delete: true,
      kill: deadKill,
      now: Date.now() + 100 * hour,
    });
    assert.deepEqual(removed, []);
    assert.equal(kept, 1, 'the link is pattern-named but not a directory');
    assert.equal(existsSync(link), true);
    assert.equal(existsSync(join(target, 'data.txt')), true);
    rmSync(link, { force: true });
  });

  it('keeps an old dir whose file two levels deep was just written', () => {
    const { makeDir, sweep } = fixture();
    const dir = makeDir('aplos-scratch-deep-abc123', { marker: staleMarker });
    const sub1 = join(dir, 'sub1');
    const sub2 = join(sub1, 'sub2');
    mkdirSync(sub1);
    mkdirSync(sub2);
    writeFileSync(join(sub2, 'wip.txt'), 'still writing');
    // Everything measured by a shallow walk looks stale; only the deep file is fresh.
    for (const path of [dir, join(dir, scratchMarkerName), sub1, sub2]) aged(path, 24);
    const { removed, kept } = sweep({ maxAgeHours: 4, delete: true, kill: deadKill });
    assert.deepEqual(removed, []);
    assert.equal(kept, 1);
    assert.equal(existsSync(dir), true, 'a run writing deep must not be swept mid-run');
  });

  it('treats a tree over the entry cap as fresh', () => {
    const { makeDir, sweep } = fixture();
    const dir = makeDir('aplos-scratch-huge-abc123', { hours: 24, marker: staleMarker });
    for (let i = 0; i < 8; i++) {
      const file = join(dir, `f${i}`);
      writeFileSync(file, 'x');
      aged(file, 24);
    }
    aged(dir, 24); // the writes bumped the dir's mtime; age it last
    const { removed, kept } = sweep({
      maxAgeHours: 4,
      delete: true,
      kill: deadKill,
      walkEntryCap: 5,
    });
    assert.deepEqual(removed, []);
    assert.equal(kept, 1);
    assert.equal(existsSync(dir), true, 'an unwalked remainder may hold live work');
  });

  it('treats a tree deeper than the depth cap as fresh', () => {
    const { makeDir, sweep } = fixture();
    const dir = makeDir('aplos-scratch-nest-abc123', { hours: 24, marker: staleMarker });
    let deep = dir;
    for (let i = 0; i < 8; i++) {
      deep = join(deep, 'n');
      mkdirSync(deep);
    }
    // Creating each level bumped its parent's mtime, so the whole chain is aged only after it
    // is fully built — every entry in the tree is stale, and only the walk cap keeps it.
    deep = dir;
    for (let i = 0; i < 8; i++) {
      deep = join(deep, 'n');
      aged(deep, 24);
    }
    aged(dir, 24);
    const { removed, kept } = sweep({ maxAgeHours: 4, delete: true, kill: deadKill });
    assert.deepEqual(removed, []);
    assert.equal(kept, 1);
    assert.equal(existsSync(dir), true);
    const deepWalk = sweep({ maxAgeHours: 4, delete: true, kill: deadKill, walkDepthCap: 20 });
    assert.deepEqual(deepWalk.removed, [dir], 'with the cap lifted the stale tree goes');
  });

  it('does not count a removal that throws, and lists it as failed', () => {
    const { makeDir, sweep } = fixture();
    const dir = makeDir('aplos-scratch-busy-abc123', { hours: 24, marker: staleMarker });
    const boom = () => {
      throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    };
    const { removed, failed, bytesFreedApprox } = sweep({
      maxAgeHours: 4,
      delete: true,
      kill: deadKill,
      remove: boom,
    });
    assert.deepEqual(removed, []);
    assert.deepEqual(failed, [dir]);
    assert.equal(bytesFreedApprox, 0);
    assert.equal(existsSync(dir), true);
  });

  it('does not count a removal whose path survives', () => {
    const { makeDir, sweep } = fixture();
    const dir = makeDir('aplos-scratch-stay-abc123', { hours: 24, marker: staleMarker });
    const { removed, failed } = sweep({
      maxAgeHours: 4,
      delete: true,
      kill: deadKill,
      remove: () => {},
    });
    assert.deepEqual(removed, []);
    assert.deepEqual(failed, [dir]);
    assert.equal(existsSync(dir), true);
  });

  it('keeps an old marked dir whose direct child was written recently', () => {
    const { makeDir, sweep } = fixture();
    const dir = makeDir('aplos-scratch-actv-abc123', { marker: staleMarker });
    writeFileSync(join(dir, 'wip.txt'), 'still writing');
    aged(dir, 24);
    aged(join(dir, scratchMarkerName), 24);
    const { removed, kept } = sweep({ maxAgeHours: 4, delete: true, kill: deadKill });
    assert.deepEqual(removed, []);
    assert.equal(kept, 1);
    assert.equal(existsSync(dir), true);
  });

  it('skips marked dirs owned by another uid', () => {
    const { makeDir, sweep } = fixture();
    const foreign = makeDir('aplos-scratch-frgn-abc123', { hours: 24, marker: staleMarker });
    const asOtherUid = path => {
      const stat = lstatSync(path);
      if (path !== foreign) return stat;
      const foreignStat = Object.create(stat);
      foreignStat.uid = stat.uid + 1;
      return foreignStat;
    };
    const { removed, kept } = sweep({
      maxAgeHours: 4,
      delete: true,
      kill: deadKill,
      lstat: asOtherUid,
    });
    assert.deepEqual(removed, []);
    assert.equal(kept, 1);
    assert.equal(existsSync(foreign), true);
  });

  it('never touches nested scratch dirs below the top level', () => {
    const { makeDir, sweep } = fixture();
    const container = makeDir('container');
    const nested = join(container, 'aplos-scratch-deep-abc123');
    mkdirSync(nested);
    aged(nested, 24);
    const { removed } = sweep({ delete: true, kill: deadKill, now: Date.now() + 100 * hour });
    assert.deepEqual(removed, []);
    assert.equal(existsSync(nested), true);
  });

  it('does not remove the current process’s own registered scratch', () => {
    const own = scratchDir('sweep-own');
    try {
      const { removed } = sweepStaleScratch({ dir: tmpdir() });
      assert.equal(removed.includes(own), false);
      assert.equal(existsSync(own), true);
    } finally {
      rmSync(own, { recursive: true, force: true });
    }
  });

  it('returns empty results for a missing dir', () => {
    const { root, sweep } = fixture();
    const { removed, kept, failed, bytesFreedApprox } = sweep({ dir: join(root, 'nope') });
    assert.deepEqual(
      { removed, kept, failed, bytesFreedApprox },
      {
        removed: [],
        kept: 0,
        failed: [],
        bytesFreedApprox: 0,
      },
    );
  });

  describe('cli', () => {
    it('reports by default and deletes only with --delete or --yes', async () => {
      const pid = await deadPid();
      const marker = { pid, startedAt: 'gone', createdAt: 1 };
      const { root } = fixture();
      const stale = join(root, 'aplos-scratch-clix-abc123');
      mkdirSync(stale);
      const markerPath = join(stale, scratchMarkerName);
      writeFileSync(markerPath, JSON.stringify(marker));
      aged(stale, 24);
      aged(markerPath, 24);
      const report = cli(['--dir', root]);
      assert.equal(report.status, 0, report.stderr);
      assert.match(report.stdout, /1 stale dir\(s\)/);
      assert.match(report.stdout, /aplos-scratch-clix-abc123/);
      assert.equal(existsSync(stale), true, 'default run must not delete');
      const yes = cli(['--dir', root, '--yes']);
      assert.equal(yes.status, 0, yes.stderr);
      assert.match(yes.stdout, /removed 1 stale dir\(s\)/);
      assert.equal(existsSync(stale), false);
    });

    it('--dry-run still only reports', async () => {
      const pid = await deadPid();
      const { root } = fixture();
      const stale = join(root, 'aplos-scratch-dryy-abc123');
      mkdirSync(stale);
      writeFileSync(
        join(stale, scratchMarkerName),
        JSON.stringify({ pid, startedAt: 'gone', createdAt: 1 }),
      );
      aged(stale, 24);
      aged(join(stale, scratchMarkerName), 24);
      const result = cli(['--dir', root, '--dry-run']);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /1 stale dir\(s\)/);
      assert.equal(existsSync(stale), true);
    });

    it('a NaN or non-numeric age never means "sweep everything"', async () => {
      const pid = await deadPid();
      const { root } = fixture();
      const fresh = join(root, 'aplos-scratch-nanx-abc123');
      mkdirSync(fresh);
      writeFileSync(
        join(fresh, scratchMarkerName),
        JSON.stringify({ pid, startedAt: 'gone', createdAt: Date.now() }),
      );
      for (const maxAgeHours of [Number.NaN, 'soon', undefined, null, -5, 0]) {
        const result = sweepStaleScratch({ dir: root, maxAgeHours, delete: true });
        assert.deepEqual(result.removed, [], `maxAgeHours ${String(maxAgeHours)}`);
        assert.equal(existsSync(fresh), true, `maxAgeHours ${String(maxAgeHours)}`);
      }
      const result = sweepStaleScratch({ dir: root, now: Number.NaN, delete: true });
      assert.deepEqual(result.removed, [], 'a NaN clock falls back to the real clock');
      assert.equal(existsSync(fresh), true);
    });

    it('--delete together with --dry-run reports and removes nothing (dry-run is a veto)', async () => {
      const pid = await deadPid();
      const { root } = fixture();
      const stale = join(root, 'aplos-scratch-vet0-abc123');
      mkdirSync(stale);
      writeFileSync(
        join(stale, scratchMarkerName),
        JSON.stringify({ pid, startedAt: 'gone', createdAt: 1 }),
      );
      aged(stale, 24);
      aged(join(stale, scratchMarkerName), 24);
      for (const args of [
        ['--delete', '--dry-run'],
        ['--dry-run', '--delete'],
        ['--yes', '--dry-run'],
      ]) {
        const result = cli(['--dir', root, ...args]);
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /rerun with --delete/);
        assert.equal(existsSync(stale), true, args.join(' '));
      }
    });

    it('rejects unsafe arguments with exit 2 and one stderr line', () => {
      const { root } = fixture();
      const link = join(root, 'dir-link');
      symlinkSync(root, link, 'dir');
      const file = join(root, 'a-file');
      writeFileSync(file, 'x');
      for (const args of [
        ['--dir', '/'],
        ['--dir', homedir()],
        ['--dir', dirname(homedir())],
        ['--dir', link],
        ['--dir', file],
        ['--dir', join(root, 'missing')],
        ['--prefix', 'x'],
        ['--max-age-hours', '0.1'],
        ['--max-age-hours', 'soon'],
        ['--dir'],
        ['--nope'],
      ]) {
        const result = cli(args);
        assert.equal(result.status, 2, args.join(' '));
        assert.equal(
          result.stderr.trim().split('\n').length,
          1,
          `one stderr line expected, got: ${result.stderr}`,
        );
      }
      const belowOne = cli(['--dir', root], { APLOS_SCRATCH_MAX_AGE_HOURS: '0.5' });
      assert.equal(belowOne.status, 2);
    });
  });

  describe('parseArgs', () => {
    it('parses flags, --delete/--yes aliases and the env fallback', () => {
      const { root } = fixture();
      assert.deepEqual(parseArgs(['--max-age-hours', '2.5', '--dir', root, '--delete'], {}), {
        delete: true,
        dryRun: false,
        dir: root,
        maxAgeHours: 2.5,
      });
      assert.equal(parseArgs(['--dir', root, '--yes'], {}).delete, true);
      assert.equal(parseArgs(['--dir', root], {}).delete, false);
      assert.equal(parseArgs(['--dir', root, '--dry-run'], {}).dryRun, true);
      const fromEnv = parseArgs(['--dir', root], { APLOS_SCRATCH_MAX_AGE_HOURS: '7' });
      assert.equal(fromEnv.maxAgeHours, 7);
      assert.equal(parseArgs([], { HOME: '/nonexistent-home' }).dir, null);
    });

    it('rejects bad arguments', () => {
      for (const argv of [
        ['--nope'],
        ['--prefix', 'x'],
        ['--max-age-hours', 'soon'],
        ['--max-age-hours', '-3'],
        ['--max-age-hours', '0.9'],
        ['--dir'],
        ['--dir', '/'],
      ]) {
        assert.throws(() => parseArgs(argv, {}), argv.join(' '));
      }
      assert.throws(() => parseArgs([], { APLOS_SCRATCH_MAX_AGE_HOURS: '0.5' }));
    });
  });
});
