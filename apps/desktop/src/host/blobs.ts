/**
 * The host's blob store (lane eng-host; plans/engine/blob-area.md decision 1): `BlobFiles` over one private folder,
 * `<dataDir>/blobs/` (0700), holding `<id>.blob` files (0600) and a `.tmp/` folder for writes in progress.
 *
 * One file is a magic line, one JSON header line (at most `BLOB_FILE_LIMITS.maxHeaderBytes`), then the bytes, so header
 * and bytes appear together in one atomic step: write a temp file (`O_CREAT|O_EXCL|O_NOFOLLOW`), `fsync` it, hard-link
 * it to the final name (`link` refuses an existing name, where `rename` would replace it), unlink the temp, `fsync` the
 * folder. Every open uses `O_NOFOLLOW`; the folders are `lstat`ed and must be real directories this user owns. The id is
 * checked against `BLOB_ID_PATTERN` here, again, before any path is formed. Nothing a caller sees names a path: errors
 * are `BlobFilesError` reason codes.
 */
import { constants, promises as fs } from 'node:fs';
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
const TMP = '.tmp';
const FILE_NAME = /^(b_[0-9a-f]{32})\.blob$/;
const { O_CREAT, O_EXCL, O_WRONLY, O_RDONLY, O_NOFOLLOW } = constants;

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

async function statfsFree(dir: string): Promise<number> {
  const stats = await fs.statfs(dir);
  return Number(stats.bavail) * Number(stats.bsize);
}

/** Creates `dir` (0700) if missing, then insists it is a real directory owned by this user, and makes it 0700. */
async function privateFolder(dir: string): Promise<void> {
  try {
    await fs.mkdir(dir, { mode: 0o700 });
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw new BlobFilesError('io');
  }
  const stats = await fs.lstat(dir);
  const uid = process.getuid?.();
  if (!stats.isDirectory() || stats.isSymbolicLink() || (uid !== undefined && stats.uid !== uid))
    throw new BlobFilesError('io');
  await fs.chmod(dir, 0o700);
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

/** Reads the header of an open blob file: `{header, offset}` of the bytes, or undefined when it is not one of ours. */
async function readHeader(
  handle: fs.FileHandle,
  fileSize: number,
  limits: Limits,
): Promise<{ header: BlobHeader; offset: number } | undefined> {
  const head = new Uint8Array(Math.min(fileSize, MAGIC_BYTES.byteLength + limits.maxHeaderBytes));
  const { bytesRead } = await handle.read(head, 0, head.byteLength, 0);
  for (let i = 0; i < MAGIC_BYTES.byteLength; i++) if (head[i] !== MAGIC_BYTES[i]) return undefined;
  const end = head.subarray(0, bytesRead).indexOf(10, MAGIC_BYTES.byteLength);
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
  const offset = end + 1;
  if (!header || header.size > limits.maxBytes || offset + header.size !== fileSize)
    return undefined;
  return { header, offset };
}

/** Opens a blob file without following a link; a regular file of a plausible size, or undefined. */
async function openBlob(path: string, limits: Limits) {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(path, O_RDONLY | O_NOFOLLOW);
  } catch {
    return undefined;
  }
  const stats = await handle.stat().catch(() => undefined);
  const most = MAGIC_BYTES.byteLength + limits.maxHeaderBytes + limits.maxBytes;
  if (!stats?.isFile() || stats.size > most) {
    await handle.close();
    return undefined;
  }
  return { handle, stats };
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

/** Removes everything in `.tmp/`: writes a crash left half done. */
async function emptyTemp(tmp: string): Promise<void> {
  for (const name of await fs.readdir(tmp)) {
    await fs.rm(join(tmp, name), { recursive: true, force: true });
  }
}

/** Best effort: the folder's entry for a new file reaches the disk. */
async function syncFolder(dir: string): Promise<void> {
  try {
    const handle = await fs.open(dir, O_RDONLY | O_NOFOLLOW);
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
 * Opens (and creates) the blob folder, clears writes a crash left in `.tmp/`, deletes anything whose name is not a
 * blob's or that is not a regular file, and returns the store. Throws `BlobFilesError('io')` when the folder is unsafe;
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
  const sizes = new Map<string, number>();
  const pending = new Set<string>();
  let reserved = 0;
  const pathOf = (id: string) => join(dir, `${id}.blob`);
  const used = () => [...sizes.values()].reduce((sum, size) => sum + size, 0) + reserved;

  /** Every name in the folder: blobs that read back are kept and sized; everything else is deleted. */
  async function scan() {
    const found: { id: string; header: BlobHeader; mtimeMs: number }[] = [];
    sizes.clear();
    for (const name of await fs.readdir(dir)) {
      if (name === TMP) continue;
      const id = FILE_NAME.exec(name)?.[1];
      const read = id ? await describe(id) : undefined;
      if (!id || !read) {
        await fs.rm(join(dir, name), { recursive: true, force: true });
        continue;
      }
      sizes.set(id, read.fileSize);
      found.push({ id, header: read.header, mtimeMs: read.mtimeMs });
    }
    return found;
  }

  async function describe(id: string) {
    const opened = await openBlob(pathOf(id), limits);
    if (!opened) return undefined;
    try {
      const read = await readHeader(opened.handle, opened.stats.size, limits);
      return (
        read && { header: read.header, mtimeMs: opened.stats.mtimeMs, fileSize: opened.stats.size }
      );
    } catch {
      return undefined;
    } finally {
      await opened.handle.close();
    }
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

  async function write(id: string, prefix: Uint8Array, bytes: Uint8Array): Promise<void> {
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

  // Sizes every blob already there (the folder cap counts them) and deletes what is not one.
  await scan();

  return {
    async put(id, header, bytes) {
      const prefix = admit(id, header, bytes);
      const total = prefix.byteLength + bytes.byteLength;
      // Reserved before the first await that can interleave: a second put of the same id is `exists`.
      pending.add(id);
      reserved += total;
      try {
        const free = await freeBytes(dir).catch(() => 0);
        // Written so that a NaN (an odd `statfs`) fails closed too.
        if (!(free - total >= limits.freeDiskFloor)) throw new BlobFilesError('diskFull');
        await write(id, prefix, bytes);
        sizes.set(id, total);
      } finally {
        pending.delete(id);
        reserved -= total;
      }
    },

    async get(id) {
      if (!isId(id)) return undefined;
      const opened = await openBlob(pathOf(id), limits);
      if (!opened) return undefined;
      try {
        const read = await readHeader(opened.handle, opened.stats.size, limits);
        if (!read) return undefined;
        // A fresh buffer of exactly the blob's bytes per call, so a caller may transfer (detach) it.
        const bytes = new Uint8Array(read.header.size);
        const complete = await readAll(opened.handle, bytes, read.offset);
        return complete ? { header: read.header, bytes } : undefined;
      } catch {
        return undefined;
      } finally {
        await opened.handle.close();
      }
    },

    async remove(id) {
      if (!isId(id)) return;
      sizes.delete(id);
      await fs.unlink(pathOf(id)).catch(() => undefined);
    },

    list: scan,

    async usage() {
      return used();
    },
  };
}
