import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ignoreUnsyncable,
  nodeDurableFs,
  syncFolder,
  removeStaleTemporaries,
  writeFileDurably,
  type DurableFs,
  type DurableHandle,
} from '../../src/main/durable-file';
import {
  KeyringError,
  createCipher,
  loadDataKey,
  migrateCredentials,
} from '../../src/main/keyring';

const keychain = {
  available: () => true,
  encrypt: (v: string) => Buffer.from(`kc:${v}`),
  decrypt: (b: Buffer) => b.toString().slice(3),
};

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'aplos-keyring-durable-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('a durable write writes, flushes and closes the file, renames it, then flushes the folder', () =>
  withDir(async dir => {
    const calls: string[] = [];
    const fs: DurableFs = {
      ...nodeDurableFs,
      open: async (path, mode) => {
        calls.push(`open ${mode.toString(8)}`);
        const real = await nodeDurableFs.open(path, mode);
        const step = (name: 'write' | 'sync' | 'close') => {
          calls.push(name);
        };
        return {
          write: async data => {
            step('write');
            await real.write(data);
          },
          sync: async () => {
            step('sync');
            await real.sync();
          },
          close: async () => {
            step('close');
            await real.close();
          },
        };
      },
      rename: async (from, to) => {
        calls.push('rename');
        await nodeDurableFs.rename(from, to);
      },
      syncDir: async path => {
        calls.push('syncDir');
        await nodeDurableFs.syncDir(path);
      },
    };
    const path = join(dir, 'engine-key.bin');
    await writeFileDurably(path, 'new', 0o600, fs);
    assert.deepEqual(calls, ['open 600', 'write', 'sync', 'close', 'rename', 'syncDir']);
    assert.equal(await readFile(path, 'utf8'), 'new');
    assert.deepEqual(await readdir(dir), ['engine-key.bin']);
  }));

test('the temporary file is created new: an existing file at that name is refused', () =>
  withDir(async dir => {
    const path = join(dir, 'taken');
    await writeFile(path, 'planted');
    await assert.rejects(nodeDurableFs.open(path, 0o600), { code: 'EEXIST' });
    assert.equal(await readFile(path, 'utf8'), 'planted');
  }));

test('a folder flush error other than the four unsupported ones is thrown', () =>
  withDir(async dir => {
    for (const code of ['EISDIR', 'EINVAL', 'EPERM', 'ENOTSUP'])
      assert.equal(ignoreUnsyncable(Object.assign(new Error(code), { code })), undefined);
    for (const code of ['EIO', 'EACCES', 'ENOENT'])
      assert.throws(() => ignoreUnsyncable(Object.assign(new Error(code), { code })), { code });
    await assert.rejects(nodeDurableFs.syncDir(join(dir, 'missing')), { code: 'ENOENT' });
  }));

test('each write uses a temporary name of its own', () =>
  withDir(async dir => {
    const names: string[] = [];
    const handle: DurableHandle = {
      write: async () => {},
      sync: async () => {},
      close: async () => {},
    };
    const fs: DurableFs = {
      ...nodeDurableFs,
      open: async path => {
        names.push(path);
        return handle;
      },
      rename: async () => {},
      syncDir: async () => {},
    };
    const path = join(dir, 'x.enc.json');
    await writeFileDurably(path, 'a', 0o600, fs);
    await writeFileDurably(path, 'b', 0o600, fs);
    assert.equal(new Set(names).size, 2);
    assert.ok(names.every(name => /\.[0-9a-f-]{36}\.tmp$/.test(name)));
  }));

test('a failed rename keeps the old file and leaves no temporary copy', () =>
  withDir(async dir => {
    const path = join(dir, 'engine-key.bin');
    await writeFile(path, 'old');
    const fs: DurableFs = {
      ...nodeDurableFs,
      rename: async () => {
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      },
    };
    await assert.rejects(writeFileDurably(path, 'new', 0o600, fs), /disk full/);
    assert.equal(await readFile(path, 'utf8'), 'old');
    assert.deepEqual(await readdir(dir), ['engine-key.bin']);
  }));

test('a failed folder flush after the rename is reported but keeps the new file', () =>
  withDir(async dir => {
    const path = join(dir, 'engine-key.bin');
    const fs: DurableFs = {
      ...nodeDurableFs,
      syncDir: async () => {
        throw Object.assign(new Error('io'), { code: 'EIO' });
      },
    };
    await assert.rejects(writeFileDurably(path, 'new', 0o600, fs), /io/);
    assert.equal(await readFile(path, 'utf8'), 'new');
  }));

test('the written file is private to the owner', () =>
  withDir(async dir => {
    const path = join(dir, 'engine-key.bin');
    await writeFileDurably(path, 'secret');
    if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
  }));

test('stale temporary copies are removed and other files stay', () =>
  withDir(async dir => {
    const path = join(dir, 'engine-key.bin');
    const uuid = '123e4567-e89b-12d3-a456-426614174000';
    await writeFile(`${path}.tmp`, 'leftover');
    await writeFile(`${path}.${uuid}.tmp`, 'leftover');
    await writeFile(join(dir, 'other.bin.tmp'), 'not ours');
    await writeFile(`${path}.backup`, 'not ours');
    await removeStaleTemporaries(path);
    assert.deepEqual((await readdir(dir)).sort(), ['engine-key.bin.backup', 'other.bin.tmp']);
  }));

test('loadDataKey writes the key durably and clears a crashed first start', () =>
  withDir(async dir => {
    await writeFile(join(dir, 'engine-key.bin.tmp'), 'half');
    const key = await loadDataKey(dir, keychain);
    assert.equal(key.length, 32);
    assert.deepEqual(await readdir(dir), ['engine-key.bin']);
    assert.deepEqual(await loadDataKey(dir, keychain), key);
  }));

test('migrating a credential file leaves no temporary copy and keeps the entries', () =>
  withDir(async dir => {
    const cipher = createCipher(await loadDataKey(dir, keychain));
    const legacy = keychain.encrypt('secret').toString('base64');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'a.enc.json'), JSON.stringify({ acct: legacy }));
    assert.equal(await migrateCredentials(dir, keychain.decrypt, cipher), 1);
    assert.deepEqual((await readdir(dir)).sort(), ['a.enc.json', 'engine-key.bin']);
    const entries = JSON.parse(await readFile(join(dir, 'a.enc.json'), 'utf8')) as Record<
      string,
      string
    >;
    assert.equal(cipher.decrypt(Buffer.from(entries.acct, 'base64')), 'secret');
  }));

test('a key file that cannot be checked is not taken for a missing one', () =>
  withDir(async dir => {
    const dataDir = join(dir, 'data');
    await loadDataKey(dataDir, keychain);
    const before = await readFile(join(dataDir, 'engine-key.bin'));
    let writes = 0;
    const fs: DurableFs = {
      ...nodeDurableFs,
      // The folder stays writable: only the check fails, the case that would orphan the sealed store.
      stat: async () => {
        throw Object.assign(new Error(`EIO: i/o error, stat '${dataDir}/engine-key.bin'`), {
          code: 'EIO',
        });
      },
      open: async (path, mode) => {
        writes++;
        return nodeDurableFs.open(path, mode);
      },
    };
    await assert.rejects(loadDataKey(dataDir, keychain, fs), (error: Error) => {
      assert.match(error.message, /could not be checked/);
      assert.ok(!error.message.includes(dataDir), 'no path in the message');
      assert.equal((error.cause as NodeJS.ErrnoException).code, 'EIO');
      return true;
    });
    assert.equal(writes, 0);
    assert.deepEqual(await readFile(join(dataDir, 'engine-key.bin')), before);
  }));

test('the key file is written with mode 0600', () =>
  withDir(async dir => {
    await loadDataKey(dir, keychain);
    if (process.platform !== 'win32')
      assert.equal((await stat(join(dir, 'engine-key.bin'))).mode & 0o777, 0o600);
  }));

test('a failed key write is a plain message with no path, and the original is the cause', () =>
  withDir(async dir => {
    const fs: DurableFs = {
      ...nodeDurableFs,
      rename: async (from, to) => {
        throw Object.assign(new Error(`ENOSPC: no space left, rename '${from}' -> '${to}'`), {
          code: 'ENOSPC',
        });
      },
    };
    await assert.rejects(loadDataKey(dir, keychain, fs), (error: Error) => {
      assert.ok(error instanceof KeyringError);
      assert.ok(!error.message.includes(dir), 'no path in the message');
      assert.ok(!error.message.includes('.tmp'), 'no temporary name in the message');
      assert.match(String((error.cause as Error).message), /ENOSPC/);
      return true;
    });
    assert.deepEqual(await readdir(dir), []);
  }));

test('a data folder that cannot be created is a plain message with no path', () =>
  withDir(async dir => {
    const blocker = join(dir, 'file');
    await writeFile(blocker, 'x');
    await assert.rejects(loadDataKey(join(blocker, 'data'), keychain), (error: Error) => {
      assert.ok(error instanceof KeyringError);
      assert.ok(!error.message.includes(dir), 'no path in the message');
      assert.ok(error.cause instanceof Error);
      return true;
    });
  }));

test('a keychain that is not available is a keyring message', async () => {
  await assert.rejects(
    loadDataKey('/nonexistent', { ...keychain, available: () => false }),
    KeyringError,
  );
});

function folder(
  log: string[],
  failWith?: string,
): (path: string) => Promise<{
  sync(): Promise<void>;
  close(): Promise<void>;
}> {
  return async () => ({
    sync: async () => {
      log.push('sync');
      if (failWith) throw Object.assign(new Error(failWith), { code: failWith });
    },
    close: async () => {
      log.push('close');
    },
  });
}

test('a folder flush that fails with an error other than the four unsupported is thrown and the handle closed', async () => {
  const log: string[] = [];
  await assert.rejects(syncFolder(folder(log, 'EIO'), '/x'), { code: 'EIO' });
  assert.deepEqual(log, ['sync', 'close']);
});

test('a folder flush that is unsupported is ignored and the handle closed', async () => {
  for (const code of ['EISDIR', 'EINVAL', 'EPERM', 'ENOTSUP']) {
    const log: string[] = [];
    await syncFolder(folder(log, code), '/x');
    assert.deepEqual(log, ['sync', 'close']);
  }
  await syncFolder(async () => {
    throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
  }, '/x');
});
