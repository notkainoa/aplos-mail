// Shared scratch-directory helper. Tests that need a temporary directory call scratchDir()
// instead of bare mkdtempSync: the dir lands under os.tmpdir() named
// aplos-scratch-<purpose>-<random> with mode 0700, carries a .aplos-scratch.json marker naming
// its owning pid, and is removed when the process exits, so a crashed or killed test run cannot
// leak scratch dirs into /tmp (the Linux dev box filled 7.5 GB of tmpfs with ~8,400 dirs).
// The marker is also what lets scripts/audit/scratch-sweep.mjs tell our leftovers from the
// "aplos-" prefixed files and dirs other agents create for their own work — only a DIRECTORY
// matching scratchNamePattern AND containing a readable marker is a sweep candidate.
// cleanupScratch() only ever deletes paths inside os.tmpdir() whose basename matches
// scratchNamePattern — a corrupted registry entry can never point the rm at anything else.
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';

// Every dir this process created, so the exit and signal handlers can remove them all. A Map
// keyed by the dir makes double registration harmless.
export const scratchRegistry = new Map();

// Basename shape of every dir scratchDir() can make: a fixed "aplos-scratch-" head, a
// sanitised purpose of [a-z0-9-] at most 24 chars, and mkdtemp's 6 random characters. The
// scratch sweep refuses anything else — files, sockets, symlinks and lookalike "aplos-*"
// working dirs are never candidates.
export const scratchNamePattern = /^aplos-scratch-[a-z0-9-]+-[A-Za-z0-9]{6}$/;

// Marker file written into every scratch dir at creation. The sweep deletes a dir only when
// this file exists and parses; a malformed or missing marker keeps the dir.
export const scratchMarkerName = '.aplos-scratch.json';

const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const signalHandlers = new Map();
let handlersInstalled = false;

// mkdtemp needs a prefix that can only produce an "aplos-scratch-<clean>-" basename: lowercased,
// anything that is not an ASCII letter, digit or hyphen becomes a hyphen, a caller-supplied
// "aplos-" or "aplos-scratch-" head is stripped so it is not doubled, and the purpose is capped
// at 24 chars (empty falls back to "test").
function sanitise(purpose) {
  const clean = String(purpose)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^aplos-scratch/, '')
    .replace(/^aplos/, '')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/g, '');
  return `aplos-scratch-${clean || 'test'}-`;
}

const defaultReadFile = path => readFileSync(path, 'utf8');
const defaultPs = pid =>
  execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' });

/**
 * A start-time key for `pid`: stable for the life of one process instance and different after
 * the pid is recycled. Returns a string, or null when it cannot be determined (callers must
 * then assume the process is still the original owner).
 * Linux: field 22 (starttime, clock ticks since boot) of /proc/<pid>/stat, qualified with the
 * boot time from /proc/stat. Other platforms: `ps -o lstart= -p <pid>` normalised.
 * `readers` is injectable for tests: { platform, readFile(path), ps(pid) }.
 */
export function processStartKey(pid, readers = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const platform = readers.platform ?? process.platform;
  const readFile = readers.readFile ?? defaultReadFile;
  const ps = readers.ps ?? defaultPs;
  try {
    if (platform === 'linux') {
      const stat = readFile(`/proc/${pid}/stat`);
      // comm (field 2) is parenthesised and may itself contain spaces or ')', so count fields
      // from the last ')': index 0 of the rest is field 3, making starttime (22) index 19.
      const rest = stat
        .slice(stat.lastIndexOf(')') + 1)
        .trim()
        .split(/\s+/);
      const ticks = rest[19];
      if (!/^\d+$/.test(ticks ?? '')) return null;
      // Ticks alone, no boot time: /proc/stat btime can drift by a second as the clock is
      // disciplined, which would make a live owner's key mismatch its marker and read as a
      // recycled pid. A pid recycled across a reboot is covered by /tmp itself being cleared.
      return `linux:${ticks}`;
    }
    const started = String(ps(pid)).trim().replace(/\s+/g, ' ');
    return started ? `${platform}:${started}` : null;
  } catch {
    return null;
  }
}

// The guard every deletion goes through: strictly inside os.tmpdir() AND a basename matching
// scratchNamePattern. resolve() normalises ".." segments without touching symlinks, so a
// registry entry pointing at "/tmp/../etc" or "/tmp/aplos-integrator" is refused here.
function isSafeScratchPath(dir) {
  const resolved = resolve(dir);
  const base = resolve(tmpdir());
  return resolved.startsWith(base + sep) && scratchNamePattern.test(basename(resolved));
}

function removeDir(dir) {
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
}

/** Removes every dir this process registered. Idempotent and best-effort: a dir already gone, a refused path or an rm failure never throws. */
export function cleanupScratch() {
  for (const dir of [...scratchRegistry.keys()]) {
    scratchRegistry.delete(dir);
    if (!isSafeScratchPath(dir)) continue;
    try {
      removeDir(dir);
    } catch {
      // Still exiting; a leftover beats a crash inside an exit handler.
    }
  }
}

function installHandlers() {
  if (handlersInstalled) return;
  handlersInstalled = true;
  process.on('exit', cleanupScratch);
  for (const signal of signals) {
    const handler = () => {
      cleanupScratch();
      // Re-raise the default behaviour: remove ourselves first so the re-sent signal cannot
      // re-enter this handler, then deliver it again. With no other listeners left the default
      // action (terminate) runs; we never swallow the signal.
      process.off(signal, handler);
      process.kill(process.pid, signal);
    };
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }
}

/** True when `dir` was created by scratchDir() in this process and not yet cleaned up. */
export function isRegisteredScratch(dir) {
  return scratchRegistry.has(resolve(dir));
}

/** Writes the ownership marker the scratch sweep requires before it will consider a dir. */
function writeMarker(dir) {
  const marker = {
    pid: process.pid,
    startedAt: processStartKey(process.pid),
    createdAt: Date.now(),
  };
  writeFileSync(join(dir, scratchMarkerName), `${JSON.stringify(marker)}\n`);
}

/**
 * Creates a scratch dir under os.tmpdir() named aplos-scratch-<purpose>-<random>, mode 0700,
 * writes its .aplos-scratch.json marker, and registers it for removal on exit and on
 * SIGINT/SIGTERM/SIGHUP. `purpose` defaults to "test".
 */
export function scratchDir(purpose = 'test') {
  const dir = mkdtempSync(join(tmpdir(), sanitise(purpose)));
  chmodSync(dir, 0o700);
  scratchRegistry.set(dir, true);
  installHandlers();
  writeMarker(dir);
  return dir;
}

/**
 * scratchDir() bound to a node:test context: `t.after` removes the dir right after that test
 * (safe when the test already deleted it), and it stays registered so the exit handler still
 * removes it if the suite dies before the callback runs.
 */
export function scratchDirFor(t, purpose = 'test') {
  const dir = scratchDir(purpose);
  t.after(() => removeDir(dir));
  return dir;
}
