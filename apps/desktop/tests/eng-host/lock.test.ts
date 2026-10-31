import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acquireLock,
  LockHeldError,
  lockPath,
  parseLock,
  type LockFs,
  type LockPorts,
} from '../../src/host/lock';
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

function ports(fs: LockFs, pid: number, alive: number[] = []): LockPorts {
  return { fs, pid, now: () => 1_000, pidAlive: other => alive.includes(other) };
}

const dir = '/data';
const lock = (pid: number) => JSON.stringify({ pid, startedAt: 5 });

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
      // Recovery on open: an interrupted write from a killed engine is rolled back, so only whole rows remain.
      for (let i = rows.length - 1; i >= 0; i--)
        if (rows[i].startsWith('partial')) rows.splice(i, 1);
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
    database.rows.push(`partial-write-by-${pid}`);
  });
  step('window', () => {
    // The write the engine started at open completes once the window is up.
    database.rows.splice(
      database.rows.indexOf(`partial-write-by-${pid}`),
      1,
      `whole-write-by-${pid}`,
    );
  });
  step('ready', () => state.engineReady());
  return { held: held!, state };
}

test('kill at startup: killed after each step, the next launch recovers and opens the same data', () => {
  for (const killAfter of startSteps) {
    const fs = fakeFs();
    const database = fakeDatabase();
    assert.throws(() => startHost(fs, database, 111, [], killAfter), Killed, killAfter);

    // The next launch (pid 222) finds a lock left by a dead process: it reclaims it and opens the same database.
    const next = startHost(fs, database, 222, [222]);
    assert.equal(next.state.state, 'ready', `killed after ${killAfter}`);
    assert.equal(parseLock(fs.read(lockPath(dir)))?.pid, 222, `killed after ${killAfter}`);
    assert.equal(
      database.rows.some(row => row.startsWith('partial')),
      false,
      `a half-written row survived a kill after ${killAfter}`,
    );
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
