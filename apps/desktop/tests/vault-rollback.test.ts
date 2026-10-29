import test from 'node:test';
import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVault, type VaultFs } from '../src/main/vault';

// A keychain that cannot encrypt the value `{"v":2}`, so saving it fails while any other value saves.
const crypto = {
  encrypt: (text: string) => {
    if (text.includes('"v":2')) throw new Error('keychain locked');
    return Buffer.from(text, 'utf8');
  },
  decrypt: (data: Buffer) => data.toString('utf8'),
};

async function withVault(run: (vault: Awaited<ReturnType<typeof open>>) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'aplos-vault-'));
  try {
    await run(await open(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const open = (dir: string) => createVault<{ v: number }>({ dataDir: dir, ...crypto });

test('a failed save rolls back to the previous value', async () => {
  await withVault(async vault => {
    await vault.set('a', { v: 1 });
    await assert.rejects(vault.set('a', { v: 2 }));
    assert.deepEqual(vault.get('a'), { v: 1 });
    await assert.rejects(vault.set('b', { v: 2 }));
    assert.equal(vault.get('b'), undefined);
  });
});

test('a failed save does not overwrite a value that was saved after it', async () => {
  await withVault(async vault => {
    await vault.set('a', { v: 1 });
    const failing = vault.set('a', { v: 2 });
    const later = vault.set('a', { v: 3 });
    await assert.rejects(failing);
    await later;
    assert.deepEqual(vault.get('a'), { v: 3 });
  });
});

/** The real file system, except the next `failWrites` writes of the temporary file fail. */
function flakyFs() {
  const plan = { failWrites: 0 };
  const fs: VaultFs = {
    mkdir: (path, options) => nodeFs.mkdir(path, options),
    readFile: (path, encoding) => nodeFs.readFile(path, encoding),
    rename: (from, to) => nodeFs.rename(from, to),
    writeFile: async (path, data, options) => {
      if (plan.failWrites > 0) {
        plan.failWrites -= 1;
        throw new Error('disk full');
      }
      await nodeFs.writeFile(path, data, options);
    },
  };
  return { fs, plan };
}

async function withDir(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'aplos-vault-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const unsaved = { message: /could not be saved securely/ };

test('a failed save of the same string as a later successful one does not roll memory back', async () => {
  await withDir(async dir => {
    const { fs, plan } = flakyFs();
    const vault = await createVault<string>({ dataDir: dir, ...crypto, fs });
    await vault.set('a', 'old');
    plan.failWrites = 1;
    const failing = vault.set('a', 'new');
    const later = vault.set('a', 'new');
    await assert.rejects(failing, unsaved);
    await later;
    assert.equal(vault.get('a'), 'new');
    const reloaded = await createVault<string>({ dataDir: dir, ...crypto });
    assert.equal(reloaded.get('a'), 'new');
  });
});

test('a failed save never reaches the disk through another entry’s queued save', async () => {
  await withDir(async dir => {
    const { fs, plan } = flakyFs();
    const vault = await createVault<{ v: number }>({ dataDir: dir, ...crypto, fs });
    await vault.set('a', { v: 1 });
    plan.failWrites = 1;
    const failing = vault.set('a', { v: 9 });
    const queued = vault.set('b', { v: 3 });
    await assert.rejects(failing, unsaved);
    await queued;
    assert.deepEqual(vault.get('a'), { v: 1 });
    const reloaded = await open(dir);
    assert.deepEqual(reloaded.get('a'), { v: 1 });
    assert.deepEqual(reloaded.get('b'), { v: 3 });
  });
});

test('a failed delete rolls back', async () => {
  await withDir(async dir => {
    const { fs, plan } = flakyFs();
    const vault = await createVault<{ v: number }>({ dataDir: dir, ...crypto, fs });
    await vault.set('a', { v: 1 });
    plan.failWrites = 1;
    await assert.rejects(vault.delete('a'), unsaved);
    assert.deepEqual(vault.get('a'), { v: 1 });
    assert.deepEqual((await open(dir)).get('a'), { v: 1 });
  });
});

test('a delete queued behind a failing delete still deletes', async () => {
  await withDir(async dir => {
    const { fs, plan } = flakyFs();
    const vault = await createVault<{ v: number }>({ dataDir: dir, ...crypto, fs });
    await vault.set('a', { v: 1 });
    plan.failWrites = 1;
    const failing = vault.delete('a');
    const later = vault.delete('a');
    await assert.rejects(failing, unsaved);
    await later;
    assert.equal(vault.get('a'), undefined);
    assert.equal((await open(dir)).get('a'), undefined);
  });
});

test('a real write failure keeps the saved value in memory and on disk', async () => {
  await withDir(async dir => {
    const vault = await open(dir);
    await vault.set('a', { v: 1 });
    // A directory where the temporary file goes: the write fails with EISDIR, even for root.
    await nodeFs.mkdir(join(dir, 'credentials.enc.json.tmp'));
    await assert.rejects(vault.set('a', { v: 5 }), unsaved);
    assert.deepEqual(vault.get('a'), { v: 1 });
    assert.deepEqual((await open(dir)).get('a'), { v: 1 });
    await rm(join(dir, 'credentials.enc.json.tmp'), { recursive: true });
    await vault.set('a', { v: 6 });
    assert.deepEqual((await open(dir)).get('a'), { v: 6 });
  });
});

test('a real rename failure keeps the saved value, and the next save writes it again', async () => {
  await withDir(async dir => {
    const vault = await open(dir);
    await vault.set('a', { v: 1 });
    // A directory in place of the vault file: renaming the temporary file onto it fails.
    const file = join(dir, 'credentials.enc.json');
    await rm(file);
    await nodeFs.mkdir(join(file, 'blocker'), { recursive: true });
    await assert.rejects(vault.set('a', { v: 5 }), unsaved);
    assert.deepEqual(vault.get('a'), { v: 1 });
    await rm(file, { recursive: true });
    await vault.set('b', { v: 3 });
    const reloaded = await open(dir);
    assert.deepEqual(reloaded.get('a'), { v: 1 });
    assert.deepEqual(reloaded.get('b'), { v: 3 });
  });
});
