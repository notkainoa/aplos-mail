import type { AiProvider, Input, ModelRef, Output, Settings } from '@aplos/contract';

type AiModel = Output<'Ai/models'>['list'][number];
type AiUsage = Output<'Ai/usage'>;
type AiProviderId = AiProvider['id'];
import { parseStored, withDefaults } from '../runtime/settings';
import { notImplemented, type AreaHandlers, type MethodContext } from './types';

/**
 * The `ai` area, owned by lane `eng-ai`. The read half of Settings → AI is served here: the provider table (status and
 * where each key comes from, never the key), the curated model lists, per-feature readiness and today's usage.
 * Key writes and live tests stay stubs until the engine has a sealed key store and a provider client.
 */

interface ProviderRow {
  id: AiProviderId;
  label: string;
  group: 'hosted' | 'local';
  envVar: string;
  keyOptional: boolean;
  trainsOnInputs: boolean;
  sttCapable: boolean;
  defaultAddress?: string;
}

const PROVIDERS: readonly ProviderRow[] = [
  {
    id: 'groq',
    label: 'Groq',
    group: 'hosted',
    envVar: 'GROQ_API_KEY',
    keyOptional: false,
    trainsOnInputs: false,
    sttCapable: true,
  },
  {
    id: 'openai',
    label: 'OpenAI',
    group: 'hosted',
    envVar: 'OPENAI_API_KEY',
    keyOptional: false,
    trainsOnInputs: false,
    sttCapable: true,
  },
  {
    id: 'anthropic',
    label: 'Claude',
    group: 'hosted',
    envVar: 'ANTHROPIC_API_KEY',
    keyOptional: false,
    trainsOnInputs: false,
    sttCapable: false,
  },
  {
    id: 'gemini',
    label: 'Gemini',
    group: 'hosted',
    envVar: 'GEMINI_API_KEY',
    keyOptional: false,
    trainsOnInputs: true,
    sttCapable: false,
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    group: 'hosted',
    envVar: 'OPENROUTER_API_KEY',
    keyOptional: false,
    trainsOnInputs: false,
    sttCapable: false,
  },
  {
    id: 'opencode-go',
    label: 'OpenCode Go',
    group: 'hosted',
    envVar: 'OPENCODE_API_KEY',
    keyOptional: false,
    trainsOnInputs: false,
    sttCapable: false,
  },
  {
    id: 'ollama',
    label: 'Ollama',
    group: 'local',
    envVar: 'OLLAMA_API_KEY',
    keyOptional: true,
    trainsOnInputs: false,
    sttCapable: false,
    defaultAddress: 'http://localhost:11434',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    group: 'local',
    envVar: 'LM_STUDIO_API_KEY',
    keyOptional: true,
    trainsOnInputs: false,
    sttCapable: false,
    defaultAddress: 'http://localhost:1234',
  },
  {
    id: 'custom',
    label: 'Custom server',
    group: 'local',
    envVar: 'CUSTOM_AI_API_KEY',
    keyOptional: true,
    trainsOnInputs: false,
    sttCapable: false,
  },
];

const MODELS: Record<string, AiModel[]> = {
  groq: [
    { id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B', tools: true },
    { id: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B', tools: true },
    { id: 'whisper-large-v3-turbo', label: 'Whisper Large v3 Turbo', stt: true },
  ],
  openai: [
    { id: 'gpt-5-mini', label: 'GPT-5 mini', tools: true },
    { id: 'gpt-4o-mini-transcribe', label: 'GPT-4o mini Transcribe', stt: true },
  ],
  anthropic: [
    { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', tools: true },
    { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', tools: true },
  ],
  gemini: [{ id: 'gemini-flash', label: 'Gemini Flash', tools: true }],
  openrouter: [{ id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B', tools: true }],
  'opencode-go': [{ id: 'kimi-k3', label: 'Kimi K3', tools: true }],
  ollama: [],
  lmstudio: [],
  custom: [],
};

const loopback = (address: string) => {
  try {
    const host = new URL(address).hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host);
  } catch {
    return false;
  }
};

const settings = (ctx: MethodContext): Settings =>
  ctx.services.store.read(q =>
    withDefaults(
      parseStored(q.get<{ data: string }>('SELECT data FROM settings WHERE id = 1')?.data),
    ),
  );

/** Where a key comes from. `keychain` reports only once the engine has a sealed key store. */
const keySource = (row: ProviderRow): AiProvider['keySource'] =>
  process.env[row.envVar] ? 'env' : 'none';

function providers(_args: Input<'Ai/providers'>, ctx: MethodContext): Output<'Ai/providers'> {
  const configured = settings(ctx).ai.providers;
  const list: AiProvider[] = PROVIDERS.map(row => {
    const source = keySource(row);
    const address = configured[row.id]?.address || row.defaultAddress;
    const status: AiProvider['status'] =
      row.group === 'local'
        ? row.id === 'custom' && !address
          ? 'notConfigured'
          : 'unreachable'
        : source === 'none' && !row.keyOptional
          ? 'missingKey'
          : 'ready';
    return {
      id: row.id,
      label: row.label,
      group: row.group,
      status,
      keySource: source,
      envVar: row.envVar,
      keyOptional: row.keyOptional,
      ...(address ? { address } : {}),
      ...(row.defaultAddress ? { defaultAddress: row.defaultAddress } : {}),
      trainsOnInputs: row.trainsOnInputs,
      sttCapable: row.sttCapable,
      local: !!address && loopback(address),
    };
  });
  return { list };
}

function models(args: Input<'Ai/models'>): Output<'Ai/models'> {
  return { list: MODELS[args.provider] ?? [], live: false };
}

function status(_args: Input<'Ai/status'>, ctx: MethodContext): Output<'Ai/status'> {
  const ai = settings(ctx).ai;
  const source = (feature: { provider: string }) =>
    keySource(PROVIDERS.find(p => p.id === feature.provider) ?? PROVIDERS[0]!);
  const features = (['ask', 'summaries', 'drafts', 'plans', 'voice'] as const).map(feature => {
    const model: ModelRef = ai.features[feature];
    const ready = source(model) !== 'none' || !!ai.providers[model.provider]?.address;
    return {
      feature,
      ready,
      model,
      ...(ready ? {} : { reasonCode: 'ai.missingKey' }),
    };
  });
  return { features };
}

function usage(_args: Input<'Ai/usage'>, ctx: MethodContext): Output<'Ai/usage'> {
  const day = new Date(ctx.services.clock.now()).toISOString().slice(0, 10);
  const cap = settings(ctx).ai.dailyCap;
  const rows = ctx.services.store.read(q =>
    q.all<{
      provider: string;
      model: string;
      lane: string;
      requests: number;
      tokens_in: number;
      tokens_out: number;
    }>(
      'SELECT provider, model, lane, requests, tokens_in, tokens_out FROM ai_usage WHERE day = ? ORDER BY provider, model, lane',
      day,
    ),
  );
  const out: AiUsage = {
    day,
    backgroundTokens: rows
      .filter(r => r.lane === 'background')
      .reduce((sum, r) => sum + r.tokens_in + r.tokens_out, 0),
    ...(cap.enabled ? { cap: cap.tokens } : {}),
    byModel: rows.map(r => ({
      model: { provider: r.provider as ModelRef['provider'], model: r.model },
      lane: r.lane as 'interactive' | 'background',
      requests: r.requests,
      tokensIn: r.tokens_in,
      tokensOut: r.tokens_out,
    })),
  };
  return out;
}

export const handlers: AreaHandlers<'ai'> = {
  'Ai/request': notImplemented('Ai/request'),
  'Ai/jobs': notImplemented('Ai/jobs'),
  'Ai/polish': notImplemented('Ai/polish'),
  'Ai/draft': notImplemented('Ai/draft'),
  'Ai/transcribe': notImplemented('Ai/transcribe'),
  'Ai/cancel': notImplemented('Ai/cancel'),
  'Ai/followup': notImplemented('Ai/followup'),
  'Ai/dismissFollowup': notImplemented('Ai/dismissFollowup'),
  'Ai/providers': providers,
  'Ai/models': models,
  'Ai/status': status,
  'Ai/usage': usage,
  'Ai/setKey': notImplemented('Ai/setKey'),
  'Ai/removeKey': notImplemented('Ai/removeKey'),
  'Ai/testKey': notImplemented('Ai/testKey'),
  'Ai/test': notImplemented('Ai/test'),
};
