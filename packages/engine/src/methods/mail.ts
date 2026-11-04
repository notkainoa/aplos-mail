import { allowImages } from '../mail/allow';
import { attachmentGet } from '../mail/attachment';
import { messageBody } from '../mail/body';
import { mailFrame, releaseFrame, toggleQuotes } from '../mail/frame';
import { prefetchBodies } from '../mail/prefetch';
import { getMessages } from '../mail/rows';
import { serveMail } from '../mail/serve';
import { notImplemented, type AreaHandlers } from './types';

/**
 * The `mail` area, owned by lane `eng-html`; the work lives in `src/mail/`. Arguments arrive validated; errors are
 * `ContractError`s with the sentence the UI shows. `Attachment/get` and `Message/original` are html-4 slice 3.
 */
export const handlers: AreaHandlers<'mail'> = {
  'Message/get': getMessages,
  'MessageBody/get': messageBody,
  'MessageBody/prefetch': prefetchBodies,
  'Mail/frame': mailFrame,
  'Mail/allowImages': allowImages,
  'Mail/release': releaseFrame,
  'Mail/toggleQuotes': toggleQuotes,
  'Mail/serve': serveMail,
  'Attachment/get': attachmentGet,
  'Message/original': notImplemented('Message/original'),
};
