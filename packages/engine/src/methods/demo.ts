import type { State } from '@aplos/contract';
import type { AreaHandlers, EngineServices } from './types';

const load = () => import('../ai/demo/load');

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
  'Demo/load': async (_args, ctx) => {
    const { lazyDemoWrites, loadDemo } = await load();
    const writes = await lazyDemoWrites();
    const id = opId(ctx.services, 'load');
    const applied = loadDemo(ctx.services.store, id, ctx.services.clock.now(), writes);
    // `applied.opId` is the commit's own opId, or 'demo-load-noop' when nothing was committed.
    return { accountIds: applied.accountIds, receipt: receipt(applied.opId, applied.state) };
  },
  'Demo/reset': async (_args, ctx) => {
    const { lazyDemoWrites, resetDemo } = await load();
    const writes = await lazyDemoWrites();
    const id = opId(ctx.services, 'reset');
    const applied = resetDemo(ctx.services.store, id, ctx.services.clock.now(), writes);
    return { accountIds: applied.accountIds, receipt: receipt(applied.opId, applied.state) };
  },
  'Demo/remove': async (_args, ctx) => {
    const { removeDemo } = await load();
    const id = opId(ctx.services, 'remove');
    const applied = removeDemo(ctx.services.store, id);
    return receipt(applied.opId, applied.state);
  },
};
