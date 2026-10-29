import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface VaultOptions {
  dataDir: string;
  encrypt?: (value: string) => Buffer;
  decrypt?: (value: Buffer) => string;
  file?: string;
}

/**
 * Account secrets (app passwords, API tokens, OAuth tokens) encrypted with the OS keychain key.
 * Each entry is encrypted on its own so one unreadable entry does not lock the others.
 */
export interface Vault<T> {
  readonly secure: boolean;
  get(id: string): T | undefined;
  set(id: string, value: T): Promise<void>;
  delete(id: string): Promise<void>;
}

export async function createVault<T>(options: VaultOptions): Promise<Vault<T>> {
  const path = join(options.dataDir, options.file ?? 'credentials.enc.json');
  const entries = new Map<string, T>();
  let chain = Promise.resolve();
  if (options.decrypt) {
    let encrypted: Record<string, string> = {};
    try {
      encrypted = JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error('Saved account credentials could not be read. Check the data directory.');
    }
    for (const [id, value] of Object.entries(encrypted)) {
      try {
        entries.set(id, JSON.parse(options.decrypt(Buffer.from(value, 'base64'))) as T);
      } catch {
        throw new Error(
          'Saved account credentials could not be unlocked. Check your macOS keychain.',
        );
      }
    }
  }
  async function persist() {
    if (!options.encrypt)
      throw new Error('Secure credential storage is unavailable. Connect using the desktop app.');
    let snapshot: string;
    try {
      snapshot = JSON.stringify(
        Object.fromEntries(
          [...entries].map(([id, value]) => [
            id,
            options.encrypt!(JSON.stringify(value)).toString('base64'),
          ]),
        ),
      );
    } catch {
      throw new Error('Account credentials could not be encrypted. Check your macOS keychain.');
    }
    const operation = chain.then(async () => {
      await mkdir(options.dataDir, { recursive: true, mode: 0o700 });
      await writeFile(`${path}.tmp`, snapshot, { mode: 0o600 });
      await rename(`${path}.tmp`, path);
    });
    chain = operation.catch(() => {});
    try {
      await operation;
    } catch {
      throw new Error('Account credentials could not be saved securely. Check the data directory.');
    }
  }
  return {
    secure: Boolean(options.encrypt && options.decrypt),
    get: id => entries.get(id),
    async set(id, value) {
      const previous = entries.get(id);
      entries.set(id, value);
      try {
        await persist();
      } catch (error) {
        // Roll back only while the entry is still the value that failed to persist: a concurrent save that
        // succeeded in the meantime must not be overwritten.
        if (entries.get(id) === value) {
          if (previous === undefined) entries.delete(id);
          else entries.set(id, previous);
        }
        throw error;
      }
    },
    async delete(id) {
      if (!entries.has(id)) return;
      entries.delete(id);
      await persist();
    },
  };
}
