import type { EngineMethodName } from '@aplos/contract';
import { hostMethods, listenerMethods, mcpMethods, methodScope } from '@aplos/contract/allowlists';
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

const hostOnly: ReadonlySet<string> = new Set(hostMethods);
// The generator builds `listenerMethods` as the engine methods that are not uiOnly, not secret and not `host`, so
// membership is exactly "a listener may carry this"; it stands in for a separate uiOnly table.
const listenable: ReadonlySet<string> = new Set(listenerMethods);
const mcpTools: ReadonlySet<string> = new Set(mcpMethods);

/**
 * Default deny, from the registry's generated tables (ARCH 12.3), whatever the transport already checked: the method's
 * scope must be among the caller's; `host` methods are for main's control connection only; a listener client never
 * reaches a uiOnly or secret method; an MCP client only reaches the MCP tools. Returns the refusal, or undefined.
 */
export function refusal(method: EngineMethodName, caller: Caller): string | undefined {
  if (!caller.scopes.includes(methodScope[method]))
    return 'This client does not have permission for that.';
  if (hostOnly.has(method) && caller.kind !== 'host') return 'Only the app itself can do that.';
  if (caller.kind === 'listener' && !listenable.has(method))
    return 'That can only be done in the Aplos window.';
  if (caller.kind === 'listener' && caller.via === 'mcp' && !mcpTools.has(method))
    return 'That is not available to MCP clients.';
  return undefined;
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
  if (!Object.prototype.hasOwnProperty.call(handlers, method))
    throw new ContractError({ type: 'unsupported', message: 'Unsupported application method.' });
  const denied = refusal(method as EngineMethodName, ctx.caller);
  if (denied) throw new ContractError({ type: 'forbidden', message: denied });
  return (handlers[method as EngineMethodName] as Handler<EngineMethodName>)(args as never, ctx);
}
