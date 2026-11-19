import { ContractError } from '@aplos/contract/contract-error';
import type { ErrorBody } from '@aplos/contract';
import { NotSentError, PausedError, ProviderError, type Logger } from '../ports';

/** A `ContractError` whose stack is only its sentence, so nothing of the engine's code paths reaches a caller. */
export function contractError(body: ErrorBody): ContractError {
  const error = new ContractError(body);
  error.stack = `ContractError: ${body.message}`;
  return error;
}

export const closedError = () =>
  contractError({ type: 'unavailable', message: 'This connection is closed.' });

const INTERNAL: ErrorBody = { type: 'internal', message: 'Something went wrong. Try again.' };

/**
 * What a failed call answers, as the stand-in answers it after a reply envelope: a fresh error built from the body alone.
 * A `ContractError` keeps its body (the handler's own sentence) and loses its stack, cause and extra fields. Anything
 * else is classified: a provider refusal becomes `paused` or `providerError` with fixed copy, every other throw
 * `internal`. No provider reason or message survives; the log records only the method and a code.
 */
export function toContractError(error: unknown, method: string, log: Logger): ContractError {
  try {
    if (error instanceof ContractError) return contractError(structuredClone(error.body));
    const { body, reason } = classify(error);
    log.event('rpc.failed', { method, reason });
    return contractError(body);
  } catch {
    // A thrown value that defeats even the checks above (a revoked proxy) is still only `internal`.
    return contractError(INTERNAL);
  }
}

function classify(error: unknown): { body: ErrorBody; reason: string } {
  if (error instanceof PausedError)
    return {
      reason: `paused.${error.cls}`,
      body: {
        type: 'paused',
        message: 'Aplos is waiting before it tries this again.',
        ...(typeof error.until === 'number' && { resumeAt: error.until }),
      },
    };
  if (error instanceof ProviderError || error instanceof NotSentError)
    return {
      reason: `provider.${error.error?.class ?? 'unknown'}`,
      body: {
        type: 'providerError',
        message: 'Your mail provider could not do that right now. Try again.',
      },
    };
  return { reason: 'internal', body: INTERNAL };
}
