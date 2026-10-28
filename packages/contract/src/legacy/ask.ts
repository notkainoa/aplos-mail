/**
 * The AI providers the owner sets up in Settings → AI, and which model each AI feature uses. Groq is the default for
 * everything; any feature can run on ChatGPT (OpenAI API), Claude, Gemini, OpenRouter, an OpenCode Go plan, Ollama or
 * LM Studio on this Mac, or a custom OpenAI-compatible server. Voice needs a speech-to-text API (Groq or OpenAI).
 * Keys stay in the backend: saved encrypted from Settings → AI, or read from the environment; `env` names that variable.
 * Each choice is stored as `provider:model`, e.g. `groq:openai/gpt-oss-120b` or `openrouter:anthropic/claude-haiku-5.5`.
 */
export type AskProviderId =
  | 'groq'
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'openrouter'
  | 'opencode-go'
  | 'ollama'
  | 'lmstudio'
  | 'custom';
/** Providers that run on a server the owner points at (usually this Mac), with no key needed. */
export type AskServerId = 'ollama' | 'lmstudio' | 'custom';
export interface AskModelInfo {
  id: string;
  label: string;
  description?: string;
}
/** `env` is the backend variable holding the key; a custom server's key is optional, its address is a setting. */
export interface AskProviderInfo {
  id: AskProviderId;
  label: string;
  env: string;
  description: string;
  models: readonly AskModelInfo[];
  keyOptional?: boolean;
  /** Where a local app listens by default; the owner can change it in Settings. */ defaultAddress?: string;
}

export const askProviders: readonly AskProviderInfo[] = [
  {
    id: 'groq',
    label: 'Groq',
    env: 'GROQ_API_KEY',
    description: 'Very fast open models, and speech to text. The default for every feature.',
    models: [
      // Verified live for tool use on 2026-10-21.
      {
        id: 'openai/gpt-oss-120b',
        label: 'GPT-OSS 120B',
        description: 'Most careful with search, dates and drafts.',
      },
      {
        id: 'openai/gpt-oss-20b',
        label: 'GPT-OSS 20B',
        description:
          'Fastest, but slips more often on dates and contacts. Review its cards closely.',
      },
      {
        id: 'qwen/qwen3.8-27b',
        label: 'Qwen3.8 27B',
        description:
          'Careful and accurate in testing. A Groq preview model that may change without notice.',
      },
    ],
  },
  {
    id: 'openai',
    label: 'ChatGPT',
    env: 'OPENAI_API_KEY',
    description:
      'OpenAI’s GPT models through the OpenAI API (billed by OpenAI, separate from a ChatGPT subscription).',
    models: [
      { id: 'gpt-6-luna', label: 'GPT-6 Luna', description: 'Fast and inexpensive.' },
      { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', description: 'OpenAI’s strong general model.' },
      { id: 'gpt-6-astra', label: 'GPT-6 Astra', description: 'Most capable; slower and pricier.' },
    ],
  },
  {
    id: 'anthropic',
    label: 'Claude',
    env: 'ANTHROPIC_API_KEY',
    description: 'Anthropic’s Claude models through the Claude API.',
    models: [
      {
        id: 'claude-opus-5-5',
        label: 'Claude Opus 5.5',
        description: 'Anthropic’s most capable everyday model.',
      },
      {
        id: 'claude-sonnet-5-5',
        label: 'Claude Sonnet 5.5',
        description: 'Fast and capable; a good balance.',
      },
      {
        id: 'claude-haiku-5-5',
        label: 'Claude Haiku 5.5',
        description: 'Quickest and least expensive.',
      },
    ],
  },
  {
    id: 'gemini',
    label: 'Gemini',
    env: 'GEMINI_API_KEY',
    description: 'Google’s Gemini models through the Gemini API.',
    models: [
      {
        id: 'gemini-3.8-flash',
        label: 'Gemini 3.8 Flash',
        description: 'Fast, with a very long context.',
      },
      {
        id: 'gemini-4-argon',
        label: 'Gemini 4 Argon',
        description: 'Google’s most capable model.',
      },
      {
        id: 'gemini-3.5-flash-lite',
        label: 'Gemini 3.5 Flash Lite',
        description: 'Lightest and least expensive.',
      },
    ],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    env: 'OPENROUTER_API_KEY',
    description: 'Hundreds of models on one key, billed by OpenRouter per token.',
    models: [
      {
        id: 'anthropic/claude-haiku-5.5',
        label: 'Claude Haiku 5.5',
        description: 'Quick and dependable with tools.',
      },
      {
        id: 'anthropic/claude-sonnet-5.5',
        label: 'Claude Sonnet 5.5',
        description: 'Most capable here; slower and pricier.',
      },
      {
        id: 'google/gemini-3.8-flash',
        label: 'Gemini 3.8 Flash',
        description: 'Fast, with a very long context.',
      },
      { id: 'moonshotai/kimi-k3', label: 'Kimi K3' },
      { id: 'z-ai/glm-5.3', label: 'GLM 5.3' },
      { id: 'qwen/qwen3.8-flash', label: 'Qwen3.8 Flash' },
      {
        id: 'deepseek/deepseek-v4.1-flash',
        label: 'DeepSeek V4.1 Flash',
        description: 'Very low cost.',
      },
    ],
  },
  {
    id: 'opencode-go',
    label: 'OpenCode Go',
    env: 'OPENCODE_API_KEY',
    description:
      'Your OpenCode Go plan. OpenCode designs Go for coding agents, so heavy mail use may be throttled.',
    models: [
      // Only models Go serves through chat/completions; its Anthropic- and Responses-style models need other APIs.
      { id: 'kimi-k3', label: 'Kimi K3' },
      { id: 'glm-5.3', label: 'GLM 5.3' },
      {
        id: 'glm-5.3-flash',
        label: 'GLM 5.3 Flash',
        description: 'Fast and light on the plan’s limits.',
      },
      { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
      {
        id: 'deepseek-v4.1-flash',
        label: 'DeepSeek V4.1 Flash',
        description: 'Fast and light on the plan’s limits.',
      },
    ],
  },
  {
    id: 'ollama',
    label: 'Ollama',
    env: 'OLLAMA_API_KEY',
    keyOptional: true,
    defaultAddress: 'http://localhost:11434',
    description: 'Models running on this Mac with Ollama. Mail stays on your machine.',
    models: [],
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    env: 'LM_STUDIO_API_KEY',
    keyOptional: true,
    defaultAddress: 'http://localhost:1234',
    description: 'Models running on this Mac with LM Studio. Mail stays on your machine.',
    models: [],
  },
  {
    id: 'custom',
    label: 'Custom',
    env: 'CUSTOM_AI_API_KEY',
    keyOptional: true,
    description:
      'Any OpenAI-compatible server, such as Ollama, LM Studio or vLLM. Its model must support tool calling.',
    models: [],
  },
];
export const defaultAskModel = 'groq:openai/gpt-oss-120b';

/** Speech-to-text models. Only these providers have a transcription API. */
export const voiceProviders: Partial<Record<AskProviderId, readonly AskModelInfo[]>> = {
  groq: [
    {
      id: 'whisper-large-v3-turbo',
      label: 'Whisper Large v3 Turbo',
      description: 'Fast and accurate. The default.',
    },
    {
      id: 'whisper-large-v3',
      label: 'Whisper Large v3',
      description: 'A little more accurate; a little slower.',
    },
  ],
  openai: [
    {
      id: 'gpt-4o-mini-transcribe',
      label: 'GPT-4o mini Transcribe',
      description: 'Fast and inexpensive.',
    },
    { id: 'gpt-4o-transcribe', label: 'GPT-4o Transcribe', description: 'OpenAI’s most accurate.' },
    { id: 'whisper-1', label: 'Whisper', description: 'OpenAI’s original speech model.' },
  ],
};
export const isVoiceProvider = (id: AskProviderId) => !!voiceProviders[id];

export type AiFeature = 'ask' | 'summary' | 'draft' | 'plan' | 'voice';
export type AiModelSetting =
  'askModel' | 'summaryModel' | 'draftModel' | 'planModel' | 'voiceModel';
/** What the owner picks a model for in Settings → AI. `voice` lists speech-to-text models; the rest chat models. */
export const aiFeatures: readonly {
  id: AiFeature;
  setting: AiModelSetting;
  label: string;
  description: string;
  fallback: string;
}[] = [
  {
    id: 'ask',
    setting: 'askModel',
    label: 'Ask',
    description: 'Answers questions and prepares drafts and events.',
    fallback: defaultAskModel,
  },
  {
    id: 'summary',
    setting: 'summaryModel',
    label: 'Summaries',
    description: 'Sorts and summarizes each new email.',
    fallback: 'groq:openai/gpt-oss-120b',
  },
  {
    id: 'draft',
    setting: 'draftModel',
    label: 'Drafts',
    description: 'Writes and polishes drafts.',
    fallback: 'groq:openai/gpt-oss-120b',
  },
  {
    id: 'plan',
    setting: 'planModel',
    label: 'Plans',
    description: 'Finds meetings and trips in mail for your calendar.',
    fallback: 'groq:openai/gpt-oss-120b',
  },
  {
    id: 'voice',
    setting: 'voiceModel',
    label: 'Voice',
    description: 'Turns what you say into text.',
    fallback: 'groq:whisper-large-v3-turbo',
  },
];
export const aiFeature = (id: AiFeature) => aiFeatures.find(f => f.id === id)!;
/** Speech-to-text model IDs (Whisper, OpenAI's transcribe models); chat features can't use them, nor Voice anything else. */
const speechModel = /whisper|transcribe/i;
/** A stored choice for `feature`, normalized; unreadable values or the wrong kind of model give undefined. */
export function parseFeatureModel(feature: AiFeature, value: unknown) {
  const ref = parseAskModel(value);
  if (!ref) return;
  if (
    feature === 'voice'
      ? !isVoiceProvider(ref.provider) || !speechModel.test(ref.model)
      : speechModel.test(ref.model)
  )
    return;
  return ref;
}
const modelId = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;

/** `provider:model`; a bare Groq model ID from earlier builds still reads as Groq. */
export function parseAskModel(
  value: unknown,
): { provider: AskProviderId; model: string } | undefined {
  if (typeof value !== 'string') return;
  const at = value.indexOf(':'),
    head = at > 0 ? value.slice(0, at) : '';
  const provider = askProviders.find(p => p.id === head)?.id;
  const model = provider ? value.slice(at + 1) : value;
  if (!modelId.test(model)) return;
  if (!provider)
    return askProviders[0].models.some(m => m.id === model)
      ? { provider: 'groq', model }
      : undefined;
  return { provider, model };
}
export const askProvider = (id: AskProviderId) => askProviders.find(p => p.id === id)!;
export const isAskServer = (id: AskProviderId): id is AskServerId =>
  id === 'ollama' || id === 'lmstudio' || id === 'custom';
/** The setting holding each server's address; empty means the app's default address. */
export const askServerSetting = {
  ollama: 'askOllamaUrl',
  lmstudio: 'askLmStudioUrl',
  custom: 'askCustomUrl',
} as const;
/** "Groq · GPT-OSS 120B", or the raw ID for a model outside the curated list. */
export function askModelLabel(value: string, feature: AiFeature = 'ask') {
  const ref = parseFeatureModel(feature, value) ?? parseAskModel(aiFeature(feature).fallback)!;
  const provider = askProvider(ref.provider);
  const models = feature === 'voice' ? (voiceProviders[ref.provider] ?? []) : provider.models;
  return {
    provider: provider.label,
    model: models.find(m => m.id === ref.model)?.label ?? ref.model,
  };
}
