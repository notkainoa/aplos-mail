import { notImplemented, type AreaHandlers } from './types';

/**
 * The `blob` area, owned by lane `eng-contract` (an area added in contract v1; owner proposed, confirm in OWNERS.md). Replace a stub with the real handler; never edit `index.ts`.
 * Arguments arrive validated; throw `ContractError` (`@aplos/contract/contract-error`) with the sentence the UI shows.
 */
export const handlers: AreaHandlers<'blob'> = {
  'Blob/put': notImplemented('Blob/put'),
  'Blob/get': notImplemented('Blob/get'),
  'Blob/release': notImplemented('Blob/release'),
};
