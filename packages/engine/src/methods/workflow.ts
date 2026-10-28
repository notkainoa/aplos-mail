import { notImplemented, type AreaHandlers } from './types';

/**
 * The `workflow` area, owned by lane `prov-gmail` (an area added in contract v1; owner proposed, confirm in OWNERS.md). Replace a stub with the real handler; never edit `index.ts`.
 * Arguments arrive validated; throw `ContractError` (`@aplos/contract/contract-error`) with the sentence the UI shows.
 */
export const handlers: AreaHandlers<'workflow'> = {
  'Workflow/status': notImplemented('Workflow/status'),
  'Workflow/enable': notImplemented('Workflow/enable'),
  'Workflow/code': notImplemented('Workflow/code'),
  'Workflow/disable': notImplemented('Workflow/disable'),
};
