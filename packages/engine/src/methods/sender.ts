import { notImplemented, type AreaHandlers } from './types';

/**
 * The `sender` area, owned by lane `eng-views` (an area added in contract v1; owner proposed, confirm in OWNERS.md). Replace a stub with the real handler; never edit `index.ts`.
 * Arguments arrive validated; throw `ContractError` (`@aplos/contract/contract-error`) with the sentence the UI shows.
 */
export const handlers: AreaHandlers<'sender'> = {
  'SenderRule/get': notImplemented('SenderRule/get'),
  'SenderRule/set': notImplemented('SenderRule/set'),
  'SenderRule/destroy': notImplemented('SenderRule/destroy'),
  'SenderRule/block': notImplemented('SenderRule/block'),
  'SenderRule/unblock': notImplemented('SenderRule/unblock'),
};
