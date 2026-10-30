// Shared scratch-directory helper. Tests that need a temporary directory call scratchDir()
// instead of bare mkdtempSync: the dir lands under os.tmpdir() named aplos-<prefix>-<random>
// with mode 0700 and is removed when the process exits, so a crashed or killed test run cannot
// leak scratch dirs into /tmp (the Linux dev box filled 7.5 GB of tmpfs with ~8,400 of them).
// cleanupScratch() only ever deletes paths inside os.tmpdir() whose basename starts with
// "aplos-" — a corrupted registry entry can never point the rm at anything else.
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';

// Every dir this process created, so the exit and signal handlers can remove them all. A Map
// keyed by the dir makes double registration harmless.
export const scratchRegistry = new Map();

const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const signalHandlers = new Map();
let handlersInstalled = false;

// mkdtemp needs a prefix that can only produce an "aplos-<clean>-" basename: anything that is
// not an ASCII letter, digit or hyphen becomes a hyphen, and a caller-supplied "aplos-" head is
// stripped so it is not doubled.
function sanitise(prefix) {
  const clean = String(prefix)
    .replace(/[^a-zA-Z0-9-]+/g, '-')
    .replace(/^aplos-/i, '')
    .replace(/^-+|-+$/g, '');
  return `aplos-${clean || 'scratch'}-`;
}

// The guard every deletion goes through: strictly inside os.tmpdir() AND a basename starting
// with "aplos-". resolve() normalises ".." segments without touching symlinks, so a registry
// entry pointing at "/tmp/../etc" or "/tmp/not-ours" is refused here.
function isSafeScratchPath(dir) {
  const resolved = resolve(dir);
  const base = resolve(tmpdir());
  return resolved.startsWith(base + sep) && basename(resolved).startsWith('aplos-');
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

/**
 * Creates a scratch dir under os.tmpdir() named aplos-<prefix>-<random>, mode 0700, and
 * registers it for removal on exit and on SIGINT/SIGTERM/SIGHUP.
 */
export function scratchDir(prefix = 'aplos-scratch') {
  const dir = mkdtempSync(join(tmpdir(), sanitise(prefix)));
  chmodSync(dir, 0o700);
  scratchRegistry.set(dir, true);
  installHandlers();
  return dir;
}

/**
 * scratchDir() bound to a node:test context: `t.after` removes the dir right after that test
 * (safe when the test already deleted it), and it stays registered so the exit handler still
 * removes it if the suite dies before the callback runs.
 */
export function scratchDirFor(t, prefix = 'aplos-scratch') {
  const dir = scratchDir(prefix);
  t.after(() => removeDir(dir));
  return dir;
}
