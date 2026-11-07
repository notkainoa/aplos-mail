import type { AiTransport } from '../ports/ai';

/**
 * The provider call surface the host injects (`apps/desktop/src/host/ai`, eng-ai) — the transport shapes live in
 * `ports/ai.ts`; what stays here is the failure class a transport throws and the detached stand-in. The engine never
 * fetches and never reads the environment: keys live behind this port and only their `keySource` is reported.
 */

export type {
  AiChatMessage,
  AiChatRequest,
  AiChatTurn,
  AiKeySource,
  AiToolCall,
  AiToolSpec,
  AiTranscribeRequest,
  AiTransport,
} from '../ports/ai';

/** Provider-call failure classes; `reasonCode` and the user sentence come from the engine, never provider text. */
export type AiCallCode =
  | 'missingKey'
  | 'rejected'
  | 'rateLimited'
  | 'dailyLimit'
  | 'unreachable'
  | 'noProvider'
  | 'invalid'
  | 'cancelled'
  | 'unavailable'
  /** A background gate (consent, ai_allowed, settings) is closed; the job releases and waits. */
  | 'gatePaused'
  /** A permanent gate refusal (account off, thread gone/trashed/empty); the job is skipped, not retried. */
  | 'gatePermanent';

export class AiCallError extends Error {
  constructor(
    readonly code: AiCallCode,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

/** The stand-in before a host binds its transport: every call answers `unavailable`, classified for the caller. */
export function detachedTransport(): AiTransport {
  const fail = () =>
    Promise.reject(new AiCallError('unavailable', 'AI is not connected on this build.'));
  return {
    chat: fail,
    transcribe: fail,
    models: fail,
    check: fail,
    setKey: fail,
    removeKey: fail,
    keySource: () => 'none',
  };
}
