import type {
  AreaMethodName,
  EngineArea,
  EngineMethodName,
  Input,
  Output,
  Scope,
} from '@aplos/contract';
import { NotImplementedError } from '@aplos/contract/contract-error';
import type { EngineServices } from '../runtime/services';

export type { EngineServices };

/**
 * Handler types for the F5 dispatch table. Only types come from the contract (plus its zod-free generated tables in
 * `dispatch`): the engine core bundles no zod, because transports validate arguments with the registry's `parseArgs`
 * at the host boundary before calling `dispatch` (ARCH 9.3), which keeps the neutral engine inside its bundle budget (packages/engine/tests/portability.test.ts).
 */

/**
 * Who is calling, filled in by the transport after it authenticated the connection. `dispatch` checks the method
 * against it (default deny), so a transport that forgets a check exposes nothing.
 */
export interface Caller {
  /** An Electron window's port, main's control connection, or a listener client (socket, HTTP, MCP). */
  kind: 'window' | 'host' | 'listener';
  /** Listener clients only: the MCP adapter sets `mcp`, which limits the caller to `mcpMethods`. */
  via?: 'socket' | 'http' | 'mcp';
  clientId?: string;
  /**
   * What the caller may do. A listener client: its grant. A window: every grantable scope. Main's control connection:
   * `host` plus whatever it calls besides. A scope a caller lacks answers `forbidden`, whatever its kind.
   */
  scopes: readonly Scope[];
}

/** What every handler receives besides its validated arguments. */
export interface MethodContext {
  caller: Caller;
  /** Aborted when the caller cancels or disconnects. */
  signal: AbortSignal;
  services: EngineServices;
  /** The connection the call came in on: `services.frames.emit(frame, connectionId)` answers only this caller. */
  connectionId: string;
  /**
   * Runs another method as this same caller, through the same default-deny dispatch (`Operation/retry`, a queued item):
   * a re-dispatch never widens what the caller may do. It shares the caller's connection, so it runs under the same
   * abort signal (closing the session cancels it) and a `connectionId` reply from it answers the same connection.
   */
  redispatch<M extends EngineMethodName>(method: M, args: Input<M>): Promise<Output<M>>;
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

/** A unique idempotency key fragment: a repeated call is a new change, never a commit replay. */
export function nonce(ctx: MethodContext): string {
  return Array.from(ctx.services.randomBytes(8), b => b.toString(16).padStart(2, '0')).join('');
}

/** The stub every handler starts as: throws the contract's `notImplemented` error until its lane fills it. */
export function notImplemented<M extends EngineMethodName>(method: M): Handler<M> {
  return () => {
    throw new NotImplementedError(method);
  };
}
