import type { Input, Output } from '@aplos/contract';
import { tokenOf } from '@aplos/mail-html/frame';
import type { MethodContext } from '../methods/types';
import { messageGone, requireMessage } from './message';
import { readAllowList, resolveImagePolicy } from './policy';
import { issueFrame, renderMessage, type RenderRequest } from './render';

// `Mail/frame`, `Mail/release` and `Mail/toggleQuotes` (html-4). The window is the calling connection
// (`ctx.connectionId`): a token is issued to it, and only it can release, toggle or (through main's `Mail/serve`
// relay, which must pass the same connection id) load it. Another window's token is unknown here, never a hint.

type MailFrame = Output<'Mail/frame'>;

const emptyToUndefined = (value: string | undefined) => (value ? value : undefined);

export async function mailFrame(args: Input<'Mail/frame'>, ctx: MethodContext): Promise<MailFrame> {
  const { services } = ctx;
  const ref = requireMessage(services, args.messageId);
  const allowList = services.store.read(readAllowList);
  const findQuery = emptyToUndefined(args.findQuery);
  const request: RenderRequest = {
    messageId: ref.id,
    policy: resolveImagePolicy(args.imagePolicy, ref.fromAddr, allowList),
    ...(findQuery !== undefined ? { findQuery } : {}),
    quotesOpen: args.quotesOpen === true,
  };
  const rendered = await renderMessage(services, ref, request);
  return issueFrame(services, ctx.connectionId, ref, request, rendered);
}

/** Always `Ok`: an unknown, spent or other window's URL frees nothing and says nothing. */
export function releaseFrame(args: Input<'Mail/release'>, ctx: MethodContext): { ok: true } {
  ctx.services.mailFrames.tokens.release(ctx.connectionId, args.url);
  return { ok: true };
}

/** The same message, policy and find query with quotes opened or closed, under a new token that replaces the old. */
export async function toggleQuotes(
  args: Input<'Mail/toggleQuotes'>,
  ctx: MethodContext,
): Promise<MailFrame> {
  const { services } = ctx;
  const token = tokenOf(args.url);
  const now = services.clock.now();
  const record = services.mailFrames.tokens.lookup(ctx.connectionId, token, now);
  if (!token || !record) throw messageGone();
  const ref = requireMessage(services, record.messageId);
  const request: RenderRequest = {
    messageId: record.messageId,
    policy: record.imagePolicy === 'allow' ? 'allow' : 'block',
    ...(record.findQuery !== undefined ? { findQuery: record.findQuery } : {}),
    quotesOpen: args.open === true,
  };
  const rendered = await renderMessage(services, ref, request);
  return issueFrame(services, ctx.connectionId, ref, request, rendered, token);
}
