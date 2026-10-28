import { notImplemented, type AreaHandlers } from './types';

/**
 * The `operation` area, owned by lane `eng-views`. Replace a stub with the real handler; never edit `index.ts`.
 * Arguments arrive validated; throw `ContractError` (`@aplos/contract/contract-error`) with the sentence the UI shows.
 */
export const handlers: AreaHandlers<'operation'> = {
  'Operation/undo': notImplemented('Operation/undo'),
  'Operation/get': notImplemented('Operation/get'),
  'Operation/retry': notImplemented('Operation/retry'),
};
