import { notImplemented, type AreaHandlers } from './types';

/**
 * The `thread` area, owned by lane `eng-views`. Replace a stub with the real handler; never edit `index.ts`.
 * Arguments arrive validated; throw `ContractError` (`@aplos/contract/contract-error`) with the sentence the UI shows.
 */
export const handlers: AreaHandlers<'thread'> = {
  'Thread/get': notImplemented('Thread/get'),
  'Thread/act': notImplemented('Thread/act'),
  'Thread/why': notImplemented('Thread/why'),
  'Thread/open': notImplemented('Thread/open'),
};
