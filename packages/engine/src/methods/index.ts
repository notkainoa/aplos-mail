import type { EngineMethodName } from '@aplos/contract';
import { checkAccess } from '@aplos/contract/access';
import { ContractError } from '@aplos/contract/contract-error';
import type { Caller, EngineHandlers, Handler, MethodContext } from './types';
import { handlers as session } from './session';
import { handlers as settings } from './settings';
import { handlers as view } from './view';
import { handlers as thread } from './thread';
import { handlers as operation } from './operation';
import { handlers as submission } from './submission';
import { handlers as draft } from './draft';
import { handlers as outbox } from './outbox';
import { handlers as later } from './later';
import { handlers as reminder } from './reminder';
import { handlers as notification } from './notification';
import { handlers as ai } from './ai';
import { handlers as ask } from './ask';
import { handlers as setup } from './setup';
import { handlers as demo } from './demo';
import { handlers as consent } from './consent';
import { handlers as queue } from './queue';
import { handlers as mail } from './mail';
import { handlers as diagnostics } from './diagnostics';
import { handlers as listener } from './listener';
import { handlers as clients } from './clients';
import { handlers as account } from './account';
import { handlers as sync } from './sync';
import { handlers as unsubscribe } from './unsubscribe';
import { handlers as event } from './event';
import { handlers as blob } from './blob';
import { handlers as sender } from './sender';
import { handlers as data } from './data';
import { handlers as workflow } from './workflow';

export type {
  AreaHandlers,
  Caller,
  EngineHandlers,
  EngineServices,
  Handler,
  MethodContext,
} from './types';

/**
 * The F5 dispatch table: every engine method of contract v1 to one handler in its area's file. Lanes fill their own
 * `methods/<area>.ts` and never edit this file; a new area is a contract change made by `eng-contract`.
 */
export const handlers: EngineHandlers = {
  ...session,
  ...settings,
  ...view,
  ...thread,
  ...operation,
  ...submission,
  ...draft,
  ...outbox,
  ...later,
  ...reminder,
  ...notification,
  ...ai,
  ...ask,
  ...setup,
  ...demo,
  ...consent,
  ...queue,
  ...mail,
  ...diagnostics,
  ...listener,
  ...clients,
  ...account,
  ...sync,
  ...unsubscribe,
  ...event,
  ...blob,
  ...sender,
  ...data,
  ...workflow,
};

/**
 * Default deny with the contract's one rule set (`checkAccess`, ARCH 12.3), whatever the transport already checked: the
 * method's scope must be among the caller's; `host` methods are for main's control connection only; a listener client
 * never reaches a uiOnly or secret method or sets a window-only argument; an MCP client only reaches the MCP tools.
 * Returns the refusal, or undefined. `scopeRule` methods also call `requireScope` in their handler (FR-3, FR-4).
 */
export function refusal(
  method: EngineMethodName,
  caller: Caller,
  args?: unknown,
): string | undefined {
  try {
    checkAccess(method, caller, args);
    return undefined;
  } catch (error) {
    if (error instanceof ContractError) return error.message;
    throw error;
  }
}

/**
 * Whether the listener client behind this call has been revoked (`clients.revoked_at`): checked on EVERY call, so a
 * revoked tool that still holds a connection cannot use it, whatever the transport does about open connections. A client
 * with no row is the transport's to authenticate; only a stamped revocation refuses here.
 */
function revoked(ctx: MethodContext): boolean {
  const { caller } = ctx;
  if (caller.kind !== 'listener' || !caller.clientId) return false;
  const id = caller.clientId;
  return ctx.services.store.read(
    q =>
      q.get<{ revoked_at: number | null }>('SELECT revoked_at FROM clients WHERE id = ?', id)
        ?.revoked_at != null,
  );
}

/**
 * Runs one call whose arguments the transport has already validated (`parseArgs`). Rejects with `unsupported` for a
 * name the engine does not serve, and with `forbidden` when `refusal` denies the caller, before any handler runs.
 */
export async function dispatch(
  method: string,
  args: unknown,
  ctx: MethodContext,
): Promise<unknown> {
  return dispatchWith(handlers, method, args, ctx);
}

/** `dispatch` over a given table with the same checks; the runtime uses it so tests can replace a handler. */
export async function dispatchWith(
  table: EngineHandlers,
  method: string,
  args: unknown,
  ctx: MethodContext,
): Promise<unknown> {
  if (!Object.prototype.hasOwnProperty.call(handlers, method))
    throw new ContractError({ type: 'unsupported', message: 'Unsupported application method.' });
  const denied = refusal(method as EngineMethodName, ctx.caller, args);
  if (denied) throw new ContractError({ type: 'forbidden', message: denied });
  if (revoked(ctx))
    throw new ContractError({ type: 'forbidden', message: 'This tool is no longer allowed.' });
  return (table[method as EngineMethodName] as Handler<EngineMethodName>)(args as never, ctx);
}
