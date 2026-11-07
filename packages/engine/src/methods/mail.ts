import { allowImages } from '../mail/allow';
import { attachmentGet } from '../mail/attachment';
import { messageOriginal } from '../mail/original';
import { getMessages } from '../mail/rows';
import type { AreaHandlers } from './types';

/**
 * The `mail` area, owned by lane `eng-html`; the work lives in `src/mail/`. Arguments arrive validated; errors are
 * `ContractError`s with the sentence the UI shows. `Attachment/get` and `Message/original` are html-4 slice 3.
 *
 * The renderer and the `aplos-mail://` server (the frame code of `@aplos/mail-html`, about 8 KB minified) load on first
 * use: `Message/get`, `Mail/allowImages`, `Attachment/get` and `Message/original` stay static, every handler that renders
 * or serves is a thin dispatcher into a lazy module (listed in `tests/portability.test.ts`), so nothing in the core
 * imports them. `Message/original` must stay static: it reaches `runtime/blobs`, which imports `runtime/engine`, and a
 * dynamic edge into that cycle makes esbuild wrap the engine root in the release bundle (the kill-point grep fails).
 */
const Frame = () => import('../mail/frame');
const Body = () => import('../mail/body');
const Prefetch = () => import('../mail/prefetch');
const Serve = () => import('../mail/serve');

export const handlers: AreaHandlers<'mail'> = {
  'Message/get': getMessages,
  'MessageBody/get': async (args, ctx) => (await Body()).messageBody(args, ctx),
  'MessageBody/prefetch': async (args, ctx) => (await Prefetch()).prefetchBodies(args, ctx),
  'Mail/frame': async (args, ctx) => (await Frame()).mailFrame(args, ctx),
  'Mail/allowImages': allowImages,
  'Mail/release': async (args, ctx) => (await Frame()).releaseFrame(args, ctx),
  'Mail/toggleQuotes': async (args, ctx) => (await Frame()).toggleQuotes(args, ctx),
  'Mail/serve': async (args, ctx) => (await Serve()).serveMail(args, ctx),
  'Attachment/get': attachmentGet,
  'Message/original': messageOriginal,
};
