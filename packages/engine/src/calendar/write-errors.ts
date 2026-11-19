import { ContractError } from '@aplos/contract/contract-error';
import { PausedError, ProviderError } from '../ports/base';

/**
 * What a failed calendar write tells the caller, in plain words and with a stable reason code. Never the provider's
 * own text and never a token or a scope URL. The one thing that matters for every message is whether the change may
 * have happened: a request that never left says so, and a lost answer says it cannot tell.
 */

const retry = (error: ProviderError): { retryAfterMs?: number } =>
  error.error.retryAfterMs !== undefined ? { retryAfterMs: error.error.retryAfterMs } : {};

function failed(error: ProviderError): ContractError {
  const { class: cls, status } = error.error;
  if (cls === 'auth')
    return new ContractError({
      type: 'needsReauth',
      message: 'Sign in to Google again to change events.',
      reasonCode: 'auth.expired',
    });
  if (cls === 'transient' && error.error.uncertain === true)
    return new ContractError({
      type: 'unavailable',
      message:
        'Google Calendar did not answer, so Aplos cannot tell whether the change was saved. Check the calendar before trying again.',
      reasonCode: 'calendar.uncertain',
    });
  if (cls === 'transient' || cls === 'throttle' || cls === 'daily' || cls === 'anti_abuse')
    return new ContractError({
      type: 'unavailable',
      message: 'Google Calendar is not available right now. Nothing was changed. Try again soon.',
      reasonCode: 'calendar.unavailable',
      ...retry(error),
    });
  if (status === 404 || status === 410)
    return new ContractError({
      type: 'notFound',
      message: 'This event is no longer on the calendar.',
      reasonCode: 'calendar.eventGone',
    });
  if (status === 403)
    return new ContractError({
      type: 'forbidden',
      message: 'Google does not let you change this event. It may belong to someone else.',
      reasonCode: 'calendar.forbidden',
    });
  if (status === 400)
    return new ContractError({
      type: 'validation',
      message: 'Google did not accept those event details. Check the times and try again.',
      reasonCode: 'calendar.rejected',
    });
  return new ContractError({
    type: 'providerError',
    message: 'Google Calendar could not save that change. Nothing was changed.',
    reasonCode: 'calendar.failed',
  });
}

/**
 * Turns whatever a write threw into the error the caller sees. A `permission` refusal is handled by the caller
 * (it records the gap); a pause passes through to the engine's own `paused` answer.
 */
export function writeFailure(error: unknown): unknown {
  if (error instanceof PausedError || error instanceof ContractError) return error;
  if (error instanceof ProviderError) return failed(error);
  return error;
}
