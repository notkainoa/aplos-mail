import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as scratch from '../scratch.mjs';

// Namespace import with fallbacks: the safety proofs run this suite against the previous
// scratch.mjs, which lacks the new exports — the tests must reach their assertions, not die at
// the import.
const { cleanupScratch, isRegisteredScratch, scratchDir, scratchDirFor, scratchRegistry } = scratch;
const scratchNamePattern = scratch.scratchNamePattern ?? /^aplos-/;
const scratchMarkerName = scratch.scratchMarkerName ?? '.aplos-scratch.json';
const processStartKey = scratch.processStartKey ?? (() => null);

const scratchUrl = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'scratch.mjs'),
).href;
// A root outside os.tmpdir(), to prove cleanupScratch can never be pointed at paths elsewhere.
const outsideRoot = mkdtempSync(join(homedir(), 'aplos-scratch-test-outside-'));
after(() => rmSync(outsideRoot, { recursive: true, force: true }));

// Runs `code` as a module in a child process; the child imports the real helper.
const child = code =>
  spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });

describe('scratch.mjs', () => {
  it('creates a dir under tmpdir named aplos-scratch-<purpose>-<random> with mode 0700', () => {
    const dir = scratchDir('engine test');
    try {
      assert.ok(dir.startsWith(join(tmpdir(), 'aplos-scratch-engine-test-')), dir);
      assert.match(basename(dir), scratchNamePattern);
      assert.equal(statSync(dir).mode & 0o777, 0o700);
      assert.ok(isRegisteredScratch(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes a marker naming its pid, start key and creation time', () => {
    const dir = scratchDir('marker');
    try {
      const marker = JSON.parse(readFileSync(join(dir, scratchMarkerName), 'utf8'));
      assert.equal(marker.pid, process.pid);
      assert.equal(typeof marker.createdAt, 'number');
      assert.ok(marker.startedAt === null || typeof marker.startedAt === 'string');
      assert.equal(marker.startedAt, processStartKey(process.pid));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('always names dirs aplos-scratch-<purpose>-, defaulting the purpose to test', () => {
    for (const [prefix, head] of [
      [undefined, 'aplos-scratch-test-'],
      ['aplos-foo', 'aplos-scratch-foo-'],
      ['aplos-scratch-bar', 'aplos-scratch-bar-'],
      ['../..', 'aplos-scratch-test-'],
      ['x/../y', 'aplos-scratch-x-y-'],
      ['UPPER Case', 'aplos-scratch-upper-case-'],
    ]) {
      const dir = scratchDir(prefix);
      assert.ok(dir.startsWith(join(tmpdir(), head)), `${prefix} -> ${dir}`);
      assert.match(basename(dir), scratchNamePattern);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('caps the purpose at 24 characters', () => {
    const dir = scratchDir('a'.repeat(40));
    try {
      assert.ok(dir.startsWith(join(tmpdir(), `aplos-scratch-${'a'.repeat(24)}-`)), dir);
      assert.match(basename(dir), scratchNamePattern);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cleanupScratch removes registered dirs and is idempotent', () => {
    const a = scratchDir('cleanup-a');
    const b = scratchDir('cleanup-b');
    scratchRegistry.set(a, true); // double registration is harmless
    cleanupScratch();
    assert.equal(existsSync(a), false);
    assert.equal(existsSync(b), false);
    assert.equal(scratchRegistry.size, 0);
    cleanupScratch(); // second call must not throw
  });

  it('cleanupScratch refuses paths outside tmpdir or without the scratch name pattern', () => {
    const outside = join(outsideRoot, 'aplos-scratch-trapped-abc123');
    mkdirSync(outside);
    const wrongName = mkdtempSync(join(tmpdir(), 'zzz-not-ours-'));
    const lookalike = mkdtempSync(join(tmpdir(), 'aplos-integrator-'));
    const traversal = join(tmpdir(), '..', 'aplos-scratch-traversal-abc123');
    try {
      scratchRegistry.set(outside, true);
      scratchRegistry.set(wrongName, true);
      scratchRegistry.set(lookalike, true);
      scratchRegistry.set(traversal, true);
      cleanupScratch();
      assert.equal(existsSync(outside), true, 'outside tmpdir must survive');
      assert.equal(existsSync(wrongName), true, 'non-scratch basename must survive');
      assert.equal(existsSync(lookalike), true, 'aplos- lookalike must survive');
      assert.equal(scratchRegistry.size, 0, 'refused entries are still dropped from the registry');
    } finally {
      rmSync(outside, { recursive: true, force: true });
      rmSync(wrongName, { recursive: true, force: true });
      rmSync(lookalike, { recursive: true, force: true });
    }
  });

  it('cleanupScratch tolerates a dir the test already deleted', () => {
    const dir = scratchDir('pre-deleted');
    rmSync(dir, { recursive: true, force: true });
    cleanupScratch();
    assert.equal(scratchRegistry.size, 0);
  });

  describe('scratchDirFor', () => {
    let forDir;
    it('removes the dir right after its own test', t => {
      forDir = scratchDirFor(t, 'for-test');
      assert.ok(existsSync(forDir));
    });
    it('is gone by the next test', () => {
      assert.equal(existsSync(forDir), false);
    });
  });

  describe('processStartKey', () => {
    it('returns a stable non-null key for the current process', () => {
      const key = processStartKey(process.pid);
      assert.equal(typeof key, 'string');
      assert.equal(processStartKey(process.pid), key);
    });

    it('returns null for invalid pids', () => {
      for (const pid of [0, -1, 1.5, Number.NaN, 'x', null]) {
        assert.equal(processStartKey(pid), null, String(pid));
      }
    });

    it('uses field 22 of /proc/<pid>/stat alone on linux, never the boot time', () => {
      // starttime (field 22) is index 19 of the fields after the last ')'.
      const stat = '4242 (weird ) comm) S 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 555666\n';
      let bootTimeReads = 0;
      const readFile = path => {
        if (path === '/proc/4242/stat') return stat;
        // btime drifts by a second as the clock is disciplined: a key built from it would
        // mismatch a live owner's marker and read as a recycled pid. It must not be read.
        if (path === '/proc/stat') {
          bootTimeReads++;
          return `cpu 1\nbtime ${1717000000 + bootTimeReads}\n`;
        }
        throw new Error(`unexpected read ${path}`);
      };
      const first = processStartKey(4242, { platform: 'linux', readFile });
      const second = processStartKey(4242, { platform: 'linux', readFile });
      assert.equal(first, 'linux:555666');
      assert.equal(second, first);
      assert.equal(bootTimeReads, 0);
    });

    it('returns null on linux when the stat read fails or has no starttime', () => {
      const gone = () => {
        throw new Error('ENOENT');
      };
      assert.equal(processStartKey(4242, { platform: 'linux', readFile: gone }), null);
      const short = () => '1 (x) S 2 3\n';
      assert.equal(processStartKey(1, { platform: 'linux', readFile: short }), null);
    });

    it('uses a normalised ps lstart off linux', () => {
      const ps = pid => {
        assert.equal(pid, 99);
        return '  Thu   Oct 30  10:11:12 2026\n';
      };
      assert.equal(
        processStartKey(99, { platform: 'darwin', ps }),
        'darwin:Thu Oct 30 10:11:12 2026',
      );
    });

    it('returns null when ps fails or prints nothing', () => {
      const boom = () => {
        throw new Error('ps failed');
      };
      assert.equal(processStartKey(99, { platform: 'darwin', ps: boom }), null);
      assert.equal(processStartKey(99, { platform: 'darwin', ps: () => '  \n' }), null);
    });
  });

  describe('child processes', () => {
    const code = extra =>
      `import { scratchDir } from '${scratchUrl}'; const d = scratchDir('child'); console.log(d); ${extra}`;

    it('removes its scratch dir on a normal exit', () => {
      const result = child(code(''));
      assert.equal(result.status, 0, result.stderr);
      const dir = result.stdout.trim();
      assert.ok(dir.startsWith(join(tmpdir(), 'aplos-scratch-child-')));
      assert.equal(existsSync(dir), false);
    });

    it('removes its scratch dir when the process throws', () => {
      const result = child(code("throw new Error('boom')"));
      assert.equal(result.status, 1);
      const dir = result.stdout.trim().split('\n')[0];
      assert.equal(existsSync(dir), false);
    });

    it('removes its scratch dir on SIGTERM and re-raises the signal', () => {
      // The interval keeps the event loop alive, so the handler's re-raised SIGTERM is
      // delivered instead of racing a normal exit.
      const result = child(
        code("setInterval(() => {}, 60000); process.kill(process.pid, 'SIGTERM')"),
      );
      assert.equal(result.signal, 'SIGTERM', `status ${result.status}: ${result.stderr}`);
      const dir = result.stdout.trim().split('\n')[0];
      assert.ok(dir.startsWith(join(tmpdir(), 'aplos-scratch-child-')));
      assert.equal(existsSync(dir), false);
    });
  });
});
