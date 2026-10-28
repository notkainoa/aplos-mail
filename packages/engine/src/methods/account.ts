import { notImplemented, type AreaHandlers } from './types';

/**
 * The `account` area, owned by lane `prov-gov`. Replace a stub with the real handler; never edit `index.ts`.
 * Arguments arrive validated; throw `ContractError` (`@aplos/contract/contract-error`) with the sentence the UI shows.
 */
export const handlers: AreaHandlers<'account'> = {
  'Account/get': notImplemented('Account/get'),
  'Account/discover': notImplemented('Account/discover'),
  'Account/connect': notImplemented('Account/connect'),
  'Account/reconnect': notImplemented('Account/reconnect'),
  'Account/updateSecret': notImplemented('Account/updateSecret'),
  'Account/grantPermissions': notImplemented('Account/grantPermissions'),
  'Account/cancelConnect': notImplemented('Account/cancelConnect'),
  'Account/set': notImplemented('Account/set'),
  'Account/lease': notImplemented('Account/lease'),
  'Account/disconnect': notImplemented('Account/disconnect'),
};
