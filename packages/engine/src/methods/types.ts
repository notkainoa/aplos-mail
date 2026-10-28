import type {
  AreaMethodName,
  EngineArea,
  EngineMethodName,
  Input,
  Output,
  Scope,
} from '@aplos/contract';
import { NotImplementedError } from '@aplos/contract/contract-error';

/**
 * Handler types for the F5 dispatch table. Types only come from the contract: the engine core bundles no zod, because
 * transports validate arguments with the registry's `parseArgs` at the host boundary before calling `dispatch`
 * (ARCH 9.3), which keeps the neutral engine inside its 400,000-byte budget.
 */

/** Who is calling, filled in by the transport after it authenticated the connection and checked the method's scope. */
export interface Caller {
  /** An Electron window's port, main's control connection, or a listener client (socket, HTTP, MCP). */
  kind: 'window' | 'host' | 'listener';
  clientId?: string;
  scopes: readonly Scope[];
}

/** What every handler receives besides its validated arguments. Engine services arrive with the ports (F3). */
export interface MethodContext {
  caller: Caller;
  /** Aborted when the caller cancels or disconnects. */
  signal: AbortSignal;
}

export type Handler<M extends EngineMethodName> = (
  args: Input<M>,
  ctx: MethodContext,
) => Promise<Output<M>> | Output<M>;

/** Exactly the methods one area owns: a missing or extra entry fails the typecheck of that area's file. */
export type AreaHandlers<A extends EngineArea> = {
  [M in AreaMethodName<A> & EngineMethodName]: Handler<M>;
};

export type EngineHandlers = { [M in EngineMethodName]: Handler<M> };

/** The stub every handler starts as: throws the contract's `notImplemented` error until its lane fills it. */
export function notImplemented<M extends EngineMethodName>(method: M): Handler<M> {
  return () => {
    throw new NotImplementedError(method);
  };
}
