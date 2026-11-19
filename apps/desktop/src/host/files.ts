/**
 * The host's attachment store (lane eng-store; plans/engine/blob-area.md decision 2, ARCH 3.3): `AttachmentFiles`
 * over one private folder tree, `<dataDir>/attachments/.noindex/` (0700), with writes in progress under `.tmp/`.
 *
 * A file holds a received attachment's raw bytes and nothing else: the path the engine later stores in a row is a
 * hash of the message's ids, so no name the sender chose ever touches the disk, and no header line is needed.
 * `write` is atomic (temp file, `fsync`, `rename`; a re-fetch of the same part replaces the file whole), `read`
 * opens the exact entry an `lstat` just saw (`O_NOFOLLOW|O_NONBLOCK`, so a link or a FIFO is never served or can
 * hang), `remove` is idempotent and never recursive, and `usage` walks the tree when asked. The folder and every
 * account subfolder are checked on the way in and again before every call: a real directory this user owns, not a
 * link. A path a caller hands back is accepted only in the one grammar this module writes, so a `..`, a slash
 * trick or a name a row was made to hold can never reach another file. Every error that leaves this module is an
 * `AttachmentFilesError` reason code; no OS text or path escapes.
 */
import { createHash, randomBytes } from 'node:crypto';
import { constants, promises as fs, type Stats } from 'node:fs';
import { join } from 'node:path';
import type { AttachmentFiles } from '@aplos/engine/store';

/** What a `read` or `remove` accepts: exactly the two-level path `write` returned. */
const PATH = /^[0-9a-f]{64}\/[0-9a-f]{64}_[0-9a-f]{64}$/;
const ACCOUNT_DIR = /^[0-9a-f]{64}$/;
const NOINDEX = '.noindex';
const TMP = '.tmp';
const { O_CREAT, O_EXCL, O_WRONLY, O_RDONLY, O_NOFOLLOW, O_NONBLOCK, O_DIRECTORY } = constants;

/** The caps an `AttachmentFiles` enforces, frozen as upper bounds: an implementation may tighten, never loosen. */
const LIMITS = {
  /** Bytes of one attachment (the `Attachment/get` fetch cap; the transport's 26 MB is that plus envelope). */
  maxBytes: 25 * 1024 * 1024,
  /** A write is refused while the disk has less free space than this. */
  freeDiskFloor: 1024 * 1024 * 1024,
} as const;

export type AttachmentRefusal = 'io' | 'path' | 'tooLarge' | 'diskFull';

/** The one error an `AttachmentFiles` throws; `reason` is safe to log. */
export class AttachmentFilesError extends Error {
  constructor(readonly reason: AttachmentRefusal) {
    super(`attachment store refused: ${reason}`);
    this.name = 'AttachmentFilesError';
  }
}

/** The steps of one `write`, in order; tests watch them to pin the fsync order. */
export type AttachWriteStep = 'open' | 'write' | 'fsync' | 'rename' | 'fsyncDir';

export interface AttachmentFilesOptions {
  /** `<dataDir>/attachments`. Created (0700) when missing; refused when it is a link, not a directory, or not ours. */
  dir: string;
  /** Free bytes on the folder's disk. Default: `statfs`. */
  freeBytes?: (dir: string) => Promise<number>;
  /** Tighter caps (tests). A looser value than `LIMITS` is ignored. */
  limits?: Partial<{ maxBytes: number; freeDiskFloor: number }>;
  /** Called before each step of a write; a throw there fails the write as a crash would (tests only). */
  step?: (step: AttachWriteStep) => void | Promise<void>;
  /** Called between a read's `lstat` and its `open` (tests only: a swap in that window). */
  peek?: () => Promise<void>;
}

type Limits = { maxBytes: number; freeDiskFloor: number };

function tightened(limits: AttachmentFilesOptions['limits'] = {}): Limits {
  return {
    maxBytes:
      typeof limits.maxBytes === 'number' && limits.maxBytes < LIMITS.maxBytes
        ? limits.maxBytes
        : LIMITS.maxBytes,
    freeDiskFloor:
      typeof limits.freeDiskFloor === 'number' && limits.freeDiskFloor > LIMITS.freeDiskFloor
        ? limits.freeDiskFloor
        : LIMITS.freeDiskFloor,
  };
}

const errorCode = (error: unknown) => (error as { code?: unknown } | null)?.code;

/** Runs `work`; any error that is not already a reason code leaves as `io`, so no OS text or path escapes. */
async function coded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw error instanceof AttachmentFilesError ? error : new AttachmentFilesError('io');
  }
}

async function statfsFree(dir: string): Promise<number> {
  const stats = await fs.statfs(dir);
  return Number(stats.bavail) * Number(stats.bsize);
}

const ours = (stats: Stats) => {
  const uid = process.getuid?.();
  return uid === undefined || stats.uid === uid;
};

/**
 * Creates `dir` (0700) if missing, then opens it with `O_DIRECTORY|O_NOFOLLOW` and checks and `fchmod`s the open
 * folder itself, so a link swapped in between can neither pass nor have its target's mode changed.
 */
async function privateFolder(dir: string): Promise<void> {
  try {
    await fs.mkdir(dir, { mode: 0o700 });
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw new AttachmentFilesError('io');
  }
  await coded(async () => {
    const handle = await fs.open(dir, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    try {
      const stats = await handle.stat();
      if (!stats.isDirectory() || !ours(stats)) throw new AttachmentFilesError('io');
      await handle.chmod(0o700);
    } finally {
      await handle.close();
    }
  });
}

/** The folder is still a real directory of ours, not a link swapped in since it was opened. */
async function checkFolder(dir: string): Promise<void> {
  const stats = await fs.lstat(dir).catch(() => undefined);
  if (!stats?.isDirectory() || stats.isSymbolicLink() || !ours(stats))
    throw new AttachmentFilesError('io');
}

/** The relative path `write` returns: the ids as hashes, so no name the sender chose reaches the disk. */
function pathOf(accountId: string, remoteId: string, remotePart: string): string {
  const hex = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
  return `${hex(accountId)}/${hex(remoteId)}_${hex(remotePart)}`;
}

/** Writes every byte of `data` at `position` (a write may be short). */
async function writeAll(handle: fs.FileHandle, data: Uint8Array, position: number): Promise<void> {
  let done = 0;
  while (done < data.byteLength) {
    const { bytesWritten } = await handle.write(
      data,
      done,
      data.byteLength - done,
      position + done,
    );
    if (bytesWritten <= 0) throw new AttachmentFilesError('io');
    done += bytesWritten;
  }
}

/** Fills `into` from `position`; false when the file ends first. */
async function readAll(
  handle: fs.FileHandle,
  into: Uint8Array,
  position: number,
): Promise<boolean> {
  let done = 0;
  while (done < into.byteLength) {
    const { bytesRead } = await handle.read(into, done, into.byteLength - done, position + done);
    if (bytesRead <= 0) return false;
    done += bytesRead;
  }
  return true;
}

const isRegular = (stats: Stats) => stats.isFile() && !stats.isSymbolicLink();

/**
 * Deletes one entry, never recursively: a file is unlinked, an empty folder removed, and a folder with anything in
 * it is left alone (Node has no `unlinkat`, so a recursive delete by path could follow a link swapped in meanwhile).
 */
async function removeEntry(path: string): Promise<void> {
  const stats = await fs.lstat(path).catch(() => undefined);
  if (!stats) return;
  const gone = stats.isDirectory() ? fs.rmdir(path) : fs.unlink(path);
  await gone.catch(() => undefined);
}

/**
 * Removes what is in `.tmp/`: writes a crash left half done. One that cannot be removed is left. Only
 * `.part` names go: if `.tmp` were swapped out between the folder check and this walk, the deletes land on
 * our own temp names at worst, not on arbitrary entries in whatever folder stands in for it.
 */
async function emptyTemp(tmp: string): Promise<void> {
  const names = await coded(() => fs.readdir(tmp));
  for (const name of names) if (name.endsWith('.part')) await removeEntry(join(tmp, name));
}

/** Best effort: the folder's entry for a new file reaches the disk. */
async function syncFolder(dir: string): Promise<void> {
  try {
    const handle = await fs.open(dir, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Some file systems refuse a directory fsync; the file itself was already synced.
  }
}

/**
 * Opens (and creates) the attachment tree, clears writes a crash left in `.tmp/`, and returns the store. Throws
 * `AttachmentFilesError('io')` when the folder is unsafe; the composition root then leaves the port absent. No
 * scan deletes anything else: a file a row still names is never this module's to throw away, whatever it is
 * called, and the store's own `file_removals` list is what tells it a file may go.
 */
export async function openAttachmentFiles(
  options: AttachmentFilesOptions,
): Promise<AttachmentFiles> {
  const limits = tightened(options.limits);
  const dir = options.dir;
  const files = join(dir, NOINDEX);
  const tmp = join(files, TMP);
  const freeBytes = options.freeBytes ?? statfsFree;
  const step = options.step ?? (() => undefined);
  let counter = 0;
  await privateFolder(dir);
  await privateFolder(files);
  await privateFolder(tmp);
  await emptyTemp(tmp);

  /** A caller's path stays inside `files`: the one grammar, so no `..`, no leading slash, no second component. */
  const clean = (path: unknown): path is string => typeof path === 'string' && PATH.test(path);

  return {
    async write(accountId, remoteId, remotePart, data) {
      return coded(async () => {
        if (
          typeof accountId !== 'string' ||
          typeof remoteId !== 'string' ||
          typeof remotePart !== 'string' ||
          accountId.length === 0 ||
          accountId.length > 8192 ||
          remoteId.length === 0 ||
          remoteId.length > 8192 ||
          remotePart.length === 0 ||
          remotePart.length > 8192 ||
          // A lone surrogate is not a real id: hashing it gives a stable-but-wrong name and any later
          // logging of it writes malformed text.
          !accountId.isWellFormed() ||
          !remoteId.isWellFormed() ||
          !remotePart.isWellFormed()
        )
          throw new AttachmentFilesError('path');
        if (!(data instanceof Uint8Array) || data.byteLength > limits.maxBytes)
          throw new AttachmentFilesError('tooLarge');
        const rel = pathOf(accountId, remoteId, remotePart);
        const sub = join(files, rel.split('/')[0]);
        const target = join(files, rel);
        await checkFolder(files);
        await checkFolder(tmp);
        await privateFolder(sub);
        const free = await freeBytes(files).catch(() => 0);
        // Written so that a NaN (an odd `statfs`) fails closed too.
        if (!(free - data.byteLength >= limits.freeDiskFloor))
          throw new AttachmentFilesError('diskFull');
        // pid+time+counter alone collides between two stores on one dir in one process; the token makes
        // every attempt's name its own, so a failure below never deletes a live writer's temp.
        const temp = join(
          tmp,
          `${process.pid}.${Date.now().toString(36)}.${(counter += 1).toString(36)}.${randomBytes(4).toString('hex')}.part`,
        );
        let renamed = false;
        try {
          await step('open');
          const handle = await fs.open(temp, O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW, 0o600);
          try {
            await step('write');
            await writeAll(handle, data, 0);
            await step('fsync');
            await handle.sync();
          } finally {
            await handle.close();
          }
          await step('rename');
          // Atomic replace: a re-fetch of the same part writes the same path again, and a reader at
          // that instant sees the old file or the new one, never a half-written one.
          await fs.rename(temp, target);
          renamed = true;
          await step('fsyncDir');
          await syncFolder(sub);
          await syncFolder(files);
        } catch (error) {
          await fs.rm(temp, { force: true }).catch(() => undefined);
          if (renamed) return rel;
          throw error instanceof AttachmentFilesError ? error : new AttachmentFilesError('io');
        }
        return rel;
      });
    },

    async read(path) {
      if (!clean(path)) return undefined;
      const sub = join(files, path.split('/')[0]);
      const target = join(files, path);
      let seen: Stats;
      try {
        // The leaf's guards cover the last component; the account folder is checked too, or a swap of
        // it for a link (or another folder) would let the read leave the tree.
        await checkFolder(files);
        await checkFolder(sub);
        seen = await fs.lstat(target);
      } catch {
        return undefined;
      }
      if (!isRegular(seen) || seen.nlink !== 1 || seen.size > limits.maxBytes) return undefined;
      let handle: fs.FileHandle;
      try {
        await options.peek?.();
        handle = await fs.open(target, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
      } catch {
        return undefined;
      }
      try {
        const stats = await handle.stat();
        // Swapped since the lstat, or no longer the regular single-link file it was.
        if (stats.ino !== seen.ino || stats.dev !== seen.dev) return undefined;
        if (!isRegular(stats) || stats.nlink !== 1 || stats.size > limits.maxBytes)
          return undefined;
        // A fresh buffer of exactly the file's bytes per call, so a caller may transfer (detach) it.
        const bytes = new Uint8Array(stats.size);
        return (await readAll(handle, bytes, 0)) ? bytes : undefined;
      } catch {
        return undefined;
      } finally {
        await handle.close().catch(() => undefined);
      }
    },

    async remove(path) {
      if (!clean(path)) return;
      const sub = join(files, path.split('/')[0]);
      const target = join(files, path);
      try {
        await checkFolder(files);
        // The account folder is checked too: a swap of it for a link would put the unlink's target
        // outside the tree. Missing or unsafe means there is nothing of ours to remove anyway.
        await checkFolder(sub);
      } catch (error) {
        if (error instanceof AttachmentFilesError) return;
        throw error;
      }
      const stats = await fs.lstat(target).catch(() => undefined);
      if (!stats) return;
      // Never recursive and never a directory: a swapped-in folder is left alone, not emptied.
      if (stats.isDirectory()) return;
      try {
        await fs.unlink(target);
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw new AttachmentFilesError('io');
      }
      // The account subfolder stays: an `rmdir` here could land between a concurrent write's checks and
      // its rename, making that rename fail ENOENT. An empty hash folder costs nothing to keep, and the
      // next write's `privateFolder` re-validates it.
    },

    async usage() {
      return coded(async () => {
        await checkFolder(files);
        let total = 0;
        for (const name of await fs.readdir(files)) {
          if (name === TMP) continue;
          if (!ACCOUNT_DIR.test(name)) continue;
          const sub = join(files, name);
          const stats = await fs.lstat(sub).catch(() => undefined);
          if (!stats?.isDirectory() || stats.isSymbolicLink()) continue;
          for (const file of await fs.readdir(sub).catch(() => [] as string[])) {
            const seen = await fs.lstat(join(sub, file)).catch(() => undefined);
            if (seen && isRegular(seen)) total += seen.size;
          }
        }
        return total;
      });
    },
  };
}
