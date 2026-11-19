import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  nodeDurableFs,
  removeStaleTemporaries,
  writeFileDurably,
  type DurableFs,
} from './durable-file';

/**
 * Credentials are sealed with a random data key (AES-256-GCM) instead of the OS keychain directly,
 * because the engine runs in a process that cannot reach the keychain. The keychain protects the data
 * key itself, in `engine-key.bin`; the main process unwraps it and hands it to the engine at start.
 */
const MAGIC = Buffer.from('APK1');
const KEY_FILE = 'engine-key.bin';

/**
 * An error whose message is safe to show in the window: plain words, no path, no key material. The original error
 * (which may name the data folder) travels as `cause` for the log only.
 */
export class KeyringError extends Error {
  override readonly name = 'KeyringError';
}

export interface Cipher {
  encrypt(text: string): Buffer;
  decrypt(sealed: Buffer): string;
}
/** The OS keychain as Electron's safeStorage exposes it. */
export interface Keychain {
  available(): boolean;
  encrypt(text: string): Buffer;
  decrypt(cipher: Buffer): string;
}

export const isSealed = (value: Buffer) =>
  value.length >= MAGIC.length + 28 && value.subarray(0, MAGIC.length).equals(MAGIC);

export function createCipher(key: Uint8Array): Cipher {
  if (key.byteLength !== 32) throw new Error('The credential key is damaged.');
  const secret = Buffer.from(key);
  return {
    encrypt(text) {
      const iv = randomBytes(12),
        cipher = createCipheriv('aes-256-gcm', secret, iv);
      const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
    },
    decrypt(sealed) {
      if (!isSealed(sealed))
        throw new Error('Saved account credentials could not be unlocked. Reconnect the account.');
      const iv = sealed.subarray(4, 16),
        tag = sealed.subarray(16, 32),
        decipher = createDecipheriv('aes-256-gcm', secret, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(sealed.subarray(32)), decipher.final()]).toString(
        'utf8',
      );
    },
  };
}

/**
 * Only a missing file means there is no key. Any other error stops the start: a new key over a key that could not be
 * checked would leave every saved credential unreadable. The message carries no path (it reaches the window); the
 * original error is the `cause`.
 */
async function keyFileExists(path: string, fs: DurableFs): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new KeyringError(
      'The credential key could not be checked. Restart Aplos Mail or check the data folder.',
      { cause: error },
    );
  }
}

/**
 * The data key, created on first use. An existing key file is never replaced, even when it cannot be
 * read right now (a locked keychain), because replacing it would make every saved credential unreadable.
 */
export async function loadDataKey(
  dataDir: string,
  keychain: Keychain,
  fs: DurableFs = nodeDurableFs,
): Promise<Buffer> {
  if (!keychain.available())
    throw new KeyringError('macOS secure credential storage is unavailable.');
  await mkdir(dataDir, { recursive: true, mode: 0o700 }).catch(error => {
    throw new KeyringError('The data folder could not be prepared. Check the data folder.', {
      cause: error,
    });
  });
  const path = join(dataDir, KEY_FILE);
  await removeStaleTemporaries(path, fs);
  if (await keyFileExists(path, fs)) {
    let key: Buffer;
    try {
      key = Buffer.from(keychain.decrypt(await readFile(path)), 'base64');
    } catch {
      throw new KeyringError('Unlock macOS secure credential storage to use your accounts.');
    }
    if (key.length !== 32)
      throw new KeyringError('The credential key is damaged. Reconnect your accounts.');
    return key;
  }
  const key = randomBytes(32);
  try {
    await writeFileDurably(path, keychain.encrypt(key.toString('base64')), 0o600, fs);
  } catch (error) {
    throw new KeyringError(
      'The credential key could not be saved. Check free disk space and the data folder.',
      { cause: error },
    );
  }
  return key;
}

/**
 * Re-seal credential files written before the data key existed. Entries the keychain cannot open stay
 * as they are, so the account asks to reconnect instead of losing the evidence. A file that cannot be
 * read or rewritten is reported through `failed` and skipped; the other files still migrate.
 */
export async function migrateCredentials(
  dataDir: string,
  legacy: (cipher: Buffer) => string,
  cipher: Cipher,
  failed: (file: string, error: unknown) => void = () => {},
): Promise<number> {
  let names: string[] = [];
  try {
    names = (await readdir(dataDir)).filter(name => name.endsWith('.enc.json'));
  } catch {
    return 0;
  }
  let migrated = 0;
  for (const name of names) {
    const path = join(dataDir, name);
    try {
      const entries = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      if (!entries || typeof entries !== 'object') throw new Error('Not a credential file.');
      let changed = 0;
      for (const [id, value] of Object.entries(entries)) {
        if (typeof value !== 'string') continue;
        const raw = Buffer.from(value, 'base64');
        if (isSealed(raw)) continue;
        try {
          entries[id] = cipher.encrypt(legacy(raw)).toString('base64');
          changed++;
        } catch {
          /* Left for the account to report. */
        }
      }
      if (changed) {
        await writeFileDurably(path, JSON.stringify(entries));
        migrated += changed;
      }
    } catch (error) {
      failed(name, error);
    }
  }
  return migrated;
}
