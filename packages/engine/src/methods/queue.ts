import { notImplemented, type AreaHandlers } from './types';

/**
 * The `queue` area, owned by lane `eng-ai`. Replace a stub with the real handler; never edit `index.ts`.
 * Arguments arrive validated; throw `ContractError` (`@aplos/contract/contract-error`) with the sentence the UI shows.
 */
export const handlers: AreaHandlers<'queue'> = {
  'Queue/list': notImplemented('Queue/list'),
  'Queue/retry': notImplemented('Queue/retry'),
  'Queue/discard': notImplemented('Queue/discard'),
};
