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

/** Who is calling, set by the transport once it has authenticated the connection. */
export interface Caller {
  /** An Electron window's port, main's control connection, or a listener client (socket, HTTP, MCP). */
  kind: 'window' | 'host' | 'listener';
  /** Listener clients only: the MCP adapter sets `mcp`, which limits the caller to `mcpMethods` (FR-9). */
  via?: 'socket' | 'http' | 'mcp';
  /** The listener client's id (`Client.id`); absent for windows and main. */
  clientId?: string;
  scopes: readonly string[];
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
 * outside `listenerMethods`) need a window or main; and a listener may not set a `windowOnlyArgs` path. An unknown or
 * desktop method is the dispatcher's own `unsupported`, not checked here.
 */
export function checkAccess(method: string, caller: Caller, args?: unknown): void {
  const scope = methodScope[method];
  if (!scope || methodHost[method] !== 'engine') return;
  if (scope === 'host') {
    // Main's control connection only, and it must also hold the `host` scope the transport grants it.
    if (caller.kind !== 'host' || !caller.scopes.includes('host'))
      throw forbidden('Only the Aplos app itself can do that.');
    return;
  }
  if (caller.kind === 'listener') {
    if (!(listenerMethods as readonly string[]).includes(method))
      throw forbidden('Only the Aplos app itself can do that.');
    if (caller.via === 'mcp' && !(mcpMethods as readonly string[]).includes(method))
      throw forbidden('That is not available to MCP clients.');
    if (windowOnlyArgs[method]?.some(path => has(args, path)))
      throw forbidden('Change this in Aplos itself.');
  }
  requireScope(caller, scope);
}

/**
 * The second check of a `scopeRule` method (FR-3, FR-4): the caller must also hold `scope`, e.g. the scope of the method
 * that made the operation it undoes, or `send` when accepting an invitation to guests. Windows and main hold every scope.
 */
export function requireScope(caller: Caller, scope: string | undefined): void {
  if (scope && !caller.scopes.includes(scope))
    throw forbidden(`This tool does not have permission to ${scopeVerb[scope] ?? 'do that'}.`);
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
  return caller.kind === 'listener' ? `client:${caller.clientId ?? ''}` : 'app';
}

/** What a window (and main) holds: every scope. Listener clients hold what `Clients/grant` gave them. */
export const appScopes = ['read', 'triage', 'draft', 'send', 'ai', 'admin', 'host'] as const;
