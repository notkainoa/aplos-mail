import { requireScope } from '@aplos/contract/access';
import { assertOwnedAttachments } from '../outbox/draft-owner';
import { notImplemented, type AreaHandlers } from './types';
// Brings in the `EngineServices.draftBox` declaration.
import type {} from '../outbox/module';

/**
 * The `draft` area, owned by lane `eng-time`. Replace a stub with the real handler; never edit `index.ts`.
 * Arguments arrive validated; throw `ContractError` (`@aplos/contract/contract-error`) with the sentence the UI shows.
 */
export const handlers: AreaHandlers<'draft'> = {
  'Draft/get': (args, { services }) => services.draftBox.get(args.ids),
  'Draft/set': (args, { services, caller }) => {
    // The ownership check and the commit share this turn: nothing awaits between them.
    assertOwnedAttachments(services, caller, args.opId, args.id, args.fields.attachments);
    return services.draftBox.set(args.opId, {
      ...(args.id !== undefined ? { id: args.id } : {}),
      ...(args.baseRevision !== undefined ? { baseRevision: args.baseRevision } : {}),
      fields: args.fields,
    });
  },
  // Discarding a draft with a live send cancels that send, so it needs `send` as well (scopeRule 'originating').
  'Draft/destroy': (args, { services, caller }) =>
    services.draftBox.destroy(args.opId, args.id, () => requireScope(caller, 'send')),
  'Contact/suggest': notImplemented('Contact/suggest'),
  'Draft/resolve': (args, { services }) =>
    services.draftBox.resolve(args.opId, args.id, args.choice),
};
