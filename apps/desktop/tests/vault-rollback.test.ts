import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVault } from '../src/main/vault';

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
