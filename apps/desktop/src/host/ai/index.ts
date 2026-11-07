import { AiCallError, type AiTransport } from '@aplos/engine';
import { createKeys, type AiKeys } from './keys';
import type { ProviderRow } from './providers';
import { callProvider, requireRow, type AiDeps } from './request';

/**
 * The host's AI transport (lane eng-ai): the `AiTransport` port bound to real fetch, environment and the
 * saved-keys vault. One attempt per call — retry and backoff are the engine's. Keys are resolved per request,
 * never logged and never returned; addresses for local servers come from the owner's settings (injected) or
 * the matching environment variable.
 */

export interface AiHostDeps extends AiDeps {
  /** The saved-keys JSON file (mode 0600). Without it only env keys resolve and `setKey` answers `unavailable`. */
  vaultPath?: string;
}

export function createAiHost(deps: AiHostDeps): AiTransport {
  const keys = createKeys(deps);
  return {
    async chat(req) {
      const row = requireRow(req.model.provider);
      return row.wire === 'anthropic'
        ? (await import('./anthropic')).anthropicChat(deps, keys, row, req)
        : (await import('./chat')).openAiChat(deps, keys, row, req);
    },
    transcribe: async req =>
      (await import('./transcribe')).transcribeAudio(
        deps,
        keys,
        requireRow(req.model.provider),
        req,
      ),
    models: async provider => listModels(deps, keys, requireRow(provider)),
    check: async provider => checkProvider(deps, keys, requireRow(provider)),
    setKey: (provider, key) => keys.setKey(provider, key),
    removeKey: provider => keys.removeKey(provider),
    keySource: provider => keys.keySource(provider),
  };
}

/**
 * One cheap authenticated request. Most providers answer GET /models; a plan whose model list needs no key
 * (OpenCode Go) gets a one-token completion instead, which proves the key works.
 */
async function checkProvider(deps: AiDeps, keys: AiKeys, row: ProviderRow): Promise<void> {
  if (row.check === 'completion') {
    await callProvider(deps, keys, row, 'chat/completions', {
      body: JSON.stringify({
        model: row.checkModel,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'Hi' }],
      }),
      timeoutMs: 20_000,
    });
    return;
  }
  await callProvider(deps, keys, row, row.modelsUrl ?? 'models', {
    method: 'GET',
    json: false,
    timeoutMs: 20_000,
  });
}

/**
 * The provider's live model list. Where the list cannot be answered — a missing key, an unreachable local
 * server, an endpoint that does not exist — the caller falls back to its curated table, so this resolves
 * `{list: [], live: false}` rather than rejecting.
 */
async function listModels(
  deps: AiDeps,
  keys: AiKeys,
  row: ProviderRow,
): Promise<{ list: string[]; live: boolean }> {
  try {
    const response = await callProvider(deps, keys, row, row.modelsUrl ?? 'models', {
      method: 'GET',
      json: false,
      timeoutMs: 15_000,
    });
    const data = ((await response.json()) as { data?: Array<{ id?: unknown }> }).data ?? [];
    const list = data
      .map(model => String(model.id ?? '').replace(/^models\//, ''))
      .filter(id => id && (!row.keepModel || row.keepModel.test(id)));
    return { list, live: true };
  } catch (error) {
    if (error instanceof AiCallError && error.code === 'noProvider') throw error;
    return { list: [], live: false };
  }
}
