import type { ChatProvider } from '@aplos/engine/legacy/ports';
import type { AskModelInfo, AskProviderId } from '@aplos/contract/legacy/ask';
import { askProvider, voiceProviders } from '@aplos/contract/legacy/ask';
import {
  checkKey,
  providerRequest,
  readKey,
  streamChat,
  transcribeAudio,
  type ApiKey,
  type ProviderTarget,
  type StreamOptions,
} from './llm';

/** The providers besides Groq and Claude. All speak OpenAI-compatible chat/completions with streamed tool calls. */
/** `apiKey` is a key or a resolver read per request; without one the provider's environment variable is used. */
export interface ProviderOptions {
  apiKey?: ApiKey;
  fetch?: typeof fetch;
  version?: string;
}

/** Model lists change rarely; refresh at most hourly and fall back to the curated list offline. */
function cached(load: (signal?: AbortSignal) => Promise<AskModelInfo[]>, ttl = 60 * 60_000) {
  // A failed load is not cached, so the next open tries again.
  let value: { at: number; models: AskModelInfo[] } | undefined;
  return async (signal?: AbortSignal) => {
    if (value && Date.now() - value.at < ttl) return value.models;
    const models = await load(signal);
    value = { at: Date.now(), models };
    return models;
  };
}
const perMillion = (price: unknown) => {
  const n = Number(price) * 1e6;
  return Number.isFinite(n)
    ? (n < 1 ? n.toFixed(2) : n.toFixed(n < 10 ? 1 : 0)).replace(/\.0+$/, '')
    : '';
};

export function createOpenRouter(options: ProviderOptions = {}): ChatProvider {
  const apiKey = () => readKey(options.apiKey, 'OPENROUTER_API_KEY'),
    request = options.fetch ?? fetch;
  // Attribution headers are optional; they name the app on OpenRouter's side and carry no user data.
  const target: ProviderTarget = {
    name: 'OpenRouter',
    env: 'OPENROUTER_API_KEY',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey,
    fetch: request,
    headers: { 'X-OpenRouter-Title': 'Aplos Mail' },
  };
  const curated = askProvider('openrouter').models;
  return {
    get available() {
      return !!apiKey();
    },
    // The model list is public, so the key is checked against OpenRouter's key endpoint instead.
    check: signal => checkKey(target, 'key', {}, signal),
    chat: streamChat(
      (path, body, signal, headers) =>
        providerRequest(target, path, body, signal, true, 'POST', headers),
      { name: 'OpenRouter', maxTokens: 4096 },
    ),
    // The public catalog; only models that accept tools can run Ask.
    models: cached(async signal => {
      const response = await request('https://openrouter.ai/api/v1/models', {
        signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]),
      });
      if (!response.ok) throw new Error('OpenRouter models are unavailable.');
      const data =
        (
          (await response.json()) as {
            data?: Array<{
              id?: unknown;
              name?: unknown;
              supported_parameters?: unknown;
              pricing?: { prompt?: unknown; completion?: unknown };
            }>;
          }
        ).data ?? [];
      const live = data
        .filter(
          m =>
            typeof m.id === 'string' &&
            Array.isArray(m.supported_parameters) &&
            m.supported_parameters.includes('tools'),
        )
        .map((m): AskModelInfo => {
          const known = curated.find(c => c.id === m.id),
            price = perMillion(m.pricing?.prompt),
            out = perMillion(m.pricing?.completion);
          return {
            id: String(m.id),
            label: known?.label ?? String(m.name ?? m.id).replace(/^[^:]+:\s*/, ''),
            description:
              known?.description ??
              (price && out ? `$${price} in · $${out} out per million tokens` : undefined),
          };
        });
      return [
        ...curated
          .filter(c => live.some(m => m.id === c.id))
          .map(c => live.find(m => m.id === c.id)!),
        ...live
          .filter(m => !curated.some(c => c.id === m.id))
          .sort((a, b) => a.id.localeCompare(b.id)),
      ];
    }),
  };
}

export function createOpenCodeGo(options: ProviderOptions = {}): ChatProvider {
  const apiKey = () => readKey(options.apiKey, 'OPENCODE_API_KEY'),
    request = options.fetch ?? fetch;
  // OpenCode asks Go clients to name themselves and send a stable session ID per conversation (routing and caching).
  const target: ProviderTarget = {
    name: 'OpenCode Go',
    env: 'OPENCODE_API_KEY',
    baseUrl: 'https://opencode.ai/inference/go/openai/v1',
    apiKey,
    fetch: request,
    headers: { 'User-Agent': `aplos-mail/${options.version ?? '0.1.0'}` },
  };
  const curated = askProvider('opencode-go').models;
  return {
    get available() {
      return !!apiKey();
    },
    // Go's model list needs no key, so the check is one tiny completion on the plan's first model.
    check: signal =>
      checkKey(
        target,
        'chat/completions',
        {
          method: 'POST',
          body: {
            model: curated[0]?.id,
            max_tokens: 1,
            messages: [{ role: 'user', content: 'Hi' }],
          },
        },
        signal,
      ),
    chat: streamChat(
      (path, body, signal, headers) =>
        providerRequest(target, path, body, signal, true, 'POST', headers),
      {
        name: 'OpenCode Go',
        maxTokens: 4096,
        headers: (request): Record<string, string> =>
          request.session ? { 'x-opencode-session': request.session } : {},
      },
    ),
    // Go's catalog also lists models that need other APIs, so only the chat/completions ones it still offers are shown.
    models: cached(async signal => {
      const response = await request('https://opencode.ai/inference/go/v1/models', {
        headers: { 'User-Agent': target.headers!['User-Agent'] },
        signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]),
      });
      if (!response.ok) throw new Error('OpenCode Go models are unavailable.');
      const ids = new Set(
        (((await response.json()) as { data?: Array<{ id?: unknown }> }).data ?? []).map(m => m.id),
      );
      return curated.filter(m => ids.has(m.id));
    }),
  };
}

/**
 * A provider whose chat/completions speaks the OpenAI dialect, with its model list from GET /models.
 * `keep` picks the chat models out of that list; curated ones come first with their descriptions.
 */
function compatible(
  target: ProviderTarget & { fetch: typeof fetch },
  id: AskProviderId,
  {
    keep = () => true,
    voice,
    stream = {},
  }: {
    keep?: (id: string) => boolean;
    voice?: (id: string) => boolean;
    stream?: Omit<StreamOptions, 'name'>;
  } = {},
): ChatProvider {
  const curated = askProvider(id).models;
  const ids = cached(async signal => {
    const response = await providerRequest(target, 'models', undefined, signal, false, 'GET');
    return (((await response.json()) as { data?: Array<{ id?: unknown }> }).data ?? [])
      .map(m => String(m.id ?? '').replace(/^models\//, ''))
      .filter(Boolean)
      .map(m => ({ id: m, label: m }));
  }, 10 * 60_000);
  const listed = (curated: readonly AskModelInfo[], live: AskModelInfo[]) => [
    ...curated.filter(c => live.some(m => m.id === c.id)),
    ...live.filter(m => !curated.some(c => c.id === m.id)).sort((a, b) => a.id.localeCompare(b.id)),
  ];
  const send = (path: string, body: BodyInit | undefined, signal?: AbortSignal, json = true) =>
    providerRequest(target, path, body, signal, json);
  return {
    get available() {
      return !!readKey(target.apiKey ?? '', target.env) || !!target.keyOptional;
    },
    check: signal => checkKey(target, 'models', {}, signal),
    chat: streamChat(
      (path, body, signal, headers) =>
        providerRequest(target, path, body, signal, true, 'POST', headers),
      { name: target.name, maxTokens: 4096, ...stream },
    ),
    models: async signal =>
      listed(
        curated,
        (await ids(signal)).filter(m => keep(m.id)),
      ),
    ...(voice
      ? {
          transcribe: (audio: string, mimeType: string, model: string, signal?: AbortSignal) =>
            transcribeAudio(send, audio, mimeType, model, target.name, signal),
          voiceModels: async (signal?: AbortSignal) =>
            listed(
              voiceProviders[id] ?? [],
              (await ids(signal)).filter(m => voice(m.id)),
            ),
        }
      : {}),
  };
}

/** ChatGPT models through the OpenAI API. Its reasoning models reject a temperature, so none is sent. */
export function createOpenAI(options: ProviderOptions = {}): ChatProvider {
  const request = options.fetch ?? fetch;
  return compatible(
    {
      name: 'OpenAI',
      env: 'OPENAI_API_KEY',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: () => readKey(options.apiKey, 'OPENAI_API_KEY'),
      fetch: request,
    },
    'openai',
    {
      keep: id =>
        /^(gpt-|o\d|chatgpt-)/.test(id) &&
        !/(audio|realtime|image|tts|transcribe|search|embedding|moderation|instruct)/.test(id),
      // Speech-to-text models for Voice; diarizing variants answer in another shape.
      voice: id => /(transcribe|whisper)/.test(id) && !/(realtime|diarize)/.test(id),
      stream: { temperature: null, jsonMode: true, extra: () => ({ reasoning_effort: 'low' }) },
    },
  );
}

/** Gemini through Google's OpenAI-compatible endpoint, which takes the API key as a bearer token. */
export function createGemini(options: ProviderOptions = {}): ChatProvider {
  const request = options.fetch ?? fetch;
  return compatible(
    {
      name: 'Gemini',
      env: 'GEMINI_API_KEY',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      apiKey: () => readKey(options.apiKey, 'GEMINI_API_KEY'),
      fetch: request,
    },
    'gemini',
    {
      keep: id => /^gemini-/.test(id) && !/(embedding|image|tts|live|audio)/.test(id),
      // Gemini's OpenAI endpoint documents schema-based structured output, not JSON mode, so JSON comes from the prompt.
      stream: { extra: () => ({ reasoning_effort: 'low' }) },
    },
  );
}

/** Any OpenAI-compatible server at an address the owner chose in Settings (vLLM, llama.cpp, a proxy…). */
export function createCustom(baseUrl: string, options: ProviderOptions = {}): ChatProvider {
  const request = options.fetch ?? fetch;
  return compatible(
    {
      name: 'Your AI server',
      env: 'CUSTOM_AI_API_KEY',
      baseUrl: baseUrl.replace(/\/+$/, ''),
      apiKey: () => readKey(options.apiKey, 'CUSTOM_AI_API_KEY'),
      keyOptional: true,
      fetch: request,
    },
    'custom',
  );
}

/**
 * LM Studio. Chat goes through its OpenAI-compatible /v1/chat/completions (its native chat API has no custom tools);
 * the model list comes from the native /api/v1/models, keeping language models trained for tool use. Requests for an
 * unloaded model load it on demand. Auth is off by default; a token from Server Settings goes in LM_STUDIO_API_KEY.
 */
export function createLmStudio(baseUrl: string, options: ProviderOptions = {}): ChatProvider {
  const request = options.fetch ?? fetch,
    root = baseUrl.replace(/\/+$/, '').replace(/\/v1$/, ''),
    apiKey = () => readKey(options.apiKey, 'LM_STUDIO_API_KEY');
  const target: ProviderTarget = {
    name: 'LM Studio',
    env: 'LM_STUDIO_API_KEY',
    baseUrl: `${root}/v1`,
    apiKey,
    keyOptional: true,
    fetch: request,
    offline: `LM Studio isn’t answering at ${root.replace(/^https?:\/\//, '')}. Open LM Studio and start its server, or change its address in Settings → AI.`,
  };
  const auth = (): Record<string, string> => {
    const key = apiKey();
    return key ? { Authorization: `Bearer ${key}` } : {};
  };
  return {
    available: true,
    check: signal => checkKey(target, 'models', {}, signal),
    async status(signal) {
      try {
        const response = await request(`${root}/v1/models`, {
          headers: auth(),
          signal: AbortSignal.any([AbortSignal.timeout(3_000), ...(signal ? [signal] : [])]),
        });
        return { running: response.ok };
      } catch {
        return { running: false };
      }
    },
    chat: streamChat(
      (path, body, signal, headers) =>
        providerRequest(target, path, body, signal, true, 'POST', headers),
      { name: 'LM Studio', maxTokens: 4096 },
    ),
    models: async signal => {
      const response = await request(`${root}/api/v1/models`, {
        headers: auth(),
        signal: AbortSignal.any([AbortSignal.timeout(5_000), ...(signal ? [signal] : [])]),
      });
      if (!response.ok) {
        // Older LM Studio without the v1 REST API: every model it serves.
        const fallback = await providerRequest(target, 'models', undefined, signal, false, 'GET');
        return (((await fallback.json()) as { data?: Array<{ id?: unknown }> }).data ?? [])
          .map(m => String(m.id ?? ''))
          .filter(id => id && !/embed/i.test(id))
          .map(id => ({ id, label: id }));
      }
      const data =
        (
          (await response.json()) as {
            models?: Array<{
              key?: string;
              display_name?: string;
              type?: string;
              params_string?: string;
              quantization?: { name?: string };
              loaded_instances?: unknown[];
              capabilities?: { trained_for_tool_use?: boolean };
            }>;
          }
        ).models ?? [];
      return data
        .filter(
          m =>
            m.type === 'llm' &&
            typeof m.key === 'string' &&
            m.capabilities?.trained_for_tool_use === true,
        )
        .map(m => {
          const detail = [
            m.params_string,
            m.quantization?.name,
            m.loaded_instances?.length ? 'loaded' : '',
          ]
            .filter(Boolean)
            .join(' · ');
          return {
            id: m.key!,
            label: m.display_name || m.key!,
            ...(detail ? { description: detail } : {}),
          };
        });
    },
  };
}
