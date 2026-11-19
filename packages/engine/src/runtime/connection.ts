import type { Frame } from '@aplos/contract';
import type { EngineSession } from '@aplos/contract/client';
import type { Caller, MethodContext } from '../methods/types';
import { closedError, contractError, toContractError } from './errors';
import { frameFilter, type FrameHub } from './frames';
import type { EngineServices } from './services';

/** Runs one validated call; the engine passes the F5 table's `dispatch`. */
export type Dispatch = (method: string, args: unknown, ctx: MethodContext) => Promise<unknown>;

/**
 * An `EngineSession` that also names its `connectionId` (`MethodContext.connectionId`). The utility process's port host
 * reads it to map an Electron window to its engine connection for `Mail/serve` (html-5); nothing else needs it.
 */
export type ConnectedSession = EngineSession & { readonly connectionId: string };

export interface ConnectionDeps {
  services: EngineServices;
  hub: FrameHub;
  dispatch: Dispatch;
  /** The host's argument check (the registry's `parseArgs`); the neutral engine bundles no validator of its own. */
  validate?: (method: string, args: unknown) => unknown;
  connectionId: string;
  onClose(): void;
}

/**
 * One in-process session over the engine: the `EngineSession` every transport wraps. The caller is checked, copied and
 * frozen when the connection opens, so a transport cannot widen it later, and every call (a handler's `redispatch`
 * included) goes through the same default-deny `dispatch`. Arguments and results are copied, so neither side shares
 * objects. Closing the session aborts its calls: they answer `unavailable`, and a handler can start nothing more.
 */
export function openConnection(deps: ConnectionDeps, caller: Caller): ConnectedSession {
  const who = freezeCaller(caller);
  const listeners = new Set<(frame: Frame) => void>();
  const running = new Set<AbortController>();
  let closed = false;

  deps.hub.attach(
    deps.connectionId,
    frame => {
      for (const listener of [...listeners]) {
        try {
          listener(structuredClone(frame));
        } catch {
          // A listener's bug is not the engine's.
        }
      }
    },
    frameFilter(who),
  );

  const run = async (method: string, args: unknown, signal: AbortSignal): Promise<unknown> => {
    if (signal.aborted) throw closedError();
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

  const call = async (method: string, args: unknown, controller: AbortController) => {
    const input = copyArgs(args);
    const result = await untilAborted(run(method, input, controller.signal), controller.signal);
    return structuredClone(result);
  };

  return {
    connectionId: deps.connectionId,
    async call(method, args) {
      if (closed) throw closedError();
      const controller = new AbortController();
      running.add(controller);
      try {
        return await call(method, args, controller);
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

const KINDS: ReadonlySet<string> = new Set(['window', 'host', 'listener']);

/** Fail closed: a caller of no known kind would otherwise skip the listener rules in `checkAccess`. */
function freezeCaller(caller: Caller): Caller {
  if (!caller || !KINDS.has(caller.kind) || !Array.isArray(caller.scopes))
    throw contractError({ type: 'forbidden', message: 'This connection is not allowed in Aplos.' });
  return Object.freeze({
    kind: caller.kind,
    ...(caller.via !== undefined && { via: caller.via }),
    ...(caller.clientId !== undefined && { clientId: caller.clientId }),
    scopes: Object.freeze([...caller.scopes]),
  });
}

/** Arguments that cannot be copied (a function, a proxy) could not cross any real transport either. */
function copyArgs(args: unknown): unknown {
  try {
    return structuredClone(args ?? {});
  } catch {
    throw contractError({ type: 'validation', message: 'These arguments cannot be sent.' });
  }
}

/** Settles with the call, or rejects with the abort reason as soon as the session closes. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
