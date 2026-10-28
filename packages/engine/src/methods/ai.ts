import { notImplemented, type AreaHandlers } from './types';

/**
 * The `ai` area, owned by lane `eng-ai`. Replace a stub with the real handler; never edit `index.ts`.
 * Arguments arrive validated; throw `ContractError` (`@aplos/contract/contract-error`) with the sentence the UI shows.
 */
export const handlers: AreaHandlers<'ai'> = {
  'Ai/request': notImplemented('Ai/request'),
  'Ai/jobs': notImplemented('Ai/jobs'),
  'Ai/polish': notImplemented('Ai/polish'),
  'Ai/draft': notImplemented('Ai/draft'),
  'Ai/transcribe': notImplemented('Ai/transcribe'),
  'Ai/cancel': notImplemented('Ai/cancel'),
  'Ai/followup': notImplemented('Ai/followup'),
  'Ai/dismissFollowup': notImplemented('Ai/dismissFollowup'),
  'Ai/providers': notImplemented('Ai/providers'),
  'Ai/models': notImplemented('Ai/models'),
  'Ai/status': notImplemented('Ai/status'),
  'Ai/usage': notImplemented('Ai/usage'),
  'Ai/setKey': notImplemented('Ai/setKey'),
  'Ai/removeKey': notImplemented('Ai/removeKey'),
  'Ai/testKey': notImplemented('Ai/testKey'),
  'Ai/test': notImplemented('Ai/test'),
};
