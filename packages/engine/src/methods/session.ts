import { notImplemented, type AreaHandlers } from './types';

/**
 * The `session` area, owned by lane `eng-contract`. Replace a stub with the real handler; never edit `index.ts`.
 * Arguments arrive validated; throw `ContractError` (`@aplos/contract/contract-error`) with the sentence the UI shows.
 */
export const handlers: AreaHandlers<'session'> = {
  'Session/get': notImplemented('Session/get'),
  'Session/changes': notImplemented('Session/changes'),
};
