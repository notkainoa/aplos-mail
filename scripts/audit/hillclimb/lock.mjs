// Exclusive "check slot" for gates and scorers. Gates and scorers run full suites that must
// never overlap another suite on this machine (timings flake and eslint caches collide), so
// every gate/scorer runs inside withCheckSlot. The lock is a directory published atomically:
// `pid` and a random `token` file are fully written under a staging name and rename(2)'d
// into place, so a reader either sees no lock or a COMPLETE one — never a dir whose missing
// files would read as a stale lock. A stale lock is taken over IN PLACE: a `claim` file
// (O_EXCL create — the compare-and-swap) elects one contender, which re-verifies the dead
// pid and expected token still in place and then swaps `token`/`pid` atomically. The lock
// dir is never moved aside, so a takeover can never carry a peer's live lock away and put
// it back on top of a fresh one. Attempt agents do NOT hold the slot.
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  lstatSync,
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
// Release-by-owner takes no `claim` and never waits — a live owner's pid+token match is
// sole authority, and a takeover claim can only ever exist on a dead pid's dir, so no
// live claim can be in flight on ours (least of all our own: a won takeover removes its
// claim before returning). The removal itself is atomic: rename the verified dir aside,
// re-read it inside the graveyard name, and only then delete. Deleting in place would
// expose a half-removed lock to readers and could shred a lock swapped under us — which
// only pid-recycling could produce, but the re-read is cheap insurance.
function releaseIfOurs(dir, token) {
  try {
    const cur = readLockFiles(dir);
    if (cur.pid !== process.pid || cur.token !== token) return;
    const aside = `${dir}.rm-${process.pid}-${randomBytes(4).toString('hex')}`;
    try {
      renameSync(dir, aside);
    } catch {
      return; // already gone or moved by a taker
    }
    const moved = readLockFiles(aside);
    if (moved.pid === process.pid && moved.token === token) {
      rmSync(aside, { recursive: true, force: true });
    } else {
      try {
        renameSync(aside, dir);
      } catch {
        // A fresh lock landed at `dir` already: leave the stray aside rather than clobber.
      }
    }
  } catch {
    // Unreadable files — not ours to remove.
  }
}

// An unreadable pid file surfaces one stderr line per lock dir — a contender polling
// for the full acquire timeout would otherwise spam a warning every poll interval.
const warnedUnreadablePid = new Set();

/** The {pid, token} pair a lock dir currently claims; nulls for absent/unparseable files. */
function readLockFiles(dir) {
  let pid = null;
  let token = null;
  let pidError = false;
  try {
    const raw = Number(readFileSync(join(dir, 'pid'), 'utf8').trim());
    if (Number.isInteger(raw) && raw > 0) pid = raw;
  } catch (error) {
    // ENOENT (and ENOTDIR, when a stray file sits at the path) means "no pid file".
    // Anything else — EMFILE, EIO, EACCES — means we cannot tell whether a holder is
    // recorded, so the lock must count as ALIVE (fail closed), never be stolen after
    // staleMs, and surface one warning line.
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      // No pid file.
    } else {
      pidError = true;
      if (!warnedUnreadablePid.has(dir)) {
        warnedUnreadablePid.add(dir);
        process.stderr.write(
          `check slot: cannot read ${join(dir, 'pid')} (${error.code}); treating the lock as alive\n`,
        );
      }
    }
  }
  try {
    token = readFileSync(join(dir, 'token'), 'utf8').trim() || null;
  } catch {
    // No readable token file.
  }
  return { pid, token, pidError };
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

// Is the recorded owner still alive? The dangerous case is a dead holder's pid recycled
// onto THIS process (e.g. a new run of this very script): the pid file then names a live
// process — ours — so process.kill proves nothing, and the lock would look held until the
// acquire timeout. Our own pid counts as alive only while `held` still carries the token
// written inside the dir — the one thing a real live holder knows and a dead one cannot
// leave behind. For pids recycled onto OTHER live processes there is no comparable proof:
// they stay indistinguishable from a genuine live holder and the standing rules apply —
// a dead pid is stale at once, a pid-less dir is stale only after the staleMs age limit,
// and a live foreign pid is trusted until it exits or the acquire deadline hits.
function ownerAlive(dir, cur) {
  if (cur.pidError) return true; // unreadable pid file — fail closed
  if (cur.pid === null) return false;
  if (cur.pid === process.pid) return cur.token !== null && held.get(dir) === cur.token;
  return pidAlive(cur.pid);
}

/**
 * Judges the dir at `dir`: stale when its recorded owner is dead (see ownerAlive for the
 * pid-reuse rules), or when it has no pid file at all and is older than staleMs — the
 * age check covers empty and pid-less dirs alike. Also returns `expected`, the identity
 * snapshot {pid, token, mtimeMs} takeStaleLock must re-verify in place — the judgement
 * and the takeover are not atomic, so a takeover only proceeds while the dir still
 * matches what was judged stale here.
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
  if (cur.pid !== null || cur.pidError) return { stale: !ownerAlive(dir, cur), expected };
  return { stale: mtimeMs !== null && now() - mtimeMs > staleMs, expected };
}

// Stages the caller's complete lock under a scratch name and publishes it with one
// rename. A reader can never observe the lock mid-write; a crashed stager only leaks a
// `<dir>.new-*` sibling, never blocks the slot itself. Throws the rename error (EEXIST /
// ENOTEMPTY when a lock exists, ENOTDIR when a stray file sits at the path).
function publish(dir, me) {
  const stage = `${dir}.new-${me.pid}-${randomBytes(4).toString('hex')}`;
  try {
    mkdirSync(stage);
    writeFileSync(join(stage, 'token'), me.token);
    writeFileSync(join(stage, 'pid'), String(me.pid));
    // rename(2) onto an existing EMPTY dir silently replaces it — that would adopt a
    // lock dir nobody judged stale, so any existing path (even an empty or pid-less
    // dir) must fail here exactly like a non-empty one and go through the caller's
    // staleness check. The lstat->rename gap is safe: rename onto a dir that has
    // since been filled fails ENOTEMPTY, and nothing in the protocol leaves an
    // empty dir at this path.
    let exists = true;
    try {
      lstatSync(dir);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      exists = false;
    }
    if (exists) {
      const occupied = new Error(`check slot already exists: ${dir}`);
      occupied.code = 'EEXIST';
      throw occupied;
    }
    renameSync(stage, dir);
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}

// Rewrites one lock file atomically: a temp sibling rename(2)'d over the live name, so a
// reader always sees a complete file — never a half-written pid or token.
function replaceFile(dir, name, contents) {
  const temp = join(dir, `.${name}-${process.pid}-${randomBytes(4).toString('hex')}`);
  writeFileSync(temp, contents);
  renameSync(temp, join(dir, name));
}

const CLAIM_NAME = 'claim';
// An unreadable or empty claim file may be a claimant between create and write; only
// treat it as abandoned once it is this old. A claim with a readable DEAD pid is
// cleared immediately — its claimant can never finish the takeover.
const claimGraceMs = 10_000;

function readClaim(dir) {
  let stat;
  try {
    stat = statSync(join(dir, CLAIM_NAME));
  } catch {
    return null;
  }
  let pid = null;
  try {
    const raw = Number(readFileSync(join(dir, CLAIM_NAME), 'utf8').trim());
    if (Number.isInteger(raw) && raw > 0) pid = raw;
  } catch {
    // Unreadable claim content — judged by age below.
  }
  return { pid, mtimeMs: stat.mtimeMs };
}

/**
 * The compare-and-swap step of a takeover: create `claim` inside the lock dir with
 * O_EXCL, so exactly one contender holds it and its re-verification runs with no rival
 * mutating the dir. A `claim` left by a crashed claimant (dead claimant pid, or an
 * unreadable one older than the grace window) is cleared and retried; a live claimant's
 * claim makes this return false.
 */
function tryClaim(dir, now) {
  const path = join(dir, CLAIM_NAME);
  for (let i = 0; i < 3; i++) {
    try {
      writeFileSync(path, String(process.pid), { flag: 'wx' });
      return true;
    } catch (error) {
      // ENOENT/ENOTDIR: dir gone. EINVAL: Darwin reports it for a create inside a
      // directory that is mid-teardown — same conclusion, the lock is going away.
      if (['ENOENT', 'ENOTDIR', 'EINVAL'].includes(error.code)) return false;
      if (error.code !== 'EEXIST') throw error;
      const claim = readClaim(dir);
      if (claim === null) continue; // freed between EEXIST and the read — retry
      // A claim naming OUR pid cannot be ours — we only ever read a claim after our own
      // O_EXCL create failed — so it is a dead claimant's marker left under a recycled
      // pid and is cleared like any other dead claimant.
      const abandoned =
        (claim.pid !== null && (claim.pid === process.pid || !pidAlive(claim.pid))) ||
        (claim.pid === null && now() - claim.mtimeMs > claimGraceMs);
      if (!abandoned) return false; // a live takeover is in flight — back off
      try {
        rmSync(path, { force: true });
      } catch {
        // Lost the race to clear it; whoever did will take the claim.
      }
    }
  }
  return false;
}

/**
 * Takes over a stale lock IN PLACE and returns true with the caller now holding it (its
 * pid/token files swapped in), or false when the lock is not the stale one that was
 * judged. The dir is never moved aside: `expected` is re-verified in place first, the
 * O_EXCL `claim` elects a single contender, the identity is re-verified once more under
 * the claim, and only then are `token` and `pid` swapped by atomic renames. A contender
 * whose `expected` describes a lock a peer already legitimately took over sees a
 * different token and backs off — the live lock can never be carried away. A stray FILE
 * at the lock path is the one exception: files are never valid locks, so moving it
 * aside to clear the path can never clobber a peer's lock.
 *
 * KNOWN LIMITATION — accepted, not fixed: the `claim` O_EXCL create is a CAS with an
 * ABA window. A dead claimant's marker can be read, cleared and recreated between one
 * contender's readClaim and its own create when at least three contenders hit the same
 * microseconds window, and the same applies when a LIVE claimant stalls longer than
 * the claimGraceMs create->write window and is mistaken for dead. It is accepted
 * because this lock only serialises dev test suites on one machine — the worst case
 * is two suites overlapping. The known fix is a generation-file redesign (`owner-N`
 * published by linkSync, which fails outright whenever the name exists, closing the
 * CAS by construction) — not worth the complexity for a dev-suite slot.
 */
export function takeStaleLock(dir, expected = null, identity = null, now = Date.now) {
  const me = identity ?? {
    pid: process.pid,
    token: `${process.pid}-${randomBytes(8).toString('hex')}`,
  };
  let stat;
  try {
    stat = lstatSync(dir);
  } catch {
    return false; // already gone — the caller's next pass publishes fresh
  }
  if (!stat.isDirectory()) {
    const aside = `${dir}.stray-${process.pid}-${randomBytes(4).toString('hex')}`;
    try {
      // Re-check the exact path with lstat before moving it: a live lock dir
      // published between the first check and the rename must never be carried
      // aside. Anything else already gone fails the rename below.
      if (lstatSync(dir).isDirectory()) return false;
      renameSync(dir, aside);
      // Whatever sits at `aside` now is exactly what the rename moved — if a lock
      // dir still slipped into the lstat->rename gap, put it back untouched. An
      // lstat failure is judged the same way: never delete what might be a lock.
      let movedIsDir = true;
      try {
        movedIsDir = lstatSync(aside).isDirectory();
      } catch {
        // Cannot tell — assume a lock dir and try to put it back.
      }
      if (movedIsDir) {
        try {
          renameSync(aside, dir);
        } catch {
          // A fresh lock already occupies `dir` — leave the aside rather than clobber.
        }
        return false;
      }
      rmSync(aside, { recursive: true, force: true });
    } catch {
      return false;
    }
    try {
      publish(dir, me);
      held.set(dir, me.token);
      return true;
    } catch {
      return false; // a peer published while the path was clear
    }
  }
  // The lock this call may take over: with an `expected` snapshot, the same pid+token;
  // without one, anything whose pid is dead or absent (direct-use semantics).
  const stillJudgedStale = cur =>
    (expected === null || (cur.pid === expected.pid && cur.token === expected.token)) &&
    !ownerAlive(dir, cur);
  if (!stillJudgedStale(readLockFiles(dir))) return false;
  if (!tryClaim(dir, now)) return false;
  try {
    // Under the claim nothing else can mutate the dir — this re-read closes the
    // read->claim gap against a release or a takeover finishing in between.
    if (!stillJudgedStale(readLockFiles(dir))) return false;
    replaceFile(dir, 'token', me.token);
    replaceFile(dir, 'pid', String(me.pid));
    held.set(dir, me.token);
    return true;
  } catch (error) {
    // ENOENT/ENOTDIR/EINVAL: the judged dir was torn down (or replaced by a stray
    // file) mid-swap — a non-protocol actor took the path away; the caller retries.
    if (!['ENOENT', 'ENOTDIR', 'EINVAL'].includes(error.code)) throw error;
    return false;
  } finally {
    try {
      rmSync(join(dir, CLAIM_NAME), { force: true });
    } catch {
      // The dir vanished under us (a live owner's release) — nothing left to clean.
    }
  }
}

/**
 * Runs `fn` holding the exclusive slot. Waits with `pollMs` polling, gives up after
 * `timeoutMs`, and takes over a lock whose holder pid is dead or that is older than
 * `staleMs` — in place under a `claim` marker, never by moving the dir aside or trusting
 * a check that predates the claim. Acquiring stages `pid` and a per-owner random `token`
 * and rename(2)s the stage over `dir`, so a lock is either absent or complete — rename
 * onto an existing non-empty dir fails, which is exactly the contention signal the loop
 * needs. Release only happens while both files still match, so a stolen or recycled dir
 * can never be removed from under its owner.
 */
export async function withCheckSlot(fn, options = {}) {
  const dir = options.dir ?? lockDir();
  const pollMs = options.pollMs ?? defaultPollMs;
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  const staleMs = options.staleMs ?? defaultStaleMs;
  const now = options.now ?? Date.now;
  const deadline = now() + timeoutMs;
  const me = { pid: process.pid, token: `${process.pid}-${randomBytes(8).toString('hex')}` };
  for (;;) {
    try {
      publish(dir, me); // fails EEXIST/ENOTEMPTY when `dir` is a live lock
      break;
    } catch (error) {
      // ENOTDIR: a stray FILE sits at the lock path — judge it like any stale dir.
      // EINVAL: the target dir was mid-teardown on Darwin — retry on the next pass.
      if (!['EEXIST', 'ENOTEMPTY', 'ENOTDIR', 'EINVAL'].includes(error.code)) throw error;
      const verdict = staleness(dir, staleMs, now);
      // A won takeover already holds the slot — it swapped our identity in place.
      if (verdict.stale && takeStaleLock(dir, verdict.expected, me, now)) break;
      const remaining = deadline - now();
      if (remaining <= 0) {
        throw new Error(`check slot ${dir} still held after ${timeoutMs / 1000}s`);
      }
      await sleep(Math.min(pollMs, remaining));
    }
  }
  try {
    held.set(dir, me.token);
    return await fn();
  } finally {
    releaseIfOurs(dir, me.token);
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
