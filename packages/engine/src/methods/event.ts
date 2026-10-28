import { notImplemented, type AreaHandlers } from './types';

/**
 * The `event` area, owned by lane `prov-cal`. Replace a stub with the real handler; never edit `index.ts`.
 * Arguments arrive validated; throw `ContractError` (`@aplos/contract/contract-error`) with the sentence the UI shows.
 */
export const handlers: AreaHandlers<'event'> = {
  'Calendar/get': notImplemented('Calendar/get'),
  'Calendar/set': notImplemented('Calendar/set'),
  'Event/get': notImplemented('Event/get'),
  'Event/set': notImplemented('Event/set'),
  'Event/hide': notImplemented('Event/hide'),
  'Event/rsvp': notImplemented('Event/rsvp'),
  'Event/extract': notImplemented('Event/extract'),
  'Plan/get': notImplemented('Plan/get'),
  'Plan/confirm': notImplemented('Plan/confirm'),
  'Plan/dismiss': notImplemented('Plan/dismiss'),
};
