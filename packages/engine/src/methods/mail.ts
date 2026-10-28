import { notImplemented, type AreaHandlers } from './types';

/**
 * The `mail` area, owned by lane `eng-html`. Replace a stub with the real handler; never edit `index.ts`.
 * Arguments arrive validated; throw `ContractError` (`@aplos/contract/contract-error`) with the sentence the UI shows.
 */
export const handlers: AreaHandlers<'mail'> = {
  'Message/get': notImplemented('Message/get'),
  'MessageBody/get': notImplemented('MessageBody/get'),
  'MessageBody/prefetch': notImplemented('MessageBody/prefetch'),
  'Mail/frame': notImplemented('Mail/frame'),
  'Mail/allowImages': notImplemented('Mail/allowImages'),
  'Mail/release': notImplemented('Mail/release'),
  'Mail/toggleQuotes': notImplemented('Mail/toggleQuotes'),
  'Mail/serve': notImplemented('Mail/serve'),
  'Attachment/get': notImplemented('Attachment/get'),
  'Message/original': notImplemented('Message/original'),
};
