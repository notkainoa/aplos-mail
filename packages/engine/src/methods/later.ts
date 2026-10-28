import { notImplemented, type AreaHandlers } from './types';

/**
 * The `later` area, owned by lane `eng-time`. Replace a stub with the real handler; never edit `index.ts`.
 * Arguments arrive validated; throw `ContractError` (`@aplos/contract/contract-error`) with the sentence the UI shows.
 */
export const handlers: AreaHandlers<'later'> = {
  'Later/presets': notImplemented('Later/presets'),
};
