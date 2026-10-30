import { notImplemented, type AreaHandlers } from './types';
// Brings in the `EngineServices.draftBox` declaration.
import type {} from '../outbox/module';

/**
 * The `draft` area, owned by lane `eng-time`. Replace a stub with the real handler; never edit `index.ts`.
 * Arguments arrive validated; throw `ContractError` (`@aplos/contract/contract-error`) with the sentence the UI shows.
 */
export const handlers: AreaHandlers<'draft'> = {
  'Draft/get': (args, { services }) => services.draftBox.get(args.ids),
  'Draft/set': (args, { services }) =>
    services.draftBox.set(args.opId, {
      ...(args.id !== undefined ? { id: args.id } : {}),
      ...(args.baseRevision !== undefined ? { baseRevision: args.baseRevision } : {}),
      fields: args.fields,
    }),
  'Draft/destroy': (args, { services }) => services.draftBox.destroy(args.opId, args.id),
  'Contact/suggest': notImplemented('Contact/suggest'),
  'Draft/resolve': (args, { services }) =>
    services.draftBox.resolve(args.opId, args.id, args.choice),
};
