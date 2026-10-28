import { notImplemented, type AreaHandlers } from './types';

/**
 * The `setup` area, owned by lane `eng-ai`. Replace a stub with the real handler; never edit `index.ts`.
 * Arguments arrive validated; throw `ContractError` (`@aplos/contract/contract-error`) with the sentence the UI shows.
 */
export const handlers: AreaHandlers<'setup'> = {
  'Setup/begin': notImplemented('Setup/begin'),
  'Setup/end': notImplemented('Setup/end'),
  'Setup/retry': notImplemented('Setup/retry'),
  'Setup/status': notImplemented('Setup/status'),
};
