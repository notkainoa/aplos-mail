import type { Caller, MethodContext } from '../methods/types';
import type { EngineSession } from '@aplos/contract/client';
import { ContractError } from '@aplos/contract/contract-error';
import type { Frame } from '@aplos/contract';
import { NotSentError, PausedError, ProviderError, type Logger } from '../ports';

import type { EngineServices } from './services';
import type { FrameHub } from './frames';

/** Runs one validated call; the engine passes the F5 table's `dispatch`. */
export type Dispatch = (method: string, args: unknown, ctx: MethodContext) => Promise<unknown>;

export interface ConnectionDeps {
  services: EngineServices;
  hub: FrameHub;
  dispatch: Dispatch;
  /** The host's argument check (the registry's `parseArgs`); the neutral engine bundles no validator of its own. */
  validate?: (method: string, args: unknown) => unknown;
  connectionId: string;
  onClose(): void;
}

const closedError = () =>
  new ContractError({ type: 'unavailable', message: 'This connection is closed.' });

/**
 * One in-process session over the engine: the `EngineSession` every transport wraps. The caller is copied and frozen
 * when the connection opens, so a transport cannot widen it later, and every call (a handler's `redispatch` included)
 * goes through the same default-deny `dispatch`. Arguments and results are copied, so neither side shares objects.
 */
export function openConnection(deps: ConnectionDeps, caller: Caller): EngineSession {
  const who = freezeCaller(caller);
  const listeners = new Set<(frame: Frame) => void>();
  const running = new Set<AbortController>();
  let closed = false;

  deps.hub.attach(deps.connectionId, frame => {
    for (const listener of [...listeners]) {
      try {
        listener(structuredClone(frame));
      } catch {
        // A listener's bug is not the engine's.
      }
    }
  });

  const run = async (method: string, args: unknown, signal: AbortSignal): Promise<unknown> => {
    const input = deps.validate ? deps.validate(method, args) : args;
    const ctx: MethodContext = {
      caller: who,
      signal,
      services: deps.services,
      connectionId: deps.connectionId,
      redispatch: (m, a) => run(m, a, signal) as never,
    };
    return deps.dispatch(method, input, ctx);
  };

  return {
    async call(method, args) {
      if (closed) throw closedError();
      const controller = new AbortController();
      running.add(controller);
      try {
        return structuredClone(await run(method, structuredClone(args ?? {}), controller.signal));
      } catch (error) {
        throw toContractError(error, method, deps.services.log);
      } finally {
        running.delete(controller);
      }
    },
    subscribe(listener) {
      if (!closed) listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    close() {
      if (closed) return;
      closed = true;
      listeners.clear();
      deps.hub.detach(deps.connectionId);
      for (const controller of running) controller.abort(closedError());
      deps.onClose();
    },
  };
}

function freezeCaller(caller: Caller): Caller {
  return Object.freeze({
    kind: caller.kind,
    ...(caller.via !== undefined && { via: caller.via }),
    ...(caller.clientId !== undefined && { clientId: caller.clientId }),
    scopes: Object.freeze([...caller.scopes]),
  });
}

/**
 * What a failed call answers. A `ContractError` is the handler's own sentence and passes through. Anything else is
 * classified here: a provider refusal becomes `paused` or `providerError` with fixed copy, and every other throw becomes
 * `internal`. No stack, cause, provider reason or provider message survives; the log records only the method and a code.
 */
export function toContractError(error: unknown, method: string, log: Logger): ContractError {
  if (error instanceof ContractError) return error;
  const { body, reason } = classify(error);
  log.event('rpc.failed', { method, reason });
  const clean = new ContractError(body);
  clean.stack = `ContractError: ${body.message}`;
  return clean;
}

function classify(error: unknown): { body: ContractError['body']; reason: string } {
  if (error instanceof PausedError)
    return {
      reason: `paused.${error.cls}`,
      body: {
        type: 'paused',
        message: 'Aplos is waiting before it tries this again.',
        ...(error.until !== undefined && { resumeAt: error.until }),
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
  return {
    reason: 'internal',
    body: { type: 'internal', message: 'Something went wrong. Try again.' },
  };
}
