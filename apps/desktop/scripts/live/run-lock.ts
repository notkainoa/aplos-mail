import { readFileSync, unlinkSync } from 'node:fs';
import { link, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { RunnerError } from './errors';

/**
 * One live run at a time. The pacer keeps a run under its unit budget, but two runners side by side
 * would each get the full budget and together pass Google's limit for the account. So a run holds a
 * lockfile in the vault folder, created with `wx` (it fails if the file exists) and holding the
 * runner's PID. A lock whose PID is no longer running is taken over; a live one refuses the run.
 */
export const LOCK_FILE = 'run.lock';

export interface RunLock {
  /** Removes the lockfile if it is still this run's. Safe to call more than once. */
  release(): Promise<void>;
}

export interface LockDeps {
  pid?: number;
  isAlive?(pid: number): boolean;
  /** Hard-links a file to a new name that must not exist yet (fs link; tests replace it). */
  link?(existing: string, newPath: string): Promise<void>;
}

/** True when a process with this PID exists (EPERM means it exists but belongs to someone else). */
export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function busy(path: string, holder: string): RunnerError {
  return new RunnerError(
    `Another live run is going (${holder}); wait for it to finish. If none is, delete ${path}`,
  );
}

/** The PID in a lockfile, or undefined when the file is empty or holds anything else. */
async function readPid(path: string): Promise<number | undefined> {
  const text = await readFile(path, 'utf8');
  return /^[1-9]\d{0,9}\n?$/.test(text) ? Number(text.trim()) : undefined;
}

/** The PID holding the lock; 'gone' when the lock was released meanwhile (so try again). */
async function lockHolder(path: string): Promise<number | 'gone' | undefined> {
  try {
    return await readPid(path);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'gone' : undefined;
  }
}

/** Creates the lockfile with the PID in it, or returns false if one exists already. */
async function tryCreate(path: string, pid: number): Promise<boolean> {
  let handle;
  try {
    handle = await open(path, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  try {
    await handle.writeFile(`${pid}\n`);
  } finally {
    await handle.close();
  }
  return true;
}

type LinkFile = (existing: string, newPath: string) => Promise<void>;

/**
 * Puts a lock this run moved aside by mistake back in place. link, not rename: it never replaces a
 * lock that yet another runner made meanwhile. If the link fails, the moved file is left where it
 * is (the busy message names the lock folder), never deleted: it may be a live runner's lock.
 */
async function putBack(aside: string, path: string, relink: LinkFile): Promise<void> {
  try {
    await relink(aside, path);
  } catch {
    return;
  }
  await unlink(aside);
}

/**
 * Moves a dead runner's lock aside, then checks the moved file is still that dead lock. If another
 * runner took the lock over in between, its lock is put back and this run refuses: fail closed.
 */
async function takeOver(path: string, deadPid: number, relink: LinkFile): Promise<void> {
  const aside = `${path}.stale-${randomUUID()}`;
  try {
    await rename(path, aside);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const moved = await readPid(aside).catch(() => undefined);
  if (moved !== deadPid) {
    await putBack(aside, path, relink);
    throw busy(path, 'it took the lock over just now');
  }
  await unlink(aside);
}

/**
 * Takes the run lock in `dir`. A lock held by a running process refuses with a plain message; an
 * empty or unreadable lock also refuses (it may be a runner that is still writing its PID).
 */
export async function acquireRunLock(dir: string, deps: LockDeps = {}): Promise<RunLock> {
  const pid = deps.pid ?? process.pid;
  const isAlive = deps.isAlive ?? processIsAlive;
  const relink = deps.link ?? link;
  const path = join(dir, LOCK_FILE);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await tryCreate(path, pid)) return heldLock(path, pid);
    const holder = await lockHolder(path);
    if (holder === 'gone') continue;
    if (holder === undefined) throw busy(path, 'its lockfile has no process id yet');
    if (holder === pid || isAlive(holder)) throw busy(path, `process ${holder}`);
    await takeOver(path, holder, relink);
  }
  throw busy(path, 'the lock keeps changing hands');
}

/** The held lock: released by the caller, and on process exit if the caller never got to it. */
function heldLock(path: string, pid: number): RunLock {
  let held = true;
  const onExit = (): void => {
    if (!held) return;
    held = false;
    try {
      if (readFileSync(path, 'utf8') === `${pid}\n`) unlinkSync(path);
    } catch {
      // already gone
    }
  };
  process.once('exit', onExit);
  return {
    async release() {
      if (!held) return;
      held = false;
      process.removeListener('exit', onExit);
      // Only this run's own lock is removed, never one another runner has taken over since.
      if ((await readPid(path).catch(() => undefined)) === pid) await unlink(path).catch(() => {});
    },
  };
}
