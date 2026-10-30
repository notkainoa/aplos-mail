// Exclusive "check slot" for gates and scorers. Gates and scorers run full suites that must
// never overlap another suite on this machine (timings flake and eslint caches collide), so
// every gate/scorer runs inside withCheckSlot. The lock is a directory created with fs.mkdir,
// which is atomic on every filesystem we run on; a `pid` file and a random `token` file mark
// the holder. Attempt agents do NOT hold the slot — only the scoring/gating phases do.
import { randomBytes } from 'node:crypto';
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

// Lock dirs this process currently holds mapped to their owner token, so a signal handler
// can release them on its way out instead of leaving a stale lock for the next run.
const held = new Map();

/** Release every slot we still hold — for SIGINT/SIGTERM/SIGHUP handlers. */
export function releaseHeldSlots() {
  for (const [dir, token] of [...held]) releaseIfOurs(dir, token);
  held.clear();
}

// A lock dir is only ever removed when BOTH its pid file still names this process and its
// token file still carries our random owner token: a peer that stole our (stale) dir and
// made a fresh one matches neither, and a pid alone could be recycled onto a stranger.
function releaseIfOurs(dir, token) {
  try {
    const cur = readLockFiles(dir);
    if (cur.pid === process.pid && cur.token === token) {
      rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    // Unreadable files — not ours to remove.
  }
}

/** The {pid, token} pair a lock dir currently claims; nulls for absent/unparseable files. */
function readLockFiles(dir) {
  let pid = null;
  let token = null;
  try {
    const raw = Number(readFileSync(join(dir, 'pid'), 'utf8').trim());
    if (Number.isInteger(raw) && raw > 0) pid = raw;
  } catch {
    // No readable pid file.
  }
  try {
    token = readFileSync(join(dir, 'token'), 'utf8').trim() || null;
  } catch {
    // No readable token file.
  }
  return { pid, token };
}

function pidAlive(pid) {
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is not ours to signal: alive, not stale.
    return error.code === 'EPERM';
  }
}

/**
 * Judges the dir at `dir`: stale when its pid is dead, or when it has no pid file and is
 * older than staleMs. Also returns `expected`, the identity snapshot {pid, token, mtimeMs}
 * takeStaleLock must re-verify after its rename — the check and the takeover are not
 * atomic, so whatever is found moved-aside has to match what was judged stale here.
 */
function staleness(dir, staleMs, now) {
  const cur = readLockFiles(dir);
  let mtimeMs = null;
  try {
    mtimeMs = statSync(dir).mtimeMs;
  } catch {
    // Vanished between EEXIST and now.
  }
  const expected = { ...cur, mtimeMs };
  if (cur.pid !== null) return { stale: !pidAlive(cur.pid), expected };
  return { stale: mtimeMs !== null && now() - mtimeMs > staleMs, expected };
}

/**
 * True when the moved-aside dir is provably the same dead lock `expected` describes: its
 * pid must still be dead (a live one means a peer's fresh lock was just renamed away under
 * us), and pid, token and mtime must all match the judgement snapshot — a just-created dir
 * carries a different token or no token and a fresh mtime, so it can never pass.
 */
function movedAsideIsStale(aside, expected) {
  const cur = readLockFiles(aside);
  if (pidAlive(cur.pid)) return false;
  if (expected === null) return true; // direct use: a dead or absent pid was the whole test
  if (cur.pid !== expected.pid || cur.token !== expected.token) return false;
  try {
    return statSync(aside).mtimeMs === expected.mtimeMs;
  } catch {
    return false;
  }
}

/**
 * Atomically moves a stale lock dir aside, then RE-VERIFIES the moved dir is still the
 * stale one that was judged. rename(2) is atomic, but the judgement is not: a peer can
 * legitimately win the slot in the gap and have its live lock renamed away under it.
 * When the moved-aside dir proves to be a different or live lock, it is renamed back and
 * this returns false; when it is the same dead dir, it is removed and true is returned.
 */
export function takeStaleLock(dir, expected = null) {
  const aside = `${dir}.stale-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    renameSync(dir, aside);
  } catch {
    return false; // already moved aside or recreated by another taker
  }
  if (movedAsideIsStale(aside, expected)) {
    rmSync(aside, { recursive: true, force: true });
    return true;
  }
  try {
    renameSync(aside, dir);
  } catch {
    // A third party recreated `dir` in the gap: the moved dir keeps its unique graveyard
    // name (a small tmpdir leak) rather than destroying the new lock to put it back.
  }
  return false;
}

/**
 * Runs `fn` holding the exclusive slot. Waits with `pollMs` polling, gives up after
 * `timeoutMs`, and takes over a lock whose holder pid is dead or that is older than
 * `staleMs` — by renaming it aside and re-verifying its identity, never by deleting in
 * place or trusting a check that predates the rename. On acquiring, a per-owner random
 * `token` file is written before `pid`, and release only happens while both still match,
 * so a stolen or recycled dir can never be removed from under its real owner.
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
      const verdict = staleness(dir, staleMs, now);
      if (verdict.stale) {
        takeStaleLock(dir, verdict.expected);
        continue; // lost races just hit EEXIST again on the next pass
      }
      if (now() > deadline) {
        throw new Error(`check slot ${dir} still held after ${timeoutMs / 1000}s`);
      }
      await sleep(pollMs);
    }
  }
  const token = `${process.pid}-${randomBytes(8).toString('hex')}`;
  try {
    // Token first: a dir carrying only a fresh token is still provably "someone's new
    // lock" to a mid-flight stale-taker, even in the gap before pid lands.
    writeFileSync(join(dir, 'token'), token);
    writeFileSync(join(dir, 'pid'), String(process.pid));
    held.set(dir, token);
    return await fn();
  } finally {
    releaseIfOurs(dir, token);
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
