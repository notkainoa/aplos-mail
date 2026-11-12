import type { Output } from '@aplos/contract';
import { ContractError } from '@aplos/contract/contract-error';
import type { MethodContext } from '../methods/types';
import { renderKey, withReporter, type FrameRenderInput } from '@aplos/mail-html/frame';
import type { EngineServices } from '../runtime/services';
import { cidsOf, loadBody, type MessageRef } from './message';
import type { RequestedPolicy, ResolvedPolicy } from './policy';
import type { CachedRender } from './state';

// The render pipeline behind `Mail/frame` and `Mail/toggleQuotes`: sanitize the stored original on read through the
// `MailHtml` port, keep the result in the LRU of 12 keyed by message, RESOLVED policy, find query, quotes and sanitizer
// version, then issue a fresh token for the calling window. The cache holds the sanitizer's document without the
// reporter; `withReporter` runs on every issue, outside the cache (reviewer recommendation e).

type MailFrame = Output<'Mail/frame'>;

export interface RenderRequest {
  messageId: string;
  /** What the reader asked for; kept on the token so a toggle resolves it again. */
  requested: RequestedPolicy;
  /** `resolveImagePolicy(requested, sender, allow-list)`: what the render and the cache key use. */
  policy: ResolvedPolicy;
  findQuery?: string;
  quotesOpen: boolean;
}

function sanitizerVersion(services: EngineServices): string {
  const version: unknown = services.html.version;
  if (typeof version === 'string' && version.length > 0) return version;
  throw new ContractError({
    type: 'unavailable',
    message: 'This part of Aplos is not running yet.',
  });
}

/** Which stored copy of the message: its rowid and the seq that stored it, never `rev` (flag edits move that). */
export const bodyIdentity = (ref: Pick<MessageRef, 'rowId' | 'firstSeenSeq'>) =>
  `${ref.rowId}:${ref.firstSeenSeq}`;

export function cacheKey(
  request: Omit<RenderRequest, 'requested'>,
  ref: Pick<MessageRef, 'rowId' | 'firstSeenSeq'>,
  version: string,
): string {
  return renderKey({
    messageId: request.messageId,
    imagePolicy: request.policy,
    ...(request.findQuery !== undefined ? { findQuery: request.findQuery } : {}),
    quotesOpen: request.quotesOpen,
    version,
    body: bodyIdentity(ref),
  });
}

/** The cached render, or a fresh one from the stored body (fetched on `lane` when it is not stored). */
export async function renderMessage(
  services: EngineServices,
  ref: MessageRef,
  request: RenderRequest,
  lane: 'interactive' | 'prefetch' = 'interactive',
): Promise<CachedRender> {
  const key = cacheKey(request, ref, sanitizerVersion(services));
  const hit = services.mailFrames.cache.get(key);
  if (hit) return hit;
  const body = await loadBody(services, ref, lane);
  const cids = cidsOf(body);
  const result = services.html.render({
    ...(body.html !== undefined ? { html: body.html } : {}),
    ...(body.text !== undefined ? { text: body.text } : {}),
    cids,
    imagePolicy: request.policy,
    ...(request.findQuery !== undefined ? { findQuery: request.findQuery } : {}),
    quotesOpen: request.quotesOpen,
  });
  const rendered: CachedRender = { result, cids };
  services.mailFrames.cache.set(key, rendered);
  return rendered;
}

/** Plain-text mail has no frame: an empty `url`, and the host shows `MessageBody/get`'s text in its own DOM. */
function textFrame(services: EngineServices, rendered: CachedRender): MailFrame {
  return {
    url: '',
    expiresAt: services.clock.now(),
    bodyKind: 'text',
    trackersRemoved: 0,
    hasRemoteImages: false,
    quotedCount: rendered.result.quotedCount,
  };
}

/** What the sanitizer made of an HTML body: the cached document and the indexes it numbered. */
interface HtmlRender {
  document: string;
  remoteImages: readonly string[];
  cids: readonly string[];
}

function tokenInput(
  windowId: string,
  ref: MessageRef,
  request: RenderRequest,
  html: HtmlRender,
): FrameRenderInput {
  return {
    windowId,
    messageId: ref.id,
    accountScope: ref.accountId,
    imagePolicy: request.policy,
    requestedPolicy: request.requested,
    ...(request.findQuery !== undefined ? { findQuery: request.findQuery } : {}),
    quotesOpen: request.quotesOpen,
    document: withReporter(html.document),
    remoteImages: html.remoteImages,
    cids: html.cids,
  };
}

/**
 * Issues a token for `windowId` (the calling connection), or replaces `replacing` with it, and answers `MailFrame`.
 * `expiresAt` is the unfetched deadline: the reader re-calls `Mail/frame` when the frame's `load` fires with no report.
 */
export function issueFrame(
  services: EngineServices,
  windowId: string,
  ref: MessageRef,
  request: RenderRequest,
  rendered: CachedRender,
  replacing?: string,
): MailFrame {
  const { tokens } = services.mailFrames;
  const { result, cids } = rendered;
  if (result.bodyKind !== 'html') {
    if (replacing !== undefined) tokens.release(windowId, replacing);
    return textFrame(services, rendered);
  }
  const html = { document: result.document, remoteImages: result.remoteImages, cids };
  const input = tokenInput(windowId, ref, request, html);
  const now = services.clock.now();
  // Every window's unfetched tokens past their deadline go, not only this window's: no document waits forever.
  tokens.sweep(now);
  const issued =
    replacing !== undefined ? tokens.replace(replacing, input, now) : tokens.issue(input, now);
  return {
    url: issued.url,
    expiresAt: issued.expiresAt,
    bodyKind: 'html',
    trackersRemoved: result.trackersRemoved,
    hasRemoteImages: result.hasRemoteImages,
    quotedCount: result.quotedCount,
  };
}

/**
 * A letter that cannot open must leave a trace (fix-bodies, 2026-11-11: every HTML body answered `unavailable` and the
 * log said nothing). The runtime answers a `ContractError` as-is and never logs it, so the body methods log it here as
 * `rpc.failed` with the method and `contract.<type>` only: no id, subject, address or text. Any other throw is left to
 * the runtime's `toContractError`, which logs its own classified reason. Lives here, in the lazy render chunk, so the core
 * pays nothing for it.
 */
export async function logBodyFailure<R>(
  method: string,
  ctx: MethodContext,
  run: () => Promise<R>,
): Promise<R> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ContractError)
      ctx.services.log.event('rpc.failed', { method, reason: `contract.${error.body.type}` });
    throw error;
  }
}
