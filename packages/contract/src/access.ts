import { ContractError } from './contract-error';
import {
  listenerMethods,
  mcpMethods,
  methodHost,
  methodScope,
  windowOnlyArgs,
} from '../generated/methods.generated';

/*
 * Who may call what, from the generated tables alone (no zod), so the neutral engine's dispatch, every transport and the
 * stand-in engine deny by default with one rule set (ARCH 12.3; freeze FR-3, FR-5, FR-6, FR-11).
 * `@aplos/contract/access`.
 */

/**
 * Who is calling, set by the transport once it has authenticated the connection. A listener's caller is built with
 * `listenerCaller` from the stored `Client` row its token matched, never from the `Hello` frame (freeze R2B-3).
 */
export interface Caller {
  /** An Electron window's port, main's control connection, or a listener client (socket, HTTP, MCP). */
  kind: 'window' | 'host' | 'listener';
  /**
   * Listener clients only, required: the transport, or `mcp` whenever the stored `Client.kind` is `mcp`, so an MCP
   * client is limited to `mcpMethods` (FR-9) on the socket and HTTP too. A listener without one is refused.
   */
  via?: 'socket' | 'http' | 'mcp';
  /** Listener clients only, required: the stored `Client.id`. A listener without one is refused; absent for windows and main. */
  clientId?: string;
  scopes: readonly string[];
}

/**
 * The only way a transport makes a listener's `Caller` (freeze R2B-3): `clientId`, `scopes` and the MCP limit come from the
 * `Client` row the token's hash matched, so a self-declared `Hello.client.kind` or an adapter that forgets `via` cannot
 * widen them. A revoked client is refused.
 */
export function listenerCaller(
  client: { id: string; kind: string; scopes: readonly string[]; revokedAt?: number },
  transport: 'socket' | 'http' | 'mcp',
): Caller {
  if (client.revokedAt !== undefined) throw forbidden('This tool is no longer allowed.');
  return {
    kind: 'listener',
    via: client.kind === 'mcp' ? 'mcp' : transport,
    clientId: client.id,
    scopes: client.scopes.filter(s => s !== 'host'),
  };
}

const forbidden = (message: string) => new ContractError({ type: 'forbidden', message });

const has = (args: unknown, path: string) => {
  let at: unknown = args;
  for (const key of path.split('.')) {
    if (!at || typeof at !== 'object' || !Object.prototype.hasOwnProperty.call(at, key))
      return false;
    at = (at as Record<string, unknown>)[key];
  }
  return at !== undefined;
};

/**
 * The default-deny check every dispatch makes before a handler runs, after `parseArgs`. Throws `forbidden` unless the
 * method's scope is in `caller.scopes`; `host` methods need main's connection; `uiOnly` and `secret` methods (everything
 * outside `listenerMethods`) need a window or main; and a listener may not set a `windowOnlyArgs` path. A listener is
 * refused anything outside `listenerMethods` first, whatever the name; any other name that is not a registered engine
 * method (a desktop method, `Fixture/control`, `toString`) is `unsupported` (freeze R2H-3).
 */
export function checkAccess(method: string, caller: Caller, args?: unknown): void {
  if (caller.kind === 'listener') {
    // Fail closed (R2B-3): a listener the transport did not identify from its stored client gets nothing.
    if (!caller.clientId || !caller.via) throw forbidden('This tool is not allowed in Aplos.');
    if (!(listenerMethods as readonly string[]).includes(method))
      throw forbidden('Only the Aplos app itself can do that.');
  }
  // Own-property lookups only, so a prototype key never reads as a method (R2H-3).
  const scope = Object.hasOwn(methodScope, method) ? methodScope[method] : undefined;
  if (!scope || !Object.hasOwn(methodHost, method) || methodHost[method] !== 'engine')
    throw new ContractError({ type: 'unsupported', message: 'Unsupported application method.' });
  if (scope === 'host') {
    // Main's control connection only, and it must also hold the `host` scope the transport grants it.
    if (caller.kind !== 'host' || !caller.scopes.includes('host'))
      throw forbidden('Only the Aplos app itself can do that.');
    return;
  }
  if (caller.kind === 'listener') {
    if (caller.via === 'mcp' && !(mcpMethods as readonly string[]).includes(method))
      throw forbidden('That is not available to MCP clients.');
    const paths = Object.hasOwn(windowOnlyArgs, method) ? windowOnlyArgs[method] : undefined;
    if (paths?.some(path => has(args, path))) throw forbidden('Change this in Aplos itself.');
  }
  requireScope(caller, scope);
}

/**
 * The second check of a `scopeRule` method (FR-3, FR-4): the caller must also hold `scope`, e.g. `send` when accepting an
 * invitation to guests or discarding a draft with a live send. Windows and main hold every scope.
 */
export function requireScope(caller: Caller, scope: string): void {
  if (!caller.scopes.includes(scope))
    throw forbidden(`This tool does not have permission to ${scopeVerb[scope] ?? 'do that'}.`);
}

/**
 * The `originating` check (FR-3), fail closed (freeze R2B-1): the caller must also hold the scope of the method that made
 * the operation or queue item. `op.scope` is that scope as recorded (always, from v1); when it was not recorded, the scope
 * of `op.method`, the method that made it, stands in, and when neither is known a listener is refused. Windows and main
 * hold every scope.
 */
export function requireOriginating(
  caller: Caller,
  op: { scope?: string | null; method: string },
): void {
  const scope =
    op.scope || (Object.hasOwn(methodScope, op.method) ? methodScope[op.method] : undefined);
  if (scope) return requireScope(caller, scope);
  if (caller.kind === 'listener') throw forbidden('This tool does not have permission to do that.');
}

const scopeVerb: Record<string, string> = {
  read: 'read your mail',
  triage: 'change your mail',
  draft: 'write drafts',
  send: 'send mail or invitations',
  ai: 'use AI',
  admin: 'change settings',
};

/**
 * Who owns a blob or a frame token (FR-6): every Electron window and main are one principal, the app; each listener client
 * is its own. A handle made by one principal is `notFound` to every other, and one made by a `uiOnly` method never
 * reaches a listener at all.
 */
export function principalOf(caller: Caller): string {
  if (caller.kind !== 'listener') return 'app';
  // Never a shared `client:` principal for listeners the transport did not identify (R2B-3).
  if (!caller.clientId) throw forbidden('This tool is not allowed in Aplos.');
  return `client:${caller.clientId}`;
}

/** What a window (and main) holds: every scope. Listener clients hold what `Clients/grant` gave them. */
export const appScopes = ['read', 'triage', 'draft', 'send', 'ai', 'admin', 'host'] as const;
