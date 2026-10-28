import { notImplemented, type AreaHandlers } from './types';

/**
 * The `unsubscribe` area, owned by lane `prov-gmail-write`. Replace a stub with the real handler; never edit `index.ts`.
 * Arguments arrive validated; throw `ContractError` (`@aplos/contract/contract-error`) with the sentence the UI shows.
 */
export const handlers: AreaHandlers<'unsubscribe'> = {
  'Unsubscribe/get': notImplemented('Unsubscribe/get'),
  'Unsubscribe/run': notImplemented('Unsubscribe/run'),
};
