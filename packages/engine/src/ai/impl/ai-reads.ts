import type { AiProvider, Input, ModelRef, Output, Settings } from '@aplos/contract';
import { parseStored, withDefaults } from '../../runtime/settings';
import type { MethodContext } from '../../methods/types';
import {
  isLoopback,
  localDay,
  providerAddress,
  providerRow,
  PROVIDER_ROWS,
  trainsOnInputs,
} from '../providers';

/**
 * Settings → AI's read half (lazy-loaded): the provider table with each key's SOURCE (never the key), the model
 * lists (a provider's live list first, the curated table when it cannot answer), per-feature readiness and today's
 * metered usage.
 */

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

const settings = (ctx: MethodContext): Settings =>
  ctx.services.store.read(q =>
    withDefaults(
      parseStored(q.get<{ data: string }>('SELECT data FROM settings WHERE id = 1')?.data),
    ),
  );

/**
 * Where a key comes from: the bound transport knows env and the sealed store; before it binds, the host reports
 * which environment variables are set as names only (`services.host.envKeys`).
 */
const keySource = (
  ctx: MethodContext,
  provider: string,
  envVar: string,
): AiProvider['keySource'] => {
  const transport = ctx.services.ai.transport();
  const source = transport.keySource(provider);
  return source !== 'none' ? source : ctx.services.host.envKeys?.includes(envVar) ? 'env' : 'none';
};

const providerStatus = (
  row: (typeof PROVIDER_ROWS)[number],
  source: AiProvider['keySource'],
  address: string | undefined,
): AiProvider['status'] =>
  row.group === 'local'
    ? row.id === 'custom' && !address
      ? 'notConfigured'
      : // A configured local server reads `ready`, same as `Ai/status` — reachability is proven by calls,
        // not by a read that must never do I/O.
        'ready'
    : source === 'none' && !row.keyOptional
      ? 'missingKey'
      : 'ready';

export function providers(
  _args: Input<'Ai/providers'>,
  ctx: MethodContext,
): Output<'Ai/providers'> {
  const ai = settings(ctx).ai;
  const list: AiProvider[] = PROVIDER_ROWS.map(row => {
    const source = keySource(ctx, row.id, row.envVar);
    const address = providerAddress(row.id, ai.providers[row.id]);
    return {
      id: row.id,
      label: row.label,
      group: row.group,
      status: providerStatus(row, source, address),
      keySource: source,
      envVar: row.envVar,
      keyOptional: row.keyOptional,
      ...(address ? { address } : {}),
      ...(row.defaultAddress ? { defaultAddress: row.defaultAddress } : {}),
      trainsOnInputs: trainsOnInputs(row.id, ai.providers[row.id]?.paid),
      ...(ai.providers[row.id]?.paid !== undefined
        ? { paidMarked: ai.providers[row.id]!.paid }
        : {}),
      sttCapable: row.stt,
      local: !!address && isLoopback(address),
    };
  });
  return { list };
}

export async function models(
  args: Input<'Ai/models'>,
  ctx: MethodContext,
): Promise<Output<'Ai/models'>> {
  try {
    const live = await ctx.services.ai.transport().models(args.provider);
    if (live.list.length || live.live)
      return { list: live.list.map(id => ({ id, label: id })), live: live.live };
  } catch {
    /* fall through to the curated table */
  }
  return { list: MODELS[args.provider] ?? [], live: false };
}

export function status(_args: Input<'Ai/status'>, ctx: MethodContext): Output<'Ai/status'> {
  const ai = settings(ctx).ai;
  const features = (['ask', 'summaries', 'drafts', 'plans', 'voice'] as const).map(feature => {
    const model: ModelRef = ai.features[feature];
    const row = providerRow(model.provider);
    const address = providerAddress(model.provider, ai.providers[model.provider]);
    // A local server needs no key, just a configured address; anything hosted needs a key.
    const ready = row
      ? keySource(ctx, model.provider, row.envVar) !== 'none' || (row.keyOptional && !!address)
      : false;
    return {
      feature,
      ready,
      model,
      ...(ready ? {} : { reasonCode: row ? 'ai.missingKey' : 'ai.noProvider' }),
    };
  });
  return { features };
}

export function usage(_args: Input<'Ai/usage'>, ctx: MethodContext): Output<'Ai/usage'> {
  const day = localDay(ctx.services.clock.now());
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
