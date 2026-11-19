/**
 * `<dataDir>/run/aplos.lock` (host-2; plan 10 E1 item 4): one engine per data directory.
 * The file holds `{pid, startedAt}` and is created with `wx`. A lock whose process is gone, or whose file is
 * unreadable or garbage, is reclaimed; a lock held by a live process refuses, so a second engine never opens the
 * same database. Every file and process check comes in through `LockPorts`, so this runs under node:test.
 */
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { uptime } from 'node:os';
import { join } from 'node:path';

export interface LockFile {
  readonly pid: number;
  readonly startedAt: number;
  /** When the machine booted (epoch ms). A lock from another boot is stale whatever its pid is doing now. */
  readonly boot?: number;
}

/** Boot times of one boot differ by clock adjustments only; two boots are further apart than this. */
export const BOOT_TOLERANCE_MS = 60_000;

/** The file operations the lock needs. `create` must fail with code `EEXIST` when the file is there. */
export interface LockFs {
  mkdirp(dir: string): void;
  create(path: string, data: string): void;
  read(path: string): string | undefined;
  rename(from: string, to: string): void;
  remove(path: string): void;
}

export interface LockPorts {
  fs: LockFs;
  pid: number;
  now(): number;
  /** When the machine booted (epoch ms). */
  boot(): number;
  pidAlive(pid: number): boolean;
}

/** A live process already owns the data directory. `message` is safe to show the owner. */
export class LockHeldError extends Error {
  constructor(readonly holder: LockFile) {
    super(
      `Aplos Mail is already running with this data (process ${holder.pid}). Quit it first, or open that copy.`,
    );
    this.name = 'LockHeldError';
  }
}

export interface HeldLock {
  readonly path: string;
  /** Removes the file if it is still ours. Safe to call twice. */
  release(): void;
}

export const lockPath = (dataDir: string) => join(dataDir, 'run', 'aplos.lock');

/** The holder named by a lock file, or undefined for a missing, unreadable or garbage file. */
export function parseLock(text: string | undefined): LockFile | undefined {
  if (text === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null) return undefined;
    const { pid, startedAt, boot } = value as Record<string, unknown>;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return undefined;
    if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return undefined;
    if (typeof boot === 'number' && Number.isFinite(boot)) return { pid, startedAt, boot };
    return { pid, startedAt };
  } catch {
    return undefined;
  }
}

const exists = (error: unknown) => (error as { code?: string } | null)?.code === 'EEXIST';
const missing = (error: unknown) => (error as { code?: string } | null)?.code === 'ENOENT';
const MAX_ATTEMPTS = 5;

/**
 * Take the lock or throw `LockHeldError`. A stale lock is renamed away first, and rename is atomic, so of two
 * launches that both found the same stale file only one can move it; the other retries and finds the winner's lock.
 * (Electron's single-instance lock already keeps two app launches apart; this one also guards a second engine host,
 * such as a headless run, on the same data directory.)
 */
export function acquireLock(dataDir: string, ports: LockPorts): HeldLock {
  const path = lockPath(dataDir);
  const mine: LockFile = { pid: ports.pid, startedAt: ports.now(), boot: ports.boot() };
  const text = JSON.stringify(mine);
  ports.fs.mkdirp(join(dataDir, 'run'));
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      ports.fs.create(path, text);
      return heldLock(path, text, ports);
    } catch (error) {
      if (!exists(error)) throw error;
    }
    const current = ports.fs.read(path);
    const holder = parseLock(current);
    if (holder && holdsLock(holder, ports)) throw new LockHeldError(holder);
    reclaim(path, ports, attempt, current);
  }
  throw new Error('Aplos Mail could not take its data lock. Quit other copies and try again.');
}

/**
 * Move the stale file aside, then check it is the file we judged stale. Between our read and our rename another launch
 * may have reclaimed it and taken the lock; then what we moved is that launch's live lock, and it goes back.
 */
/**
 * A holder still holds the lock when its process is alive and it started in this boot. After a crash or power loss the
 * next boot can give an unrelated process the old pid (EPERM counts as alive), so a lock from another boot is stale.
 * A lock with no boot time (written by an earlier build) falls back to the pid check alone.
 */
function holdsLock(holder: LockFile, ports: LockPorts): boolean {
  if (holder.boot !== undefined && Math.abs(holder.boot - ports.boot()) > BOOT_TOLERANCE_MS)
    return false;
  return ports.pidAlive(holder.pid);
}

function reclaim(path: string, ports: LockPorts, attempt: number, judged: string | undefined) {
  const aside = `${path}.stale-${ports.pid}-${attempt}`;
  try {
    ports.fs.rename(path, aside);
  } catch (error) {
    if (missing(error)) return;
    throw error;
  }
  const moved = ports.fs.read(aside);
  ports.fs.remove(aside);
  if (moved === judged || moved === undefined) return;
  try {
    ports.fs.create(path, moved);
  } catch (error) {
    if (!exists(error)) throw error;
  }
}

function heldLock(path: string, text: string, ports: LockPorts): HeldLock {
  let released = false;
  return {
    path,
    release() {
      if (released) return;
      released = true;
      // Only a lock that still holds our own bytes is ours to remove.
      if (ports.fs.read(path) === text) ports.fs.remove(path);
    },
  };
}

/** `process.kill(pid, 0)` throws ESRCH for a gone process; EPERM means it exists but belongs to someone else. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === 'EPERM';
  }
}

/** The three file operations `create` makes, so a test can make the write fail the way a full disk does. */
export interface CreateIo {
  write(path: string, data: string): void;
  link(from: string, to: string): void;
  remove(path: string): void;
}
const nodeCreateIo: CreateIo = {
  write: (path, data) => writeFileSync(path, data, { flag: 'wx', mode: 0o600 }),
  link: (from, to) => linkSync(from, to),
  remove: path => rmSync(path, { force: true }),
};

export const createNodeLockFs = (io: CreateIo = nodeCreateIo): LockFs => ({
  mkdirp: dir => void mkdirSync(dir, { recursive: true, mode: 0o700 }),
  create(path, data) {
    // Written whole to a private name, then linked into place: a launch that finds the lock never reads half of it.
    const temp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    // The write is inside the try: a write that fails half way (a full disk) must not leave its temp file behind.
    try {
      io.write(temp, data);
      io.link(temp, path);
    } finally {
      io.remove(temp);
    }
  },
  read(path) {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return undefined;
    }
  },
  rename: (from, to) => renameSync(from, to),
  remove: path => rmSync(path, { force: true }),
});

export const nodeLockFs: LockFs = createNodeLockFs();

export const nodeLockPorts = (): LockPorts => ({
  fs: nodeLockFs,
  pid: process.pid,
  now: () => Date.now(),
  boot: () => Date.now() - uptime() * 1000,
  pidAlive: processAlive,
});
