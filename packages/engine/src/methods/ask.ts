import { notImplemented, type AreaHandlers } from './types';

/**
 * The `ask` area, owned by lane `eng-ai`. Replace a stub with the real handler; never edit `index.ts`.
 * Arguments arrive validated; throw `ContractError` (`@aplos/contract/contract-error`) with the sentence the UI shows.
 */
export const handlers: AreaHandlers<'ask'> = {
  'Ask/run': notImplemented('Ask/run'),
  'Ask/cancel': notImplemented('Ask/cancel'),
  'Ask/decide': notImplemented('Ask/decide'),
  'Ask/suggestions': notImplemented('Ask/suggestions'),
  'Conversation/get': notImplemented('Conversation/get'),
  'Conversation/destroy': notImplemented('Conversation/destroy'),
};
