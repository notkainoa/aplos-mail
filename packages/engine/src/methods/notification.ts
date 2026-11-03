import type { AreaHandlers } from './types';

/**
 * The `notification` area, owned by lane `eng-time`. The service lives in `outbox/notifications.ts`. Both methods are
 * host methods: `dispatch` refuses every caller but main's control connection before a handler runs.
 */
export const handlers: AreaHandlers<'notification'> = {
  'Notification/claim': (args, ctx) => ({ items: ctx.services.notifications.claim(args.max) }),
  'Notification/ack': (args, ctx) => {
    ctx.services.notifications.ack(args.ids, args.state);
    return { ok: true };
  },
};
