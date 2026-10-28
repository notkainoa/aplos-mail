import type {
  AreaMethodName,
  EngineArea,
  EngineMethodName,
  Input,
  Output,
  Scope,
} from '@aplos/contract';
import { NotImplementedError } from '@aplos/contract/contract-error';
import type {
  AccountActorHost,
  CalendarPort,
  Clock,
  DeadlineRegistry,
  DraftSyncPort,
  ImageProxy,
  LaneFor,
  Logger,
  MailHtml,
  RulesPort,
  SendPort,
  StorePort,
} from '../ports';

/**
 * Handler types for the F5 dispatch table. Only types come from the contract (plus its zod-free generated tables in
 * `dispatch`): the engine core bundles no zod, because transports validate arguments with the registry's `parseArgs`
 * at the host boundary before calling `dispatch` (ARCH 9.3), which keeps the neutral engine inside its 400,000-byte budget.
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

/**
 * The engine's services, built once by the runtime (`eng-contract`) at start and handed to every call: the only way a
 * handler reaches a port. Lanes call these and never construct their own; a new service is an additive field here.
 */
export interface EngineServices {
  store: StorePort;
  /** Account actors: connect, sync requests, leases, status, and the `ProviderPort` reads. */
  accounts: AccountActorHost;
  send: SendPort;
  drafts: DraftSyncPort;
  calendar: CalendarPort;
  rules: RulesPort;
  clock: Clock;
  deadlines: DeadlineRegistry;
  log: Logger;
  html: MailHtml;
  laneFor: LaneFor;
  /** Injected by the host (Node networking); `Mail/serve`'s image route only. */
  images: ImageProxy;
}

/** What every handler receives besides its validated arguments. */
export interface MethodContext {
  caller: Caller;
  /** Aborted when the caller cancels or disconnects. */
  signal: AbortSignal;
  services: EngineServices;
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
