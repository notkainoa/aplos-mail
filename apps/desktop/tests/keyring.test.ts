import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCipher, isSealed, loadDataKey, migrateCredentials } from '../src/main/keyring';

const keychain = {
  available: () => true,
  encrypt: (v: string) => Buffer.from(`kc:${v}`),
  decrypt: (b: Buffer) => {
    const v = b.toString();
    if (!v.startsWith('kc:')) throw new Error('bad');
    return v.slice(3);
  },
};

test('a custom data folder that does not exist yet is created for the key', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aplos-keyring-dir-'));
  try {
    const dataDir = join(root, 'nested', 'data');
    const key = await loadDataKey(dataDir, keychain);
    assert.equal(key.length, 32);
    assert.ok(existsSync(join(dataDir, 'engine-key.bin')));
    if (process.platform !== 'win32') assert.equal((await stat(dataDir)).mode & 0o777, 0o700);
    assert.deepEqual(await loadDataKey(dataDir, keychain), key);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('one credential file that cannot be migrated does not stop the others', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'aplos-keyring-partial-'));
  try {
    const cipher = createCipher(await loadDataKey(dataDir, keychain));
    await writeFile(
      join(dataDir, 'good.enc.json'),
      JSON.stringify({ acct: keychain.encrypt('secret').toString('base64') }),
    );
    await writeFile(join(dataDir, 'corrupt.enc.json'), '{not json');
    // A directory named like a credential file cannot be read, like a file the process lacks access to.
    await mkdir(join(dataDir, 'blocked.enc.json'));
    const failed: string[] = [];
    assert.equal(
      await migrateCredentials(dataDir, keychain.decrypt, cipher, file => failed.push(file)),
      1,
    );
    assert.deepEqual(failed.sort(), ['blocked.enc.json', 'corrupt.enc.json']);
    const sealed = Buffer.from(
      JSON.parse(await readFile(join(dataDir, 'good.enc.json'), 'utf8')).acct,
      'base64',
    );
    assert.ok(isSealed(sealed));
    assert.equal(cipher.decrypt(sealed), 'secret');
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
