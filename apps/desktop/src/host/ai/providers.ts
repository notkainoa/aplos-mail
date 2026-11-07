import type { ModelRef } from '@aplos/contract';

/**
 * The provider table for the host's AI transport (lane eng-ai; mirrors `packages/engine/src/ai/providers.ts` —
 * keep them in step). One row per provider id: where its OpenAI-compatible (or Anthropic) base URL is, which
 * environment variable can hold a key, whether a key is optional (loopback servers), and the few wire quirks
 * each endpoint has. No key material lives here.
 */
export type AiProviderId = ModelRef['provider'];

export type ProviderWire = 'openai' | 'anthropic';

export interface ProviderRow {
  id: AiProviderId;
  label: string;
  envVar: string;
  keyOptional: boolean;
  wire: ProviderWire;
  /** Fixed OpenAI-compatible base URL for hosted providers (no trailing slash). */
  base?: string;
  /** Loopback default for local servers; the owner's address (settings/env) wins. */
  defaultAddress?: string;
  /** Environment variable that can carry the server's address outside the app. */
  addressEnv?: string;
  /** How `check` proves a key: GET the model list, or a 1-token completion for plans whose list needs no key. */
  check?: 'models' | 'completion';
  /** A model id `check: 'completion'` can spend one token on. */
  checkModel?: string;
  /** Absolute URL for the live model list when it is not `<base>/models`. */
  modelsUrl?: string;
  /** Extra headers every request to this provider carries (OpenCode asks clients to name themselves). */
  headers?: Record<string, string>;
  /** Extra per-request headers, e.g. OpenCode's stable session id. */
  requestHeaders?: (req: { session?: string }) => Record<string, string>;
  /** Provider-specific body fields for a chat call, e.g. a low reasoning effort. */
  bodyExtras?: (model: string) => Record<string, unknown>;
  /** The completion-token ceiling when a request does not set one. */
  maxTokens?: number;
  /** Which token-limit field the server accepts; `max_completion_tokens` is the OpenAI default. */
  tokensParam?: 'max_tokens' | 'max_completion_tokens';
  /** Speech-to-text through an OpenAI-style `audio/transcriptions` endpoint. */
  stt?: boolean;
  /** Keeps chat models out of a live list that also names audio, image and embedding models. */
  keepModel?: RegExp;
}

const OPENCODE_HEADERS = { 'User-Agent': 'aplos-mail/0.1.0' };

export const PROVIDERS: readonly ProviderRow[] = [
  {
    id: 'groq',
    label: 'Groq',
    envVar: 'GROQ_API_KEY',
    keyOptional: false,
    wire: 'openai',
    base: 'https://api.groq.com/openai/v1',
    stt: true,
    bodyExtras: model => (model.startsWith('openai/gpt-oss-') ? { reasoning_effort: 'low' } : {}),
  },
  {
    id: 'openai',
    label: 'OpenAI',
    envVar: 'OPENAI_API_KEY',
    keyOptional: false,
    wire: 'openai',
    base: 'https://api.openai.com/v1',
    stt: true,
    bodyExtras: () => ({}),
    keepModel:
      /^(gpt-|o\d|chatgpt-)(?!.*(audio|realtime|image|tts|transcribe|search|embedding|moderation|instruct))/,
  },
  {
    id: 'anthropic',
    label: 'Claude',
    envVar: 'ANTHROPIC_API_KEY',
    keyOptional: false,
    wire: 'anthropic',
    base: 'https://api.anthropic.com/v1',
  },
  {
    id: 'gemini',
    label: 'Gemini',
    envVar: 'GEMINI_API_KEY',
    keyOptional: false,
    wire: 'openai',
    base: 'https://generativelanguage.googleapis.com/v1beta/openai',
    bodyExtras: () => ({}),
    keepModel: /^gemini-(?!.*(embedding|image|tts|live|audio))/,
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    envVar: 'OPENROUTER_API_KEY',
    keyOptional: false,
    wire: 'openai',
    base: 'https://openrouter.ai/api/v1',
  },
  {
    id: 'opencode-go',
    label: 'OpenCode Go',
    envVar: 'OPENCODE_API_KEY',
    keyOptional: false,
    wire: 'openai',
    base: 'https://opencode.ai/inference/go/openai/v1',
    maxTokens: 4096,
    // Go's model list needs no key, so `check` spends one token on the plan's first chat model instead.
    check: 'completion',
    checkModel: 'kimi-k3',
    // Its catalog also names models served over other APIs; the list endpoint lives outside the OpenAI path.
    modelsUrl: 'https://opencode.ai/inference/go/v1/models',
    headers: OPENCODE_HEADERS,
    requestHeaders: req =>
      req.session ? { 'x-opencode-session': req.session } : ({} as Record<string, string>),
  },
  {
    id: 'ollama',
    label: 'Ollama',
    envVar: 'OLLAMA_API_KEY',
    keyOptional: true,
    wire: 'openai',
    defaultAddress: 'http://localhost:11434',
    addressEnv: 'OLLAMA_ADDRESS',
    tokensParam: 'max_tokens',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    envVar: 'LM_STUDIO_API_KEY',
    keyOptional: true,
    wire: 'openai',
    defaultAddress: 'http://localhost:1234',
    addressEnv: 'LM_STUDIO_ADDRESS',
    maxTokens: 4096,
    tokensParam: 'max_tokens',
  },
  {
    id: 'custom',
    label: 'Custom server',
    envVar: 'CUSTOM_AI_API_KEY',
    keyOptional: true,
    wire: 'openai',
    addressEnv: 'CUSTOM_AI_ADDRESS',
    tokensParam: 'max_tokens',
  },
];

export function providerRow(id: string): ProviderRow | undefined {
  return PROVIDERS.find(row => row.id === id);
}

/** Where a local server's address comes from: the owner's setting (passed in), then its env var, then the default. */
export function providerAddress(
  row: ProviderRow,
  env: NodeJS.ProcessEnv,
  addresses?: Partial<Record<AiProviderId, string>>,
): string | undefined {
  const configured =
    addresses?.[row.id]?.trim() || (row.addressEnv ? env[row.addressEnv]?.trim() : undefined);
  return configured || row.defaultAddress;
}

/**
 * The base URL requests are made under: the fixed hosted base, or `<address>/v1` for a local server.
 * Answers `undefined` for a custom server with no address configured; callers classify that `unavailable`.
 */
export function baseUrl(
  row: ProviderRow,
  env: NodeJS.ProcessEnv,
  addresses?: Partial<Record<AiProviderId, string>>,
): string | undefined {
  if (row.base) return row.base;
  const address = providerAddress(row, env, addresses);
  if (!address) return undefined;
  return `${address.replace(/\/+$/, '').replace(/\/v1$/, '')}/v1`;
}
