import type { EngineMethodName } from '@aplos/contract';
import { ContractError } from '@aplos/contract/contract-error';
import type { EngineHandlers, Handler, MethodContext } from './types';
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

export type { AreaHandlers, Caller, EngineHandlers, Handler, MethodContext } from './types';

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
 * Runs one call whose arguments the transport has already validated (`parseArgs`) and whose scope it has checked.
 * Rejects with `unsupported` for a name the engine does not serve.
 */
export async function dispatch(method: string, args: unknown, ctx: MethodContext): Promise<unknown> {
  if (!Object.prototype.hasOwnProperty.call(handlers, method)) throw new ContractError({ type: 'unsupported', message: 'Unsupported application method.' });
  return (handlers[method as EngineMethodName] as Handler<EngineMethodName>)(args as never, ctx);
}
