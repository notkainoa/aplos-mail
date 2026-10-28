import { notImplemented, type AreaHandlers } from './types';

/**
 * The `submission` area, owned by lane `eng-time`. Replace a stub with the real handler; never edit `index.ts`.
 * Arguments arrive validated; throw `ContractError` (`@aplos/contract/contract-error`) with the sentence the UI shows.
 */
export const handlers: AreaHandlers<'submission'> = {
  'Submission/get': notImplemented('Submission/get'),
  'Submission/set': notImplemented('Submission/set'),
};
