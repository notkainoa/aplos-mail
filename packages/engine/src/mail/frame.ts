import type { Input, Output } from '@aplos/contract';
import { tokenOf } from '@aplos/mail-html/frame';
import type { MethodContext } from '../methods/types';
import { messageGone, requireMessage } from './message';
import { readAllowList, readRemoteImages, requestedOf, resolveImagePolicy } from './policy';
import { issueFrame, logBodyFailure, renderMessage, type RenderRequest } from './render';

// `Mail/frame`, `Mail/release` and `Mail/toggleQuotes` (html-4). The window is the calling connection
// (`ctx.connectionId`): a token is issued to it, and only it can release, toggle or (through main's `Mail/serve`
// relay, which must pass the same connection id) load it. Another window's token is unknown here, never a hint.

type MailFrame = Output<'Mail/frame'>;

const emptyToUndefined = (value: string | undefined) => (value ? value : undefined);

export function mailFrame(args: Input<'Mail/frame'>, ctx: MethodContext): Promise<MailFrame> {
  return logBodyFailure('Mail/frame', ctx, () => frameOf(args, ctx));
}

async function frameOf(args: Input<'Mail/frame'>, ctx: MethodContext): Promise<MailFrame> {
  const { services } = ctx;
  const ref = requireMessage(services, args.messageId);
  const allowList = services.store.read(readAllowList);
  const global = services.store.read(readRemoteImages);
  const findQuery = emptyToUndefined(args.findQuery);
  const requested = requestedOf(args.imagePolicy);
  const request: RenderRequest = {
    messageId: ref.id,
    requested,
    policy: resolveImagePolicy(requested, ref.fromAddr, allowList, global),
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

/**
 * The same message, requested policy and find query with quotes opened or closed, under a new token that replaces the
 * old. The requested policy is resolved against the allow-list as it is now.
 */
export function toggleQuotes(
  args: Input<'Mail/toggleQuotes'>,
  ctx: MethodContext,
): Promise<MailFrame> {
  return logBodyFailure('Mail/toggleQuotes', ctx, () => toggled(args, ctx));
}

async function toggled(args: Input<'Mail/toggleQuotes'>, ctx: MethodContext): Promise<MailFrame> {
  const { services } = ctx;
  const token = tokenOf(args.url);
  const now = services.clock.now();
  const record = services.mailFrames.tokens.lookup(ctx.connectionId, token, now);
  if (!token || !record) throw messageGone();
  const ref = requireMessage(services, record.messageId);
  // The request is resolved again: a sender taken off the allow-list since the first render is blocked now.
  const requested = requestedOf(record.requestedPolicy);
  const allowList = services.store.read(readAllowList);
  const global = services.store.read(readRemoteImages);
  const request: RenderRequest = {
    messageId: record.messageId,
    requested,
    policy: resolveImagePolicy(requested, ref.fromAddr, allowList, global),
    ...(record.findQuery !== undefined ? { findQuery: record.findQuery } : {}),
    quotesOpen: args.open === true,
  };
  const rendered = await renderMessage(services, ref, request);
  return issueFrame(services, ctx.connectionId, ref, request, rendered, token);
}
