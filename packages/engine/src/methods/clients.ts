import { notImplemented, type AreaHandlers } from './types';

/**
 * The `clients` area, owned by lane `eng-host`. Replace a stub with the real handler; never edit `index.ts`.
 * Arguments arrive validated; throw `ContractError` (`@aplos/contract/contract-error`) with the sentence the UI shows.
 */
export const handlers: AreaHandlers<'clients'> = {
  'Clients/list': notImplemented('Clients/list'),
  'Clients/grant': notImplemented('Clients/grant'),
  'Clients/revoke': notImplemented('Clients/revoke'),
  'Clients/audit': notImplemented('Clients/audit'),
};
