import { notImplemented, type AreaHandlers } from './types';

/**
 * The `sync` area, owned by lane `prov-gov`. Replace a stub with the real handler; never edit `index.ts`.
 * Arguments arrive validated; throw `ContractError` (`@aplos/contract/contract-error`) with the sentence the UI shows.
 */
export const handlers: AreaHandlers<'sync'> = {
  'Sync/request': notImplemented('Sync/request'),
};
