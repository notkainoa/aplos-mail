import type { AiProvider, Input, ModelRef, Output, Settings } from '@aplos/contract';
import { parseStored, withDefaults } from '../runtime/settings';
import { notImplemented, type AreaHandlers, type MethodContext } from './types';

/**
 * The `ai` area, owned by lane `eng-ai`. The read half of Settings → AI is served here: the provider table (status and
 * where each key comes from, never the key), the curated model lists, per-feature readiness and today's usage.
 * Key writes and live tests stay stubs until the engine has a sealed key store and a provider client.
 */

// [id, label, group, envVar, keyOptional, trainsOnInputs, sttCapable, defaultAddress?]
const PROVIDERS = [
  ['groq', 'Groq', 'hosted', 'GROQ_API_KEY', false, false, true],
  ['openai', 'OpenAI', 'hosted', 'OPENAI_API_KEY', false, false, true],
  ['anthropic', 'Claude', 'hosted', 'ANTHROPIC_API_KEY', false, false, false],
  ['gemini', 'Gemini', 'hosted', 'GEMINI_API_KEY', false, true, false],
  ['openrouter', 'OpenRouter', 'hosted', 'OPENROUTER_API_KEY', false, false, false],
  ['opencode-go', 'OpenCode Go', 'hosted', 'OPENCODE_API_KEY', false, false, false],
  ['ollama', 'Ollama', 'local', 'OLLAMA_API_KEY', true, false, false, 'http://localhost:11434'],
  [
    'lmstudio',
    'LM Studio',
    'local',
    'LM_STUDIO_API_KEY',
    true,
    false,
    false,
    'http://localhost:1234',
  ],
  ['custom', 'Custom server', 'local', 'CUSTOM_AI_API_KEY', true, false, false],
] as const;

const MODELS: Record<string, Output<'Ai/models'>['list']> = {
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

/**
 * Where a key comes from. The host reports which environment variables are set as names only
 * (`services.host.envKeys`); `keychain` reports only once the engine has a sealed key store.
 */
const keySource = (ctx: MethodContext, envVar: string): AiProvider['keySource'] =>
  ctx.services.host.envKeys?.includes(envVar) ? 'env' : 'none';

const providerStatus = (
  row: (typeof PROVIDERS)[number],
  source: AiProvider['keySource'],
  address: string | undefined,
): AiProvider['status'] =>
  row[2] === 'local'
    ? row[0] === 'custom' && !address
      ? 'notConfigured'
      : 'unreachable'
    : source === 'none' && !row[4]
      ? 'missingKey'
      : 'ready';

function providers(_args: Input<'Ai/providers'>, ctx: MethodContext): Output<'Ai/providers'> {
  const configured = settings(ctx).ai.providers;
  const list: AiProvider[] = PROVIDERS.map(row => {
    const source = keySource(ctx, row[3]);
    const address = configured[row[0]]?.address || row[7];
    return {
      id: row[0],
      label: row[1],
      group: row[2],
      status: providerStatus(row, source, address),
      keySource: source,
      envVar: row[3],
      keyOptional: row[4],
      ...(address ? { address } : {}),
      ...(row[7] ? { defaultAddress: row[7] } : {}),
      trainsOnInputs: row[5],
      sttCapable: row[6],
      local: !!address && loopback(address),
    };
  });
  return { list };
}

function status(_args: Input<'Ai/status'>, ctx: MethodContext): Output<'Ai/status'> {
  const ai = settings(ctx).ai;
  const features = (['ask', 'summaries', 'drafts', 'plans', 'voice'] as const).map(feature => {
    const model: ModelRef = ai.features[feature];
    const row = PROVIDERS.find(p => p[0] === model.provider);
    const address = ai.providers[model.provider]?.address || row?.[7];
    // A local server needs no key, just a configured address; anything hosted needs a key.
    const ready = row ? keySource(ctx, row[3]) !== 'none' || (row[4] && !!address) : false;
    return {
      feature,
      ready,
      model,
      ...(ready ? {} : { reasonCode: row ? 'ai.missingKey' : 'ai.noProvider' }),
    };
  });
  return { features };
}

function usage(_args: Input<'Ai/usage'>, ctx: MethodContext): Output<'Ai/usage'> {
  // The local calendar day, matching the `day` the usage writer will stamp.
  const at = new Date(ctx.services.clock.now());
  const day = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
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
  return {
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
  'Ai/models': args => ({ list: MODELS[args.provider] ?? [], live: false }),
  'Ai/status': status,
  'Ai/usage': usage,
  'Ai/setKey': notImplemented('Ai/setKey'),
  'Ai/removeKey': notImplemented('Ai/removeKey'),
  'Ai/testKey': notImplemented('Ai/testKey'),
  'Ai/test': notImplemented('Ai/test'),
};
