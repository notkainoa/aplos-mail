import { notImplemented, type AreaHandlers } from './types';

/**
 * The `consent` area, owned by lane `eng-ai`. Replace a stub with the real handler; never edit `index.ts`.
 * Arguments arrive validated; throw `ContractError` (`@aplos/contract/contract-error`) with the sentence the UI shows.
 */
export const handlers: AreaHandlers<'consent'> = {
  'Consent/get': notImplemented('Consent/get'),
  'Consent/grant': notImplemented('Consent/grant'),
  'Consent/revoke': notImplemented('Consent/revoke'),
};
