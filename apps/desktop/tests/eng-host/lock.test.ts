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

test('kill at startup: dying at any startup step never strands the next launch', () => {
  const steps = ['starting', 'lock', 'engine', 'windows'] as const;
  for (const killedAfter of steps) {
    const fs = fakeFs();
    // The first run does the steps in order and is killed (no release, no cleanup) after `killedAfter`.
    const state = createProcessState();
    for (const step of steps) {
      if (step === 'lock') acquireLock(dir, ports(fs, 111));
      if (step === 'engine') state.engineReady();
      if (step === killedAfter) break;
    }
    // The next launch (pid 222; 111 is dead) recovers: it takes the lock, whatever the first run left behind.
    const next = acquireLock(dir, ports(fs, 222));
    assert.equal(parseLock(fs.read(lockPath(dir)))?.pid, 222, `killed after ${killedAfter}`);
    next.release();
    assert.equal(fs.files.size, 0);
  }
});
