import { notImplemented, type AreaHandlers } from './types';

/**
 * The `draft` area, owned by lane `eng-time`. Replace a stub with the real handler; never edit `index.ts`.
 * Arguments arrive validated; throw `ContractError` (`@aplos/contract/contract-error`) with the sentence the UI shows.
 */
export const handlers: AreaHandlers<'draft'> = {
  'Draft/get': notImplemented('Draft/get'),
  'Draft/set': notImplemented('Draft/set'),
  'Draft/destroy': notImplemented('Draft/destroy'),
  'Contact/suggest': notImplemented('Contact/suggest'),
  'Draft/resolve': notImplemented('Draft/resolve'),
};
