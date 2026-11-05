// How a failed desktop method (`aplos:desktop`, main's own handlers) reaches the renderer. `ipcRenderer.invoke` turns a
// handler's rejection into a flattened Error whose only surviving part is a long wrapper message, so every failure used
// to read as the generic sentence. Main now ANSWERS a failure with a tagged envelope (main/engine-real.ts) and preload
// rejects with the contract's plain error body (host/transports/port.ts), the same shape every other failed call has.
// No import of Electron, so node:test runs it.

import type { ErrorBody } from '@aplos/contract';

/** The one key that marks a failure envelope; no desktop method's result has it. */
export const DESKTOP_FAILURE_KEY = 'aplos:desktop-failure';

export interface DesktopFailure {
  [DESKTOP_FAILURE_KEY]: ErrorBody;
}

const MAX_MESSAGE = 300;
const GENERIC: ErrorBody = { type: 'internal', message: 'Something went wrong. Try again.' };

const isBody = (value: unknown): value is ErrorBody =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as ErrorBody).type === 'string' &&
  typeof (value as ErrorBody).message === 'string';

/**
 * The envelope for a thrown error: a ContractError keeps its `type`, message and reason code (the validation reason,
 * "Save this draft before opening a separate window."); any other Error keeps its sentence as `unavailable`, cut short;
 * anything else is the generic sentence. A stack or a cause never travels.
 */
export function desktopFailure(error: unknown): DesktopFailure {
  const body = (error as { body?: unknown } | null)?.body;
  if (isBody(body)) {
    const { type, message } = body;
    const reasonCode = (body as { reasonCode?: unknown }).reasonCode;
    return {
      [DESKTOP_FAILURE_KEY]: {
        type,
        message: message.slice(0, MAX_MESSAGE),
        ...(typeof reasonCode === 'string' ? { reasonCode } : {}),
      } as ErrorBody,
    };
  }
  if (error instanceof Error && error.message.trim())
    return {
      [DESKTOP_FAILURE_KEY]: { type: 'unavailable', message: error.message.slice(0, MAX_MESSAGE) },
    };
  return { [DESKTOP_FAILURE_KEY]: GENERIC };
}

/** The error body inside a failure envelope, or undefined for a normal result. */
export function failureOf(result: unknown): ErrorBody | undefined {
  if (typeof result !== 'object' || result === null) return undefined;
  const body = (result as Record<string, unknown>)[DESKTOP_FAILURE_KEY];
  return isBody(body) ? body : undefined;
}
