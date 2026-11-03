import type { AreaHandlers } from './types';
// Brings in the `EngineServices.outbox` declaration.
import type {} from '../outbox/module';

/**
 * The `outbox` area, owned by lane `eng-time`. Replace a stub with the real handler; never edit `index.ts`.
 * Arguments arrive validated; throw `ContractError` (`@aplos/contract/contract-error`) with the sentence the UI shows.
 */
export const handlers: AreaHandlers<'outbox'> = {
  'Outbox/pending': (_args, { services }) => services.outbox.pending(),
};
