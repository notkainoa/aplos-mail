// Exclusive "check slot" for gates and scorers. Gates and scorers run full suites that must
// never overlap another suite on this machine (timings flake and eslint caches collide), so
// every gate/scorer runs inside withCheckSlot. The lock is a directory created with fs.mkdir,
// which is atomic on every filesystem we run on; a `pid` file inside marks the holder.
// Attempt agents do NOT hold the slot — only the scoring/gating phases do.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const LOCK_NAME = 'aplos-check-slot.lock';
export const defaultPollMs = 2000;
// Queued gate suites can wait a long while behind another run on this machine; 3 hours
// covers a full queue, and the target config's lockWaitMin can stretch it further.
export const defaultTimeoutMs = 3 * 60 * 60 * 1000;
export const defaultStaleMs = 60 * 60 * 1000;

export function lockDir(base = tmpdir()) {
  return join(base, LOCK_NAME);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Lock dirs this process currently holds, so a signal handler can release them on its way
// out instead of leaving a stale lock for the next run.
const held = new Set();

/** Release every slot we still hold — for SIGINT/SIGTERM/SIGHUP handlers. */
export function releaseHeldSlots() {
  for (const dir of [...held]) releaseIfOurs(dir);
  held.clear();
}

// A lock dir is only ever removed when its pid file still names this process: if a peer
// stole our (stale) dir and made a fresh one, its pid is not ours and must not be deleted.
function releaseIfOurs(dir) {
  try {
    if (Number(readFileSync(join(dir, 'pid'), 'utf8').trim()) === process.pid) {
      rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    // No readable pid file — not ours to remove.
  }
}

/**
 * Atomically moves a stale lock dir aside. rename(2) is atomic, so exactly one contender
 * wins even when several processes judge the lock stale at once; the loser sees ENOENT.
 */
export function takeStaleLock(dir) {
  const aside = `${dir}.stale-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    renameSync(dir, aside);
  } catch {
    return false; // already moved aside or recreated by another taker
  }
  rmSync(aside, { recursive: true, force: true });
  return true;
}

function holderAlive(dir) {
  let pid;
  try {
    pid = Number(readFileSync(join(dir, 'pid'), 'utf8').trim());
  } catch {
    // No readable pid file: fall back to the lock's age below.
    return null;
  }
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is not ours to signal: alive, not stale.
    return error.code === 'EPERM';
  }
}

function isStale(dir, staleMs, now) {
  const alive = holderAlive(dir);
  if (alive === false) return true;
  if (alive === true) return false;
  try {
    return now() - statSync(dir).mtimeMs > staleMs;
  } catch {
    return false;
  }
}

/**
 * Runs `fn` holding the exclusive slot. Waits with `pollMs` polling, gives up after
 * `timeoutMs`, and takes over a lock whose holder pid is dead or that is older than
 * `staleMs` — by renaming it aside, never by deleting the directory in place (a peer that
 * re-created the slot between our staleness check and the delete would lose its live lock).
 * The slot is released in a finally, and only while its pid file still names this process.
 */
export async function withCheckSlot(fn, options = {}) {
  const dir = options.dir ?? lockDir();
  const pollMs = options.pollMs ?? defaultPollMs;
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  const staleMs = options.staleMs ?? defaultStaleMs;
  const now = options.now ?? Date.now;
  const deadline = now() + timeoutMs;
  for (;;) {
    try {
      mkdirSync(dir);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (isStale(dir, staleMs, now)) {
        takeStaleLock(dir);
        continue; // lost races just hit EEXIST again on the next pass
      }
      if (now() > deadline) {
        throw new Error(`check slot ${dir} still held after ${timeoutMs / 1000}s`);
      }
      await sleep(pollMs);
    }
  }
  try {
    writeFileSync(join(dir, 'pid'), String(process.pid));
    held.add(dir);
    return await fn();
  } finally {
    releaseIfOurs(dir);
    held.delete(dir);
  }
}

/** For tests and diagnostics: who holds the slot right now, if anyone. */
export function holderPid(dir = lockDir()) {
  if (!existsSync(dir)) return null;
  try {
    return Number(readFileSync(join(dir, 'pid'), 'utf8').trim()) || null;
  } catch {
    return null;
  }
}
