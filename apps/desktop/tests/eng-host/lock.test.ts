import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acquireLock,
  LockHeldError,
  createNodeLockFs,
  nodeLockFs,
  lockPath,
  parseLock,
  type LockFs,
  type LockPorts,
} from '../../src/host/lock';
import { linkSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProcessState } from '../../src/host/lifecycle';

/** An in-memory file system with the same failure codes as node:fs. */
function fakeFs(files = new Map<string, string>()): LockFs & { files: Map<string, string> } {
  const fail = (code: string) => Object.assign(new Error(code), { code });
  return {
    files,
    mkdirp: () => {},
    create(path, data) {
      if (files.has(path)) throw fail('EEXIST');
      files.set(path, data);
    },
    read: path => files.get(path),
    rename(from, to) {
      const data = files.get(from);
      if (data === undefined) throw fail('ENOENT');
      files.delete(from);
      files.set(to, data);
    },
    remove: path => void files.delete(path),
  };
}

const BOOT = 5_000_000;
function ports(fs: LockFs, pid: number, alive: number[] = [], boot = BOOT): LockPorts {
  return { fs, pid, now: () => 1_000, boot: () => boot, pidAlive: other => alive.includes(other) };
}

const dir = '/data';
const lock = (pid: number, boot = BOOT) => JSON.stringify({ pid, startedAt: 5, boot });

test('a stale lock from a crashed run is reclaimed, and release removes only our own file', () => {
  const fs = fakeFs(new Map([[lockPath(dir), lock(111)]]));
  const held = acquireLock(dir, ports(fs, 222));
  assert.equal(parseLock(fs.read(lockPath(dir)))?.pid, 222);
  assert.deepEqual([...fs.files.keys()], [lockPath(dir)]);
  held.release();
  assert.equal(fs.files.size, 0);
  held.release();
});

test('a live holder refuses with a clear error and its lock is left alone', () => {
  const fs = fakeFs(new Map([[lockPath(dir), lock(111)]]));
  assert.throws(
    () => acquireLock(dir, ports(fs, 222, [111])),
    (error: unknown) => error instanceof LockHeldError && /already running/.test(error.message),
  );
  assert.equal(fs.read(lockPath(dir)), lock(111));
});

test('garbage, empty and wrong-shape lock files are reclaimed', () => {
  for (const junk of ['', 'not json', '{"pid":"7"}', '[]', '{"pid":-1,"startedAt":1}']) {
    const fs = fakeFs(new Map([[lockPath(dir), junk]]));
    acquireLock(dir, ports(fs, 222, [7]));
    assert.equal(parseLock(fs.read(lockPath(dir)))?.pid, 222, JSON.stringify(junk));
  }
});

test('two launches racing for one stale lock: exactly one wins', () => {
  const fs = fakeFs(new Map([[lockPath(dir), lock(111)]]));
  const alive = [222, 333];
  const first = acquireLock(dir, ports(fs, 222, alive));
  assert.throws(() => acquireLock(dir, ports(fs, 333, alive)), LockHeldError);
  first.release();
  acquireLock(dir, ports(fs, 333, alive));
});

test('a launch that moves a lock another launch just took puts it back, and refuses', () => {
  // Both launches read the same stale lock; the other one (pid 333) reclaims it and takes the lock in between.
  const files = new Map([[lockPath(dir), lock(111)]]);
  const fs = fakeFs(files);
  const racing: LockFs = {
    ...fs,
    rename(from, to) {
      racing.rename = fs.rename;
      acquireLock(dir, ports(fs, 333, [333]));
      fs.rename(from, to);
    },
  };
  assert.throws(() => acquireLock(dir, ports(racing, 222, [333])), LockHeldError);
  assert.equal(parseLock(fs.read(lockPath(dir)))?.pid, 333, 'the winner keeps its lock');
  assert.deepEqual([...files.keys()], [lockPath(dir)], 'and no stale-aside file is left behind');
});

/** A host start in four steps. A kill stops it where it stands: no release, no cleanup, like SIGKILL. */
const startSteps = ['lock', 'engine', 'window', 'ready'] as const;
type StartStep = (typeof startSteps)[number];

class Killed extends Error {}

/** The data directory's database, shared by every launch; `open` is refused while another engine has it open. */
function fakeDatabase() {
  const rows: string[] = [];
  let openBy: number | undefined;
  return {
    rows,
    open(pid: number, alivePids: number[]) {
      if (openBy !== undefined && alivePids.includes(openBy)) throw new Error('database is open');
      openBy = pid;
    },
  };
}

function startHost(
  fs: LockFs,
  database: ReturnType<typeof fakeDatabase>,
  pid: number,
  alive: number[],
  killAfter?: StartStep,
) {
  const state = createProcessState();
  const step = (name: StartStep, run: () => void) => {
    run();
    if (name === killAfter) throw new Killed(name);
  };
  let held: ReturnType<typeof acquireLock> | undefined;
  step('lock', () => void (held = acquireLock(dir, ports(fs, pid, alive))));
  step('engine', () => {
    database.open(pid, alive);
    database.rows.push(`engine-by-${pid}`);
  });
  step('window', () => void database.rows.push(`window-by-${pid}`));
  step('ready', () => state.engineReady());
  return { held: held!, state };
}

test('kill at startup: killed after each step, the next launch reclaims the lock and opens the same data', () => {
  for (const killAfter of startSteps) {
    const fs = fakeFs();
    const database = fakeDatabase();
    assert.throws(() => startHost(fs, database, 111, [], killAfter), Killed, killAfter);

    // The next launch (pid 222) finds a lock left by a dead process: it reclaims it and opens the same database.
    const next = startHost(fs, database, 222, [222]);
    assert.equal(next.state.state, 'ready', `killed after ${killAfter}`);
    assert.equal(parseLock(fs.read(lockPath(dir)))?.pid, 222, `killed after ${killAfter}`);
    // What the killed launch had written is still there, and the new launch wrote its own beside it.
    const written = startSteps.indexOf(killAfter) >= 1 ? ['engine-by-111'] : [];
    for (const row of [...written, 'engine-by-222', 'window-by-222'])
      assert.ok(database.rows.includes(row), `${row} missing after a kill at ${killAfter}`);
    next.held.release();
    assert.equal(fs.files.size, 0);
  }
});

test('a second engine on data a live engine holds exits with a clear message and never opens it', () => {
  const fs = fakeFs();
  const database = fakeDatabase();
  const first = startHost(fs, database, 111, [111, 222]);
  assert.throws(
    () => startHost(fs, database, 222, [111, 222]),
    (error: unknown) => error instanceof LockHeldError && /already running/.test(error.message),
  );
  assert.equal(
    database.rows.some(row => row.endsWith('-by-222')),
    false,
    'the refused engine wrote nothing',
  );
  first.held.release();
  const later = startHost(fs, database, 222, [222]);
  assert.equal(later.state.state, 'ready');
});

test('a lock from another boot is stale even when its pid is alive again; the same boot refuses', () => {
  const sameBoot = fakeFs(new Map([[lockPath(dir), lock(111)]]));
  assert.throws(() => acquireLock(dir, ports(sameBoot, 222, [111])), LockHeldError);
  // Clock adjustments within the tolerance are still the same boot.
  const nudged = fakeFs(new Map([[lockPath(dir), lock(111, BOOT + 30_000)]]));
  assert.throws(() => acquireLock(dir, ports(nudged, 222, [111])), LockHeldError);

  // The Mac rebooted after a crash and gave pid 111 to an unrelated process: the old lock no longer counts.
  const otherBoot = fakeFs(new Map([[lockPath(dir), lock(111, BOOT - 3_600_000)]]));
  acquireLock(dir, ports(otherBoot, 222, [111]));
  assert.equal(parseLock(otherBoot.read(lockPath(dir)))?.pid, 222);
});

test('a lock with no boot time (an earlier build) falls back to the pid check', () => {
  const old = JSON.stringify({ pid: 111, startedAt: 5 });
  assert.throws(
    () => acquireLock(dir, ports(fakeFs(new Map([[lockPath(dir), old]])), 222, [111])),
    LockHeldError,
  );
  acquireLock(dir, ports(fakeFs(new Map([[lockPath(dir), old]])), 222));
});

test('the real file system: create is all-or-nothing, refuses an existing lock and leaves no temp file', () => {
  const root = mkdtempSync(join(tmpdir(), 'aplos-lock-test-'));
  try {
    const path = join(root, 'aplos.lock');
    const text = JSON.stringify({ pid: 1, startedAt: 2, boot: 3 });
    nodeLockFs.create(path, text);
    assert.equal(readFileSync(path, 'utf8'), text);
    assert.throws(
      () => nodeLockFs.create(path, 'other'),
      (error: unknown) => (error as { code?: string }).code === 'EEXIST',
    );
    assert.equal(readFileSync(path, 'utf8'), text);
    assert.deepEqual(readdirSync(root), ['aplos.lock']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a write that fails half way (a full disk) leaves no temp file and no lock', () => {
  const root = mkdtempSync(join(tmpdir(), 'aplos-lock-test-'));
  try {
    const path = join(root, 'aplos.lock');
    const failing = createNodeLockFs({
      write(file, data) {
        writeFileSync(file, data.slice(0, 3));
        throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
      },
      link: (from, to) => linkSync(from, to),
      remove: file => rmSync(file, { force: true }),
    });
    assert.throws(
      () => failing.create(path, 'whole lock text'),
      (error: unknown) => (error as { code?: string }).code === 'ENOSPC',
    );
    assert.deepEqual(readdirSync(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
