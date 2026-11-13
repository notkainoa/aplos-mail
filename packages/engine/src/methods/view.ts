import { searchRemote } from '../views/remote';
import { ensureViewKind } from '../views/registry';
import type { AreaHandlers } from './types';

/**
 * The `view` area, owned by lane `eng-views`: live windows, one-shot reads, the sidebar's numbers and remote search.
 * Arguments arrive validated; the window engine (`services.views`) does the work, per connection.
 */
export const handlers: AreaHandlers<'view'> = {
  'View/watch': async (args, ctx) => {
    await ensureViewKind(args.spec.kind);
    if (args.spec.kind === 'label' || args.spec.kind === 'mailbox')
      await (await import('../views/folder-fetch')).ensureFolders(ctx.services, args.spec);
    return ctx.services.views.watch(args, ctx.connectionId);
  },
  'View/move': (args, ctx) => ctx.services.views.move(args, ctx.connectionId),
  'View/unwatch': (args, ctx) => {
    ctx.services.views.unwatch(args.windowId, ctx.connectionId);
    return { ok: true };
  },
  'View/hold': (args, ctx) => {
    ctx.services.views.hold(args.windowId, args.ids, ctx.connectionId);
    return { ok: true };
  },
  'View/release': (args, ctx) => {
    ctx.services.views.release(args.windowId, args.ids, ctx.connectionId);
    return { ok: true };
  },
  'View/query': async (args, ctx) => {
    await ensureViewKind(args.spec.kind);
    if (args.spec.kind === 'label' || args.spec.kind === 'mailbox')
      await (await import('../views/folder-fetch')).ensureFolders(ctx.services, args.spec);
    return ctx.services.views.query(args);
  },
  'Folder/get': (args, ctx) => ctx.services.views.folders(args.accountId),
  'Counts/get': (_args, ctx) => ctx.services.views.counts(),
  'SenderGroup/get': (args, ctx) => ctx.services.views.senderGroups(args.ids),
  'Search/remote': (args, ctx) => searchRemote(ctx.services, args, ctx.connectionId),
};
