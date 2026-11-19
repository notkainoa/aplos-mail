import { viewEnv } from '../views/page';
import { openThread } from '../views/open';
import { readThreadRows } from '../views/rows';
import { readWhy } from '../views/why';
import type { AreaHandlers } from './types';

/**
 * The `thread` area, owned by lane `eng-views`: rows, triage commands with receipts, "why it's here" and the reader's
 * open. Arguments arrive validated; `services.threadOps` (`views/commands.ts`) applies the commands.
 */
export const handlers: AreaHandlers<'thread'> = {
  'Thread/get': (args, ctx) => {
    const { store, clock, views } = ctx.services;
    const state = { dbEpoch: store.dbEpoch, seq: store.seq() };
    return store.read(q => readThreadRows(q, args.ids, viewEnv(q, clock.now(), views.zone), state));
  },
  'Thread/act': (args, ctx) => ctx.services.threadOps.act(args, ctx.caller),
  'Thread/why': (args, ctx) => ctx.services.store.read(q => readWhy(q, args.threadId)),
  'Thread/open': (args, ctx) => openThread(ctx.services, args.threadId),
};
