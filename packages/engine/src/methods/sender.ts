import type { AreaHandlers } from './types';

/**
 * The `sender` area, owned by lane `eng-views` (an area added in contract v1; owner proposed, confirm in OWNERS.md).
 * Rules are saved and applied to existing threads in one commit with a receipt (`views/sender-ops.ts`); the ingest hook
 * in `views/senders.ts` applies them to new mail. Arguments arrive validated; the methods are `triage` scope.
 */
export const handlers: AreaHandlers<'sender'> = {
  'SenderRule/get': (args, ctx) => ctx.services.senders.get(args),
  'SenderRule/set': (args, ctx) => ctx.services.senders.set(args),
  'SenderRule/destroy': (args, ctx) => ctx.services.senders.destroy(args),
  'SenderRule/block': (args, ctx) => ctx.services.senders.block(args),
  'SenderRule/unblock': (args, ctx) => ctx.services.senders.unblock(args),
};
