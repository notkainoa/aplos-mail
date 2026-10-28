import { notImplemented, type AreaHandlers } from './types';

/**
 * The `data` area, owned by lane `eng-store` (an area added in contract v1; owner proposed, confirm in OWNERS.md). Replace a stub with the real handler; never edit `index.ts`.
 * Arguments arrive validated; throw `ContractError` (`@aplos/contract/contract-error`) with the sentence the UI shows.
 */
export const handlers: AreaHandlers<'data'> = {
  'Data/export': notImplemented('Data/export'),
};
