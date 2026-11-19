import type { AreaHandlers } from './types';

/**
 * The `reminder` area, owned by lane `eng-time`. The service lives in `clock/sources/reminders.ts`. `Reminder/ack` only
 * marks fired reminders seen, so it has no inverse.
 */
export const handlers: AreaHandlers<'reminder'> = {
  'Reminder/list': (_args, ctx) => ({ items: ctx.services.reminders.list() }),
  'Reminder/ack': (args, ctx) => ({
    opId: args.opId,
    appliedState: ctx.services.reminders.ack(args.opId, args.threadIds),
    undoable: false,
  }),
};
