import { notImplemented, type AreaHandlers } from './types';

/**
 * The `listener` area, owned by lane `eng-host`. Replace a stub with the real handler; never edit `index.ts`.
 * Arguments arrive validated; throw `ContractError` (`@aplos/contract/contract-error`) with the sentence the UI shows.
 */
export const handlers: AreaHandlers<'listener'> = {
  'Listener/get': notImplemented('Listener/get'),
  'Listener/set': notImplemented('Listener/set'),
};
