import { notImplemented, type AreaHandlers } from './types';

/**
 * The `demo` area, owned by lane `eng-ai`. Replace a stub with the real handler; never edit `index.ts`.
 * Arguments arrive validated; throw `ContractError` (`@aplos/contract/contract-error`) with the sentence the UI shows.
 */
export const handlers: AreaHandlers<'demo'> = {
  'Demo/load': notImplemented('Demo/load'),
  'Demo/reset': notImplemented('Demo/reset'),
  'Demo/remove': notImplemented('Demo/remove'),
};
