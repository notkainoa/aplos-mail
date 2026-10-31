import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  nodeDurableFs,
  removeStaleTemporaries,
  writeFileDurably,
  type DurableFs,
} from '../../src/main/durable-file';
import { createCipher, loadDataKey, migrateCredentials } from '../../src/main/keyring';

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

test('a durable write flushes the file, renames it, then flushes the folder', () =>
  withDir(async dir => {
    const calls: string[] = [];
    const fs: DurableFs = {
      writeSynced: async (path, data, mode) => {
        calls.push(`write ${mode.toString(8)}`);
        await nodeDurableFs.writeSynced(path, data, mode);
      },
      rename: async (from, to) => {
        calls.push('rename');
        await nodeDurableFs.rename(from, to);
      },
      syncDir: async path => {
        calls.push('syncDir');
        await nodeDurableFs.syncDir(path);
      },
      remove: nodeDurableFs.remove,
    };
    const path = join(dir, 'engine-key.bin');
    await writeFileDurably(path, 'new', 0o600, fs);
    assert.deepEqual(calls, ['write 600', 'rename', 'syncDir']);
    assert.equal(await readFile(path, 'utf8'), 'new');
    assert.deepEqual(await readdir(dir), ['engine-key.bin']);
  }));

test('each write uses a temporary name of its own', () =>
  withDir(async dir => {
    const names: string[] = [];
    const fs: DurableFs = { ...nodeDurableFs, writeSynced: async path => void names.push(path) };
    const path = join(dir, 'x.enc.json');
    await writeFileDurably(path, 'a', 0o600, { ...fs, rename: async () => {} }).catch(() => {});
    await writeFileDurably(path, 'b', 0o600, { ...fs, rename: async () => {} }).catch(() => {});
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

test(
  'a key file that cannot be checked is not taken for a missing one',
  {
    skip: process.platform === 'win32' || process.getuid?.() === 0,
  },
  () =>
    withDir(async dir => {
      const dataDir = join(dir, 'data');
      await loadDataKey(dataDir, keychain);
      const before = await readFile(join(dataDir, 'engine-key.bin'));
      await chmod(dataDir, 0o000);
      try {
        await assert.rejects(loadDataKey(dataDir, keychain), /EACCES/);
      } finally {
        await chmod(dataDir, 0o700);
      }
      assert.deepEqual(await readFile(join(dataDir, 'engine-key.bin')), before);
    }),
);
