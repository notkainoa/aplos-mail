import { randomUUID } from 'node:crypto';
import { open, readdir, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

// A directory cannot be flushed on Windows and on some file systems; there the rename is as durable as it gets.
const UNSYNCABLE_DIR = new Set(['EISDIR', 'EINVAL', 'EPERM', 'ENOTSUP']);

/** The file system calls a durable write makes, so a test can watch their order. */
export interface DurableFs {
  writeSynced(path: string, data: string | Uint8Array, mode: number): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  syncDir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
}

function ignoreUnsyncable(error: unknown): undefined {
  if (UNSYNCABLE_DIR.has((error as NodeJS.ErrnoException).code ?? '')) return undefined;
  throw error;
}

export const nodeDurableFs: DurableFs = {
  async writeSynced(path, data, mode) {
    // `wx`: a fresh file, never one that is already there (or a link planted in its place).
    const handle = await open(path, 'wx', mode);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  rename,
  async syncDir(path) {
    const handle = await open(path, 'r').catch(ignoreUnsyncable);
    if (!handle) return;
    try {
      await handle.sync().catch(ignoreUnsyncable);
    } finally {
      await handle.close();
    }
  },
  async remove(path) {
    await unlink(path).catch(() => {});
  },
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
    await fs.writeSynced(temporary, data, mode);
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
