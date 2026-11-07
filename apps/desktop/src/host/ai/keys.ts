import { existsSync, readFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { AiCallError, type AiKeySource } from '@aplos/engine';
import { providerRow } from './providers';

/**
 * The transport's key store (lane eng-ai). Two sources, env first: the provider's environment variable, then a
 * key the owner saved in Settings → AI, kept in a small JSON file at `vaultPath` (mode 0600). Keys are
 * write-only — nothing here returns or logs key characters; `keyOf` is for request headers only.
 */

export interface AiKeys {
  /** The key a request should use, or `undefined`. Internal to `src/host/ai`. */
  keyOf(provider: string): string | undefined;
  keySource(provider: string): AiKeySource;
  setKey(provider: string, key: string): Promise<AiKeySource>;
  removeKey(provider: string): Promise<AiKeySource>;
}

export interface KeysDeps {
  env: NodeJS.ProcessEnv;
  /** The saved-keys JSON file. Without it only env keys resolve and saves answer `unavailable`. */
  vaultPath?: string;
}

/** A pasted key, trimmed; keys are single tokens, so whitespace inside means something else was pasted. */
export function cleanKey(value: unknown): string {
  const key = typeof value === 'string' ? value.trim().replace(/^Bearer\s+/i, '') : '';
  if (
    !key ||
    key.length < 8 ||
    key.length > 512 ||
    [...key].some(c => c.charCodeAt(0) <= 0x1f || c.charCodeAt(0) === 0x7f || /\s/.test(c))
  )
    throw new AiCallError('invalid', 'That does not look like an API key.');
  return key;
}

export function createKeys(deps: KeysDeps): AiKeys {
  // Writes serialize on this chain so a read-modify-write can't lose a just-saved key.
  let writes: Promise<unknown> = Promise.resolve();
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = writes.then(fn, fn);
    writes = run.catch(() => {});
    return run;
  };
  const envKey = (provider: string): string | undefined => {
    const row = providerRow(provider);
    const value = row && deps.env[row.envVar]?.trim();
    return value || undefined;
  };
  /** The vault file as `{providerId: key}`; a missing or unreadable file is an empty store. */
  const readVault = (): Record<string, string> => {
    if (!deps.vaultPath || !existsSync(deps.vaultPath)) return {};
    try {
      const data = JSON.parse(readFileSync(deps.vaultPath, 'utf8')) as unknown;
      if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
      const out: Record<string, string> = {};
      for (const [id, key] of Object.entries(data))
        if (typeof key === 'string' && key) out[id] = key;
      return out;
    } catch {
      return {};
    }
  };
  const writeVault = async (map: Record<string, string>): Promise<void> => {
    if (!deps.vaultPath)
      throw new AiCallError(
        'unavailable',
        'Keys can only be saved where the sealed store is mounted.',
      );
    await fs.mkdir(dirname(deps.vaultPath), { recursive: true, mode: 0o700 });
    // Temp file + rename: a crash mid-write can never leave a half-written vault.
    const tmp = `${deps.vaultPath}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(map), { mode: 0o600 });
    await fs.rename(tmp, deps.vaultPath);
    await fs.chmod(deps.vaultPath, 0o600).catch(() => {});
  };
  const keySource = (provider: string): AiKeySource => {
    if (envKey(provider)) return 'env';
    return readVault()[provider] ? 'keychain' : 'none';
  };
  return {
    keyOf: provider => envKey(provider) ?? readVault()[provider],
    keySource,
    async setKey(provider, key) {
      if (!providerRow(provider))
        throw new AiCallError('noProvider', 'That AI provider is not known.');
      return serialize(async () => {
        const map = readVault();
        map[provider] = cleanKey(key);
        await writeVault(map);
        return keySource(provider);
      });
    },
    async removeKey(provider) {
      if (!providerRow(provider))
        throw new AiCallError('noProvider', 'That AI provider is not known.');
      await serialize(async () => {
        const map = readVault();
        if (provider in map) {
          delete map[provider];
          await writeVault(map);
        }
      });
      return keySource(provider);
      // An environment key cannot be removed here; the source stays 'env'.
      return keySource(provider);
    },
  };
}
