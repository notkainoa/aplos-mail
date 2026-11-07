import type { ModelRef } from '@aplos/contract';
import type { EngineServices } from '../../runtime/services';
import { AiCallError, type AiChatRequest, type AiChatTurn } from '../host';
import { localDay } from '../providers';
import type { AiFeature } from './gate';
import { aiSettings } from './gate';

/**
 * The metered provider call (ARCH 8.4): the only path `chat` traffic takes. `background` calls spend the daily cap;
 * `interactive` calls are metered the same way but never refused by it (they must not starve behind background work).
 * Errors stay classified (`AiCallError.code`); the UI sentence comes from the caller.
 */

/** Tokens `background` jobs may spend in one local day (`settings.ai.dailyCap`). */
export function dailyUsage(services: EngineServices): { spent: number; cap?: number } {
  const ai = aiSettings(services);
  const day = localDay(services.clock.now());
  const spent = services.store.read(q =>
    q
      .all<{ t: number }>(
        "SELECT tokens_in + tokens_out AS t FROM ai_usage WHERE day = ? AND lane = 'background'",
        day,
      )
      .reduce((s, r) => s + r.t, 0),
  );
  return { spent, ...(ai.dailyCap.enabled ? { cap: ai.dailyCap.tokens } : {}) };
}

/** True when today's background spend is under the cap (an uncapped day is always open). */
export function budgetOpen(services: EngineServices): boolean {
  const { spent, cap } = dailyUsage(services);
  return cap === undefined || spent < cap;
}

function recordUsage(
  services: EngineServices,
  model: ModelRef,
  lane: 'interactive' | 'background',
  usage: { prompt: number; completion: number } | undefined,
): void {
  services.store.commit({
    opId: `ai-usage-${lane}-${services.clock.now()}-${Math.floor(services.randomBytes(2)[0])}`,
    origin: 'system',
    writes: [
      {
        kind: 'aiUsage',
        day: localDay(services.clock.now()),
        provider: model.provider,
        model: model.model,
        lane,
        requests: 1,
        tokensIn: usage?.prompt ?? 0,
        tokensOut: usage?.completion ?? 0,
      },
    ],
  });
}

/** The message every AI-call failure maps to, by class. Provider text never reaches the UI (FR-33). */
export function callMessage(error: unknown): { reasonCode: string; message: string } {
  const code = error instanceof AiCallError ? error.code : 'invalid';
  switch (code) {
    case 'missingKey':
      return { reasonCode: 'ai.missingKey', message: 'Add an AI key in Settings → AI.' };
    case 'rejected':
      return {
        reasonCode: 'ai.keyRejected',
        message: 'The AI provider rejected the key. Check it in Settings → AI.',
      };
    case 'rateLimited':
      return {
        reasonCode: 'ai.rateLimited',
        message: 'The AI provider is rate limited. Try again shortly.',
      };
    case 'dailyLimit':
      return {
        reasonCode: 'ai.dailyLimit',
        message: "Today's AI limit is reached. Try again tomorrow.",
      };
    case 'unreachable':
      return {
        reasonCode: 'ai.unreachable',
        message: 'Could not reach the AI provider. Check your connection.',
      };
    case 'noProvider':
      return { reasonCode: 'ai.noProvider', message: 'Choose an AI provider in Settings → AI.' };
    case 'cancelled':
      return { reasonCode: 'ai.cancelled', message: 'AI request cancelled.' };
    case 'unavailable':
      return { reasonCode: 'ai.unavailable', message: 'AI is not connected on this build.' };
    default:
      return {
        reasonCode: 'ai.failed',
        message: 'The AI provider could not complete the request. Please try again.',
      };
  }
}

export interface MeteredCall {
  feature: AiFeature;
  model: ModelRef;
  lane: 'interactive' | 'background';
  /** A run id to track for cancellation; absent means fire-and-forget. */
  trackId?: string;
}

/** One provider chat call with usage accounting; a capped day refuses `background` calls only. */
export async function meteredChat(
  services: EngineServices,
  call: MeteredCall,
  req: Omit<AiChatRequest, 'model'>,
): Promise<AiChatTurn> {
  if (call.lane === 'background' && !budgetOpen(services))
    throw new AiCallError('dailyLimit', "Today's AI limit is reached.");
  const transport = services.ai.transport();
  const signal = call.trackId ? services.ai.track(call.trackId) : req.signal;
  try {
    const turn = await transport.chat({ ...req, model: call.model, signal });
    recordUsage(services, call.model, call.lane, turn.usage);
    return turn;
  } finally {
    if (call.trackId) services.ai.release(call.trackId);
  }
}
