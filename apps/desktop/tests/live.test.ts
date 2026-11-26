import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCipher, isSealed, loadDataKey, migrateCredentials } from '../src/main/keyring';
import { createVault } from '../src/main/vault';

const temp = (name: string) => mkdtemp(join(tmpdir(), `aplos-${name}-`));

test('the credential key is created once, never replaced, and old keychain-sealed credentials are re-sealed', async () => {
  const dataDir = await temp('keyring');
  try {
    // A stand-in keychain: reversible, and lockable like a real one.
    let locked = false;
    const keychain = {
      available: () => true,
      encrypt: (v: string) => Buffer.from(`kc:${v}`),
      decrypt: (b: Buffer) => {
        if (locked) throw new Error('locked');
        const v = b.toString();
        if (!v.startsWith('kc:')) throw new Error('bad');
        return v.slice(3);
      },
    };
    const key = await loadDataKey(dataDir, keychain);
    assert.deepEqual(await loadDataKey(dataDir, keychain), key, 'the same key on every start');
    const before = await readFile(join(dataDir, 'engine-key.bin'));
    locked = true;
    await assert.rejects(loadDataKey(dataDir, keychain), /Unlock/);
    assert.deepEqual(
      await readFile(join(dataDir, 'engine-key.bin')),
      before,
      'a locked keychain does not replace the key file',
    );
    locked = false;
    const cipher = createCipher(key);
    // A vault written the old way, with one entry the keychain can no longer open.
    const legacy = await createVault<string>({
      dataDir,
      encrypt: keychain.encrypt,
      decrypt: keychain.decrypt,
      file: 'imap-credentials.enc.json',
    });
    await legacy.set('acct', 'app-password');
    const raw = JSON.parse(await readFile(join(dataDir, 'imap-credentials.enc.json'), 'utf8'));
    raw.broken = Buffer.from('not openable').toString('base64');
    await writeFile(join(dataDir, 'imap-credentials.enc.json'), JSON.stringify(raw));
    assert.equal(await migrateCredentials(dataDir, keychain.decrypt, cipher), 1);
    const sealed = JSON.parse(await readFile(join(dataDir, 'imap-credentials.enc.json'), 'utf8'));
    assert.ok(isSealed(Buffer.from(sealed.acct, 'base64')));
    assert.equal(sealed.broken, raw.broken, 'unreadable entries are kept as they were');
    assert.equal(
      await migrateCredentials(dataDir, keychain.decrypt, cipher),
      0,
      'migration runs once',
    );
    const vault = await createVault<string>({
      dataDir,
      encrypt: cipher.encrypt,
      decrypt: cipher.decrypt,
      file: 'jmap-credentials.enc.json',
    });
    await vault.set('acct', 'token');
    const reopened = await createVault<string>({
      dataDir,
      encrypt: cipher.encrypt,
      decrypt: cipher.decrypt,
      file: 'jmap-credentials.enc.json',
    });
    assert.equal(reopened.get('acct'), 'token');
    const tampered = Buffer.from(sealed.acct, 'base64');
    tampered[tampered.length - 1] ^= 1;
    assert.throws(() => cipher.decrypt(tampered));
    assert.ok(existsSync(join(dataDir, 'engine-key.bin')));
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
