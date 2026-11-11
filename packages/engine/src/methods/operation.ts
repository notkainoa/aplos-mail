import type { Operation } from '@aplos/contract';
import type { AreaHandlers } from './types';

/**
 * The `operation` area, owned by lane `eng-views`: what happened to a command after its receipt, undo as an inverse
 * operation and retry of a failed one. `Operation/undo` and `retry` need the scope of the method that made the
 * operation as well as their own (FR-3); `services.threadOps` checks it. A held calendar write (a change that tells
 * guests, waiting its undo window) is asked first through `services.calendarHolds` (prov-cal), which checks the same.
 */
export const handlers: AreaHandlers<'operation'> = {
  'Operation/undo': (args, ctx) => {
    const holds = ctx.services.calendarHolds;
    return holds?.has(args.opId)
      ? holds.undo(args, ctx.caller)
      : ctx.services.threadOps.undo(args, ctx.caller);
  },
  'Operation/get': async (args, ctx) => {
    const holds = ctx.services.calendarHolds;
    const held = holds ? args.opIds.filter(id => holds.has(id)) : [];
    const mail = ctx.services.threadOps.get(args.opIds.filter(id => !held.includes(id)));
    if (!holds || !held.length) return mail;
    // One list in the order asked, whichever side knows the id.
    const known = new Map<string, Operation>(
      [...mail.list, ...(await holds.get(held))].map(op => [op.opId, op]),
    );
    return {
      list: args.opIds.flatMap(id => (known.has(id) ? [known.get(id)!] : [])),
      notFound: mail.notFound,
    };
  },
  'Operation/retry': (args, ctx) => {
    const holds = ctx.services.calendarHolds;
    return holds?.has(args.opId)
      ? holds.retry(args, ctx.caller)
      : ctx.services.threadOps.retry(args, ctx.caller);
  },
};
