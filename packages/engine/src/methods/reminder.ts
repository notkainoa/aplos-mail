import { notImplemented, type AreaHandlers } from './types';

/**
 * The `reminder` area, owned by lane `eng-time`. Replace a stub with the real handler; never edit `index.ts`.
 * Arguments arrive validated; throw `ContractError` (`@aplos/contract/contract-error`) with the sentence the UI shows.
 */
export const handlers: AreaHandlers<'reminder'> = {
  'Reminder/list': notImplemented('Reminder/list'),
  'Reminder/ack': notImplemented('Reminder/ack'),
};
