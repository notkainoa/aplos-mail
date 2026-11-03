import type { AreaHandlers } from './types';

/**
 * The `operation` area, owned by lane `eng-views`: what happened to a command after its receipt, undo as an inverse
 * operation and retry of a failed one. `Operation/undo` and `retry` need the scope of the method that made the
 * operation as well as their own (FR-3); `services.threadOps` checks it.
 */
export const handlers: AreaHandlers<'operation'> = {
  'Operation/undo': (args, ctx) => ctx.services.threadOps.undo(args, ctx.caller),
  'Operation/get': (args, ctx) => ctx.services.threadOps.get(args.opIds),
  'Operation/retry': (args, ctx) => ctx.services.threadOps.retry(args, ctx.caller),
};
