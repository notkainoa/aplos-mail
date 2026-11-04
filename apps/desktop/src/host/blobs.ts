/**
 * The host's blob store (lane eng-host; plans/engine/blob-area.md decision 1): `BlobFiles` over one private folder,
 * `<dataDir>/blobs/` (0700), holding `<id>.blob` files (0600) and a `.tmp/` folder for writes in progress.
 *
 * One file is a magic line, one JSON header line (at most `BLOB_FILE_LIMITS.maxHeaderBytes`), then the bytes, so header
 * and bytes appear together in one atomic step: write a temp file (`O_CREAT|O_EXCL|O_NOFOLLOW`), `fsync` it, hard-link
 * it to the final name (`link` refuses an existing name, where `rename` would replace it), unlink the temp, `fsync` the
 * folder. The folder is checked (a real directory this user owns, not a link) at open and again before every call. A
 * blob file is `lstat`ed and must be a regular file with one link before it is opened (`O_NOFOLLOW|O_NONBLOCK`, so a
 * FIFO can never block), and the open file must be the one `lstat` saw. The id is checked against `BLOB_ID_PATTERN`
 * here, again, before any path is formed. Only names that are not a blob's, and files positively seen to be no blob
 * (not regular, too large, corrupt after a full read), are ever deleted by a scan, and never recursively; a file that
 * merely cannot be read right now (permissions, a file-handle shortage, a second hard link) is left alone and counted.
 * Nothing a caller sees names a path: every error that leaves this module is a `BlobFilesError` reason code.
 */
import { constants, promises as fs, type Stats } from 'node:fs';
import { join } from 'node:path';
import {
  BLOB_FILE_LIMITS,
  BLOB_ID_PATTERN,
  BlobFilesError,
  type BlobFiles,
  type BlobHeader,
} from '@aplos/engine/ports';

/** The first line of every blob file. */
const MAGIC = 'aplos-blob/1\n';
const MAGIC_BYTES = new TextEncoder().encode(MAGIC);
/** Every version's magic starts with this. */
const FAMILY = new TextEncoder().encode('aplos-blob/');
const TMP = '.tmp';
const FILE_NAME = /^(b_[0-9a-f]{32})\.blob$/;
const { O_CREAT, O_EXCL, O_WRONLY, O_RDONLY, O_NOFOLLOW, O_NONBLOCK, O_DIRECTORY } = constants;

/** The steps of one `put`, in order; tests watch them to pin the fsync order. */
export type BlobWriteStep = 'open' | 'write' | 'fsync' | 'link' | 'unlinkTemp' | 'fsyncDir';

export interface BlobFilesOptions {
  /** `<dataDir>/blobs`. Created (0700) when missing; refused when it is a link, not a directory, or not ours. */
  dir: string;
  /** Free bytes on the folder's disk. Default: `statfs`. */
  freeBytes?: (dir: string) => Promise<number>;
  /** Tighter caps (tests). A looser value than `BLOB_FILE_LIMITS` is ignored. */
  limits?: Partial<Limits>;
  /** Called before each step of a write; a throw there fails the put as a crash would (tests only). */
  step?: (step: BlobWriteStep) => void | Promise<void>;
  /** Called between a read's `lstat` and its `open` (tests only: a swap in that window). */
  peek?: () => Promise<void>;
}

type Limits = { -readonly [K in keyof typeof BLOB_FILE_LIMITS]: number };

function tightened(limits: Partial<Limits> = {}): Limits {
  const out = { ...BLOB_FILE_LIMITS } as Limits;
  for (const key of ['maxBytes', 'maxHeaderBytes', 'folderBytes'] as const) {
    const value = limits[key];
    if (typeof value === 'number' && value < out[key]) out[key] = value;
  }
  // The floor is the one cap where "tighter" means higher.
  const floor = limits.freeDiskFloor;
  if (typeof floor === 'number' && floor > out.freeDiskFloor) out.freeDiskFloor = floor;
  return out;
}

const isId = (id: unknown): id is string => typeof id === 'string' && BLOB_ID_PATTERN.test(id);

const errorCode = (error: unknown) => (error as { code?: unknown } | null)?.code;

/** Runs `work`; any error that is not already a reason code leaves as `io`, so no OS text or path escapes. */
async function coded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw error instanceof BlobFilesError ? error : new BlobFilesError('io');
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
    if (errorCode(error) !== 'EEXIST') throw new BlobFilesError('io');
  }
  await coded(async () => {
    const handle = await fs.open(dir, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    try {
      const stats = await handle.stat();
      if (!stats.isDirectory() || !ours(stats)) throw new BlobFilesError('io');
      await handle.chmod(0o700);
    } finally {
      await handle.close();
    }
  });
}

/** The folder is still a private (no group or other access) directory of ours, not a link swapped in since it was opened. */
async function checkFolder(dir: string): Promise<void> {
  const stats = await fs.lstat(dir).catch(() => undefined);
  if (!stats?.isDirectory() || stats.isSymbolicLink() || !ours(stats) || stats.mode & 0o077)
    throw new BlobFilesError('io');
}

/** A header the engine may have written: exactly the known fields, each of the right kind and size. */
export function cleanHeader(value: unknown): BlobHeader | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const h = value as Record<string, unknown>;
  const text = (v: unknown, max: number) =>
    typeof v === 'string' && v.length > 0 && v.length <= max;
  if (!text(h.principal, 200) || !text(h.mime, 200)) return undefined;
  if (h.kind !== 'upload' && h.kind !== 'original') return undefined;
  if (h.name !== undefined && !text(h.name, 255)) return undefined;
  if (!Number.isSafeInteger(h.size) || (h.size as number) < 0) return undefined;
  if (!Number.isSafeInteger(h.createdAt) || (h.createdAt as number) < 0) return undefined;
  const header: BlobHeader = {
    principal: h.principal as string,
    kind: h.kind,
    mime: h.mime as string,
    size: h.size as number,
    createdAt: h.createdAt as number,
  };
  if (h.name !== undefined) header.name = h.name as string;
  return header;
}

/** The magic line and the header line, as one prefix; `undefined` when the header does not fit. */
function encodePrefix(header: BlobHeader, limits: Limits): Uint8Array | undefined {
  const line = new TextEncoder().encode(`${JSON.stringify(header)}\n`);
  if (line.byteLength > limits.maxHeaderBytes) return undefined;
  const prefix = new Uint8Array(MAGIC_BYTES.byteLength + line.byteLength);
  prefix.set(MAGIC_BYTES);
  prefix.set(line, MAGIC_BYTES.byteLength);
  return prefix;
}

/** Parses the head of a blob file: `{header, offset}` of the bytes, or undefined when it is not one of ours. */
const startsWith = (head: Uint8Array, prefix: Uint8Array) =>
  head.byteLength >= prefix.byteLength && prefix.every((byte, i) => head[i] === byte);

/** A header with a `kind` this version does not know: a newer Aplos wrote it. */
const foreignKind = (parsed: unknown) => {
  const kind = (parsed as { kind?: unknown } | null)?.kind;
  return typeof kind === 'string' && kind !== 'upload' && kind !== 'original';
};

/**
 * `foreign` is a blob of another version of this format (another `aplos-blob/` magic, or a `kind` this version does not
 * know): a newer Aplos wrote it, so after a downgrade it is kept and counted, never served or deleted.
 */
function parseHead(
  head: Uint8Array,
  fileSize: number,
  limits: Limits,
): { header: BlobHeader; offset: number } | 'foreign' | undefined {
  if (!startsWith(head, MAGIC_BYTES)) return startsWith(head, FAMILY) ? 'foreign' : undefined;
  const end = head.indexOf(10, MAGIC_BYTES.byteLength);
  if (end < 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(head.subarray(MAGIC_BYTES.byteLength, end)),
    );
  } catch {
    return undefined;
  }
  const header = cleanHeader(parsed);
  if (!header && foreignKind(parsed)) return 'foreign';
  const offset = end + 1;
  if (!header || header.size > limits.maxBytes || offset + header.size !== fileSize)
    return undefined;
  return { header, offset };
}

/** Writes every byte of `data` at `position` (a write may be short). */
async function writeAll(handle: fs.FileHandle, data: Uint8Array, position: number): Promise<void> {
  // Read once: a buffer detached (transferred) mid-write must fail the write, not end it early.
  const length = data.byteLength;
  let done = 0;
  while (done < length) {
    const { bytesWritten } = await handle.write(data, done, length - done, position + done);
    if (bytesWritten <= 0) throw new BlobFilesError('io');
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

/**
 * What one blob file is: `ok` (open, with its header), `bad` (positively no blob: not a regular file, too large, or a
 * corrupt head after a full read; a scan deletes it), `skip` (cannot be read right now, or has a second link; left
 * alone, never deleted, still counted) or `missing`.
 */
type Inspected =
  | {
      kind: 'ok';
      handle: fs.FileHandle;
      header: BlobHeader;
      offset: number;
      stats: Stats;
    }
  | { kind: 'bad' }
  | { kind: 'skip'; size: number }
  | { kind: 'missing' };

const isRegular = (stats: Stats) => stats.isFile() && !stats.isSymbolicLink();

/**
 * `lstat`, then open the same entry. A second hard link (a backup tool's, or a write whose temp unlink failed) is not
 * served but never deleted: `skip`. `peek` runs between the two (tests only: a swap in that window).
 */
async function inspect(
  path: string,
  limits: Limits,
  peek?: () => Promise<void>,
): Promise<Inspected> {
  let seen: Stats;
  try {
    seen = await fs.lstat(path);
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? { kind: 'missing' } : { kind: 'skip', size: 0 };
  }
  const most = MAGIC_BYTES.byteLength + limits.maxHeaderBytes + limits.maxBytes;
  if (!isRegular(seen) || seen.size > most) return { kind: 'bad' };
  if (seen.nlink !== 1) return { kind: 'skip', size: seen.size };
  await peek?.();
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch {
    return { kind: 'skip', size: seen.size };
  }
  try {
    const stats = await handle.stat();
    // Swapped since the lstat: leave it for the next look.
    if (stats.ino !== seen.ino || stats.dev !== seen.dev) throw new Error('swapped');
    // Same inode as the lstat, so its type, links and size cannot differ in a way that makes it corrupt: re-check, skip.
    if (!isRegular(stats) || stats.nlink !== 1 || stats.size > most) throw new Error('changed');
    const head = new Uint8Array(
      Math.min(stats.size, MAGIC_BYTES.byteLength + limits.maxHeaderBytes),
    );
    if (!(await readAll(handle, head, 0))) throw new Error('short');
    const read = parseHead(head, stats.size, limits);
    if (!read || read === 'foreign') {
      await handle.close();
      return read ? { kind: 'skip', size: stats.size } : { kind: 'bad' };
    }
    return { kind: 'ok', handle, header: read.header, offset: read.offset, stats };
  } catch {
    await handle.close().catch(() => undefined);
    return { kind: 'skip', size: seen.size };
  }
}

/**
 * Deletes one entry, never recursively: a file is unlinked, an empty folder removed, and a folder with anything in it
 * is left alone (Node has no `unlinkat`, so a recursive delete by path could follow a link swapped in meanwhile).
 */
async function removeEntry(path: string): Promise<void> {
  const stats = await fs.lstat(path).catch(() => undefined);
  if (!stats) return;
  const gone = stats.isDirectory() ? fs.rmdir(path) : fs.unlink(path);
  await gone.catch(() => undefined);
}

/** Removes what is in `.tmp/`: writes a crash left half done. One that cannot be removed is left. */
async function emptyTemp(tmp: string): Promise<void> {
  const names = await coded(() => fs.readdir(tmp));
  for (const name of names) await removeEntry(join(tmp, name));
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
 * Opens (and creates) the blob folder, clears writes a crash left in `.tmp/`, deletes names that are not a blob's and
 * files that are positively no blob, and returns the store. Throws `BlobFilesError('io')` when the folder is unsafe;
 * the composition root then leaves `Blob/*` unavailable.
 */
export async function openBlobFiles(options: BlobFilesOptions): Promise<BlobFiles> {
  const limits = tightened(options.limits);
  const dir = options.dir;
  const tmp = join(dir, TMP);
  const freeBytes = options.freeBytes ?? statfsFree;
  const step = options.step ?? (() => undefined);
  await privateFolder(dir);
  await privateFolder(tmp);
  await emptyTemp(tmp);
  let sizes = new Map<string, number>();
  const pending = new Set<string>();
  let reserved = 0;
  const pathOf = (id: string) => join(dir, `${id}.blob`);
  const used = () => [...sizes.values()].reduce((sum, size) => sum + size, 0) + reserved;
  /** Changes made while a scan runs, applied to its fresh size table before the swap. */
  const scans = new Set<{ removed: Set<string>; added: Map<string, number> }>();
  const noteAdded = (id: string, size: number) => {
    for (const s of scans) {
      s.removed.delete(id);
      s.added.set(id, size);
    }
  };
  const noteRemoved = (id: string) => {
    for (const s of scans) {
      s.added.delete(id);
      s.removed.add(id);
    }
  };

  const discard = (name: string) => removeEntry(join(dir, name));

  /** Every name in the folder; builds a fresh size table and swaps it in at the end. */
  async function scan() {
    await checkFolder(dir);
    const changes = { removed: new Set<string>(), added: new Map<string, number>() };
    scans.add(changes);
    try {
      return await scanInto(changes);
    } finally {
      scans.delete(changes);
    }
  }

  async function scanInto(changes: { removed: Set<string>; added: Map<string, number> }) {
    const names = await coded(() => fs.readdir(dir));
    const found: { id: string; header: BlobHeader; mtimeMs: number }[] = [];
    const next = new Map<string, number>();
    for (const name of names) {
      if (name === TMP) continue;
      const id = FILE_NAME.exec(name)?.[1];
      if (!id) {
        await discard(name);
        continue;
      }
      // A put between its link and its temp unlink has two links for a moment: `skip`, never deleted; its own record
      // (`noteAdded`) sets its size when it finishes.
      const seen = await inspect(pathOf(id), limits, options.peek);
      if (seen.kind === 'bad') await discard(name);
      else if (seen.kind === 'skip') next.set(id, seen.size);
      else if (seen.kind === 'ok') {
        await seen.handle.close().catch(() => undefined);
        next.set(id, seen.stats.size);
        found.push({ id, header: seen.header, mtimeMs: seen.stats.mtimeMs });
      }
    }
    // Puts that finished and removes that landed while the scan ran win over what it saw.
    for (const id of changes.removed) next.delete(id);
    for (const [id, size] of changes.added) next.set(id, size);
    sizes = next;
    return found;
  }

  /** Synchronous on purpose: `put` reserves the id in the same turn, so a second put of it is `exists`. */
  function admit(id: string, header: BlobHeader, bytes: Uint8Array): Uint8Array {
    if (!isId(id)) throw new BlobFilesError('id');
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > limits.maxBytes)
      throw new BlobFilesError('tooLarge');
    const clean = cleanHeader(header);
    if (!clean || clean.size !== bytes.byteLength) throw new BlobFilesError('header');
    const prefix = encodePrefix(clean, limits);
    if (!prefix) throw new BlobFilesError('header');
    if (sizes.has(id) || pending.has(id)) throw new BlobFilesError('exists');
    const total = prefix.byteLength + bytes.byteLength;
    if (used() + total > limits.folderBytes) throw new BlobFilesError('folderFull');
    return prefix;
  }

  /** `total` is the size taken before any await, so a buffer detached since cannot shrink what must be written. */
  async function write(id: string, prefix: Uint8Array, bytes: Uint8Array, total: number) {
    const temp = join(tmp, `${id}.${process.pid}.${Date.now().toString(36)}.part`);
    let linked = false;
    try {
      await step('open');
      const handle = await fs.open(temp, O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW, 0o600);
      try {
        await step('write');
        await writeAll(handle, prefix, 0);
        await writeAll(handle, bytes, prefix.byteLength);
        await step('fsync');
        await handle.sync();
        // Never link a short file: it would be deleted as corrupt by the next scan after `put` said ok.
        if ((await handle.stat()).size !== total) throw new BlobFilesError('io');
      } finally {
        await handle.close();
      }
      await step('link');
      await fs.link(temp, pathOf(id)).catch(error => {
        throw new BlobFilesError(errorCode(error) === 'EEXIST' ? 'exists' : 'io');
      });
      linked = true;
      await step('unlinkTemp');
      await fs.unlink(temp);
      await step('fsyncDir');
      await syncFolder(dir);
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => undefined);
      if (linked) return;
      throw error instanceof BlobFilesError ? error : new BlobFilesError('io');
    }
  }

  // Sizes every blob already there (the folder cap counts them) and deletes what is positively not one.
  await scan();

  return {
    async put(id, header, bytes) {
      const prefix = admit(id, header, bytes);
      const total = prefix.byteLength + bytes.byteLength;
      // Reserved before the first await that can interleave: a second put of the same id is `exists`.
      pending.add(id);
      reserved += total;
      try {
        await checkFolder(dir);
        await checkFolder(tmp);
        const free = await freeBytes(dir).catch(() => 0);
        // Written so that a NaN (an odd `statfs`) fails closed too.
        if (!(free - total >= limits.freeDiskFloor)) throw new BlobFilesError('diskFull');
        await write(id, prefix, bytes, total);
        sizes.set(id, total);
        noteAdded(id, total);
      } finally {
        pending.delete(id);
        reserved -= total;
      }
    },

    async get(id) {
      if (!isId(id)) return undefined;
      try {
        await checkFolder(dir);
      } catch {
        return undefined;
      }
      const seen = await inspect(pathOf(id), limits, options.peek);
      if (seen.kind !== 'ok') return undefined;
      try {
        // A fresh buffer of exactly the blob's bytes per call, so a caller may transfer (detach) it.
        const bytes = new Uint8Array(seen.header.size);
        const complete = await readAll(seen.handle, bytes, seen.offset);
        return complete ? { header: seen.header, bytes } : undefined;
      } catch {
        return undefined;
      } finally {
        await seen.handle.close().catch(() => undefined);
      }
    },

    async remove(id) {
      if (!isId(id)) return;
      await checkFolder(dir);
      try {
        await fs.unlink(pathOf(id));
      } catch (error) {
        // The size stays counted until the file is really gone.
        if (errorCode(error) !== 'ENOENT') throw new BlobFilesError('io');
      }
      sizes.delete(id);
      noteRemoved(id);
    },

    list: () => coded(scan),

    async usage() {
      return used();
    },
  };
}
