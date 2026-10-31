import { randomUUID } from 'node:crypto';
import { open, readdir, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

// A directory cannot be flushed on Windows and on some file systems; there the rename is as durable as it gets.
const UNSYNCABLE_DIR = new Set(['EISDIR', 'EINVAL', 'EPERM', 'ENOTSUP']);

/** One new file, written in separate steps so a test can see their order. */
export interface DurableHandle {
  write(data: string | Uint8Array): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

/** The file system calls a durable write and the key check make. */
export interface DurableFs {
  /** Creates a file that must not exist yet (`wx`) with `mode`. */
  open(path: string, mode: number): Promise<DurableHandle>;
  rename(from: string, to: string): Promise<void>;
  syncDir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  /** Resolves when the path exists, rejects with the file system's error otherwise. */
  stat(path: string): Promise<unknown>;
}

export function ignoreUnsyncable(error: unknown): undefined {
  if (UNSYNCABLE_DIR.has((error as NodeJS.ErrnoException).code ?? '')) return undefined;
  throw error;
}

/** A folder opened for flushing. */
export interface FolderHandle {
  sync(): Promise<void>;
  close(): Promise<void>;
}

const openFolder = (path: string): Promise<FolderHandle> => open(path, 'r');

/**
 * Flush a folder so a rename in it survives a power cut. Only the four unsupported codes are ignored, on the open and
 * on the flush; the handle is always closed. `openFolderAt` is the seam a test uses to make the flush fail.
 */
export async function syncFolder(
  openFolderAt: (path: string) => Promise<FolderHandle>,
  path: string,
): Promise<void> {
  const handle = await openFolderAt(path).catch(ignoreUnsyncable);
  if (!handle) return;
  try {
    await handle.sync().catch(ignoreUnsyncable);
  } finally {
    await handle.close();
  }
}

export const nodeDurableFs: DurableFs = {
  async open(path, mode) {
    // `wx`: a fresh file, never one that is already there (or a link planted in its place).
    const handle = await open(path, 'wx', mode);
    return {
      write: data => handle.writeFile(data),
      sync: () => handle.sync(),
      close: () => handle.close(),
    };
  },
  rename,
  syncDir: path => syncFolder(openFolder, path),
  async remove(path) {
    await unlink(path).catch(() => {});
  },
  stat,
};

/**
 * Replace `path` with `data` so that after a crash it holds either the old or the new bytes, never a
 * partial file: write a uniquely named temporary file, flush it, rename it over the target, then flush
 * the folder so the rename itself survives a power cut. A failed write leaves the old file untouched
 * and removes its temporary copy.
 */
export async function writeFileDurably(
  path: string,
  data: string | Uint8Array,
  mode = 0o600,
  fs: DurableFs = nodeDurableFs,
): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let renamed = false;
  try {
    const handle = await fs.open(temporary, mode);
    try {
      await handle.write(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, path);
    renamed = true;
  } finally {
    if (!renamed) await fs.remove(temporary);
  }
  await fs.syncDir(dirname(path));
}

const TEMPORARY = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.)?tmp$/;

/**
 * Remove temporary copies a crash left beside `path`: `<file>.tmp` (older versions) and
 * `<file>.<uuid>.tmp`. Call it at start, before anything writes the file.
 */
export async function removeStaleTemporaries(
  path: string,
  fs: DurableFs = nodeDurableFs,
): Promise<void> {
  const file = basename(path);
  const dir = dirname(path);
  const names = await readdir(dir).catch(() => [] as string[]);
  const stale = names.filter(
    name => name.startsWith(`${file}.`) && TEMPORARY.test(name.slice(file.length + 1)),
  );
  await Promise.all(stale.map(name => fs.remove(join(dir, name))));
}
