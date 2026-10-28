import { notImplemented, type AreaHandlers } from './types';

/**
 * The `view` area, owned by lane `eng-views`. Replace a stub with the real handler; never edit `index.ts`.
 * Arguments arrive validated; throw `ContractError` (`@aplos/contract/contract-error`) with the sentence the UI shows.
 */
export const handlers: AreaHandlers<'view'> = {
  'View/watch': notImplemented('View/watch'),
  'View/move': notImplemented('View/move'),
  'View/unwatch': notImplemented('View/unwatch'),
  'View/hold': notImplemented('View/hold'),
  'View/release': notImplemented('View/release'),
  'View/query': notImplemented('View/query'),
  'Folder/get': notImplemented('Folder/get'),
  'Counts/get': notImplemented('Counts/get'),
  'SenderGroup/get': notImplemented('SenderGroup/get'),
  'Search/remote': notImplemented('Search/remote'),
};
