import { notImplemented, type AreaHandlers } from './types';

/**
 * The `diagnostics` area, owned by lane `eng-host`. Replace a stub with the real handler; never edit `index.ts`.
 * Arguments arrive validated; throw `ContractError` (`@aplos/contract/contract-error`) with the sentence the UI shows.
 */
export const handlers: AreaHandlers<'diagnostics'> = {
  'Diagnostics/preview': notImplemented('Diagnostics/preview'),
  'Diagnostics/export': notImplemented('Diagnostics/export'),
  'Diagnostics/verbose': notImplemented('Diagnostics/verbose'),
};
