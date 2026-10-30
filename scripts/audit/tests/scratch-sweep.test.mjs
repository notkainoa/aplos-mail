import assert from 'node:assert/strict';
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
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { scratchDir } from '../scratch.mjs';
import { parseArgs, sweepStaleScratch } from '../scratch-sweep.mjs';

const hour = 60 * 60 * 1000;
const aged = (path, hours) => {
  const time = new Date(Date.now() - hours * hour);
  utimesSync(path, time, time);
};

// Each test gets its own fake tmpdir (a real scratch dir, removed by the helper on exit) so
// sweeps can never see one another's fixtures.
const fixture = () => {
  const root = scratchDir('sweep-fix');
  const makeDir = (name, hours = 0) => {
    const path = join(root, name);
    mkdirSync(path);
    if (hours > 0) aged(path, hours);
    return path;
  };
  const sweep = extra => sweepStaleScratch({ dir: root, ...extra });
  return { root, makeDir, sweep };
};

describe('scratch-sweep.mjs', () => {
  it('removes entries older than maxAgeHours and keeps newer ones', () => {
    const { makeDir, sweep } = fixture();
    const old = makeDir('aplos-old-1', 5);
    const fresh = makeDir('aplos-new-1', 1);
    const { removed, kept } = sweep({ maxAgeHours: 4 });
    assert.deepEqual(removed, [old]);
    assert.equal(kept, 1);
    assert.equal(existsSync(old), false);
    assert.equal(existsSync(fresh), true);
  });

  it('keeps an old dir whose direct child was written recently', () => {
    const { makeDir, sweep } = fixture();
    const dir = makeDir('aplos-active-1');
    writeFileSync(join(dir, 'wip.txt'), 'still writing');
    aged(dir, 10); // dir mtime old, child mtime is now
    const { removed, kept } = sweep({ maxAgeHours: 4 });
    assert.deepEqual(removed, []);
    assert.equal(kept, 1);
    assert.equal(existsSync(dir), true);
  });

  it('ignores entries that do not match a prefix', () => {
    const { makeDir, sweep } = fixture();
    const other = makeDir('other-old-1', 24);
    const { removed } = sweep({ maxAgeHours: 4, prefixes: ['aplos-'] });
    assert.deepEqual(removed, []);
    assert.equal(existsSync(other), true);
  });

  it('respects a custom prefix list', () => {
    const { makeDir, sweep } = fixture();
    const own = makeDir('custom-old-1', 24);
    const other = makeDir('aplos-old-2', 24);
    const { removed } = sweep({ maxAgeHours: 4, prefixes: ['custom-'] });
    assert.deepEqual(removed, [own]);
    assert.equal(existsSync(own), false);
    assert.equal(existsSync(other), true);
  });

  it('never follows symlinks: the link and its target both survive', () => {
    const { root, makeDir, sweep } = fixture();
    const target = makeDir('target-dir', 24);
    writeFileSync(join(target, 'data.txt'), 'precious');
    const link = join(root, 'aplos-link-1');
    symlinkSync(target, link, 'dir');
    if (typeof lutimesSync === 'function') {
      const time = new Date(Date.now() - 24 * hour);
      lutimesSync(link, time, time);
    }
    const { removed } = sweep({ maxAgeHours: 4 });
    assert.equal(removed.includes(link), false);
    assert.equal(existsSync(link), true);
    assert.equal(existsSync(join(target, 'data.txt')), true);
    rmSync(link, { force: true });
  });

  it('skips entries owned by another uid', () => {
    const { makeDir, sweep } = fixture();
    const foreign = makeDir('aplos-foreign-1', 24);
    const asOtherUid = path => {
      const stat = lstatSync(path);
      if (path !== foreign) return stat;
      const foreignStat = Object.create(stat);
      foreignStat.uid = stat.uid + 1;
      return foreignStat;
    };
    const { removed, kept } = sweep({ maxAgeHours: 4, lstat: asOtherUid });
    assert.deepEqual(removed, []);
    assert.equal(kept, 1);
    assert.equal(existsSync(foreign), true);
  });

  it('never touches nested aplos- dirs below the top level', () => {
    const { makeDir, sweep } = fixture();
    const container = makeDir('container');
    const nested = join(container, 'aplos-deep-1');
    mkdirSync(nested);
    aged(nested, 24);
    const { removed } = sweep({ maxAgeHours: 4 });
    assert.deepEqual(removed, []);
    assert.equal(existsSync(nested), true);
  });

  it('does not remove the current process’s registered scratch', () => {
    const own = scratchDir('sweep-own');
    const { removed } = sweepStaleScratch({ dir: tmpdir(), maxAgeHours: 0, dryRun: true });
    try {
      assert.equal(removed.includes(own), false);
      assert.equal(existsSync(own), true);
    } finally {
      rmSync(own, { recursive: true, force: true });
    }
  });

  it('dry-run reports without deleting, and reports freed bytes', () => {
    const { makeDir, sweep } = fixture();
    const old = makeDir('aplos-dry-1');
    const blob = join(old, 'blob.bin');
    writeFileSync(blob, 'x'.repeat(2048));
    aged(old, 24);
    aged(blob, 24);
    const { removed, bytesFreedApprox } = sweep({ maxAgeHours: 4, dryRun: true });
    assert.deepEqual(removed, [old]);
    assert.ok(bytesFreedApprox >= 2048);
    assert.equal(existsSync(old), true);
    const second = sweep({ maxAgeHours: 4 });
    assert.deepEqual(second.removed, [old]);
    assert.equal(existsSync(old), false);
  });

  it('returns empty results for a missing dir', () => {
    const { root, sweep } = fixture();
    const { removed, kept, bytesFreedApprox } = sweep({ dir: join(root, 'nope') });
    assert.deepEqual(
      { removed, kept, bytesFreedApprox },
      {
        removed: [],
        kept: 0,
        bytesFreedApprox: 0,
      },
    );
  });

  describe('parseArgs', () => {
    it('parses flags, repeatable --prefix and the env fallback', () => {
      const options = parseArgs(
        ['--max-age-hours', '2.5', '--prefix', 'a-', '--prefix', 'b-', '--dir', '/x', '--dry-run'],
        {},
      );
      assert.deepEqual(options, {
        dryRun: true,
        prefixes: ['a-', 'b-'],
        dir: '/x',
        maxAgeHours: 2.5,
      });
      const fromEnv = parseArgs([], { APLOS_SCRATCH_MAX_AGE_HOURS: '7' });
      assert.equal(fromEnv.maxAgeHours, 7);
      assert.deepEqual(fromEnv.prefixes, ['aplos-']);
    });

    it('rejects bad arguments', () => {
      for (const argv of [
        ['--nope'],
        ['--max-age-hours', 'soon'],
        ['--max-age-hours', '-3'],
        ['--dir'],
        ['--prefix'],
      ]) {
        assert.throws(() => parseArgs(argv, {}), argv.join(' '));
      }
    });
  });
});
