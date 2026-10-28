import type { AiKeyInfo, AiKeyStore } from '@aplos/engine/legacy/ports';
import { askProvider, askProviders, type AskProviderId } from '@aplos/contract/legacy/ask';
import { createVault, type Vault } from './vault';

/**
 * API keys typed in Settings → AI, encrypted per entry in `ai-keys.enc.json` with the same keychain-protected data key
 * as account credentials. `resolve` is what the providers call when a feature runs: a saved key wins, then the
 * provider's environment variable, so `.env`, the eval scripts and `verify-release --live-ai` keep working.
 */
export interface AiKeys extends AiKeyStore {
  resolve(provider: AskProviderId): string | undefined;
}
export interface AiKeyOptions {
  dataDir: string;
  encrypt?: (value: string) => Buffer;
  decrypt?: (value: Buffer) => string;
  env?: Record<string, string | undefined>;
}

const UNAVAILABLE =
  'Keys can only be saved in the Aplos Mail desktop app. Here, set the key in the backend environment instead.';
const known = new Set<string>(askProviders.map(p => p.id));
function provider(id: unknown): AskProviderId {
  if (typeof id !== 'string' || !known.has(id)) throw new Error('Choose an AI provider.');
  return id as AskProviderId;
}
/** A pasted key, trimmed. Keys are single tokens, so spaces or line breaks inside mean something else was pasted. */
export function cleanKey(value: unknown): string {
  const key = typeof value === 'string' ? value.trim().replace(/^Bearer\s+/i, '') : '';
  if (!key) throw new Error('Paste a key first.');
  if (key.length < 8 || key.length > 512 || /[\s\x00-\x1f\x7f]/.test(key))
    throw new Error('That doesn’t look like an API key. Copy the whole key and paste it again.');
  return key;
}

export async function createAiKeys(options: AiKeyOptions): Promise<AiKeys> {
  const env = options.env ?? process.env;
  let vault: Vault<string> | undefined, error: string | undefined;
  try {
    vault = await createVault<string>({
      dataDir: options.dataDir,
      encrypt: options.encrypt,
      decrypt: options.decrypt,
      file: 'ai-keys.enc.json',
    });
  } catch {
    error =
      'Saved AI keys could not be unlocked. Check your macOS keychain, or save the keys again.';
  }
  const secure = !!vault?.secure;
  const saved = (id: AskProviderId) => vault?.get(id) || undefined;
  const fromEnv = (id: AskProviderId) => env[askProvider(id).env]?.trim() || undefined;
  return {
    secure,
    ...(error ? { error } : {}),
    resolve: id => saved(id) ?? fromEnv(id),
    info(id): AiKeyInfo {
      const key = saved(provider(id)),
        source = key ? 'saved' : fromEnv(id) ? 'environment' : undefined;
      const active = key ?? fromEnv(id);
      // Only the last four characters ever leave this module, and only for keys long enough that they reveal nothing.
      return source
        ? { source, ...(active && active.length >= 12 ? { last4: active.slice(-4) } : {}) }
        : {};
    },
    async set(id, value) {
      const name = provider(id),
        key = cleanKey(value);
      if (!secure || !vault) throw new Error(error ?? UNAVAILABLE);
      try {
        await vault.set(name, key);
      } catch {
        throw new Error(
          'The key could not be saved securely. Check your macOS keychain and try again.',
        );
      }
    },
    async delete(id) {
      const name = provider(id);
      if (!secure || !vault) throw new Error(error ?? UNAVAILABLE);
      try {
        await vault.delete(name);
      } catch {
        throw new Error('The key could not be removed. Check the data folder and try again.');
      }
    },
  };
}
