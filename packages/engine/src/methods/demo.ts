import type { State } from '@aplos/contract';
import { loadDemo, removeDemo, resetDemo } from '../ai/demo/load';
import type { AreaHandlers, EngineServices } from './types';

/**
 * The `demo` area, owned by lane `eng-ai`: the original demo mailbox (`src/ai/demo/`) committed through the
 * store. `Demo/load` is idempotent, `Demo/reset` puts the demo back to its starting mail (refused while a
 * demo send is out) and `Demo/remove` deletes only the `provider = 'demo'` accounts. Nothing loads at
 * start: a fresh install has zero accounts.
 */
function opId(services: EngineServices, verb: string): string {
  const hex = Array.from(services.randomBytes(10), b => b.toString(16).padStart(2, '0')).join('');
  return `demo-${verb}-${hex}`;
}

const receipt = (op: string, appliedState: State) => ({ opId: op, appliedState, undoable: false });

export const handlers: AreaHandlers<'demo'> = {
  'Demo/load': (_args, ctx) => {
    const id = opId(ctx.services, 'load');
    const { accountIds, state } = loadDemo(ctx.services.store, id, ctx.services.clock.now());
    return { accountIds, receipt: receipt(id, state) };
  },
  'Demo/reset': (_args, ctx) => {
    const id = opId(ctx.services, 'reset');
    const { accountIds, state } = resetDemo(ctx.services.store, id, ctx.services.clock.now());
    return { accountIds, receipt: receipt(id, state) };
  },
  'Demo/remove': (_args, ctx) => {
    const id = opId(ctx.services, 'remove');
    const state = removeDemo(ctx.services.store, id);
    return receipt(id, state);
  },
};
