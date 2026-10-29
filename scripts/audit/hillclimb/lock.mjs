// Exclusive "check slot" for gates and scorers. Gates and scorers run full suites that must
// never overlap another suite on this machine (timings flake and eslint caches collide), so
// every gate/scorer runs inside withCheckSlot. The lock is a directory created with fs.mkdir,
// which is atomic on every filesystem we run on; a `pid` file inside marks the holder.
// Attempt agents do NOT hold the slot — only the scoring/gating phases do.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const LOCK_NAME = 'aplos-check-slot.lock';
export const defaultPollMs = 2000;
export const defaultTimeoutMs = 30 * 60 * 1000;
export const defaultStaleMs = 60 * 60 * 1000;

export function lockDir(base = tmpdir()) {
  return join(base, LOCK_NAME);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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
    return true; // exists (EPERM also lands here: alive, just not ours)
  } catch {
    return false;
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
 * `staleMs`. The slot is released in a finally so a throwing `fn` cannot wedge the machine.
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
        rmSync(dir, { recursive: true, force: true });
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
    return await fn();
  } finally {
    rmSync(dir, { recursive: true, force: true });
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
