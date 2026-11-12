import type { Input, Output } from '@aplos/contract';
import type { MethodContext } from '../methods/types';
import type { BodyRecord } from '../store/port';
import { htmlToText } from '../outbox/mime';
import { loadBody, requireMessage } from './message';
import { readAllowList, readRemoteImages, resolveImagePolicy } from './policy';
import { logBodyFailure, renderMessage } from './render';

// `MessageBody/get`: the plain-text rendering and quote ranges of a body, fetched on the interactive lane when it is
// not stored. HTML is never returned: an HTML body is run through the sanitizer only for its counts (the same render
// `Mail/frame` with `block` would make, so it also warms the cache), and `text` is the message's own text/plain part.

type Body = Output<'MessageBody/get'>;

function kindOf(body: BodyRecord): Body['bodyKind'] {
  if (typeof body.html === 'string' && body.html.trim()) return 'html';
  return typeof body.text === 'string' && body.text ? 'text' : 'none';
}

type Range = Body['quoted'][number];

function fits(range: unknown, floor: number, length: number): range is Range {
  const { start, end } = (range ?? {}) as Partial<Record<'start' | 'end', unknown>>;
  if (typeof start !== 'number' || typeof end !== 'number') return false;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return false;
  return start >= floor && end > start && end <= length;
}

/** The stored quote ranges that fit the text, in order, never overlapping. */
export function quotedRanges(body: BodyRecord, length: number): Body['quoted'] {
  const ranges: unknown[] = Array.isArray(body.quotedRanges) ? body.quotedRanges : [];
  const out: Body['quoted'] = [];
  let floor = 0;
  for (const range of ranges) {
    if (!fits(range, floor, length)) continue;
    out.push({ start: range.start, end: range.end });
    floor = range.end;
  }
  return out;
}

export function messageBody(args: Input<'MessageBody/get'>, ctx: MethodContext): Promise<Body> {
  return logBodyFailure('MessageBody/get', ctx, () => readBody(args, ctx));
}

async function readBody(args: Input<'MessageBody/get'>, ctx: MethodContext): Promise<Body> {
  const { services } = ctx;
  const ref = requireMessage(services, args.messageId);
  const body = await loadBody(services, ref);
  // An HTML-only letter still answers text: the same strip the draft engine uses for its text/plain.
  // Ranges are UTF-16 offsets into this exact string — a provider that ever records quotedRanges on
  // an HTML-only letter must compute them against this derivation, or `fits` drops them (degrades,
  // never wrong-quote).
  const text =
    typeof body.text === 'string' && body.text.trim()
      ? body.text
      : typeof body.html === 'string'
        ? htmlToText(body.html)
        : '';
  const quoted = quotedRanges(body, text.length);
  const bodyKind = kindOf(body);
  const base = { messageId: ref.id, bodyKind, text, quoted };
  if (bodyKind !== 'html') return { ...base, quotedCount: quoted.length, hasRemoteImages: false };
  const allowList = services.store.read(readAllowList);
  const global = services.store.read(readRemoteImages);
  const policy = resolveImagePolicy('block', ref.fromAddr, allowList, global);
  const { result } = await renderMessage(services, ref, {
    messageId: ref.id,
    requested: 'block',
    policy,
    quotesOpen: false,
  });
  return { ...base, quotedCount: result.quotedCount, hasRemoteImages: result.hasRemoteImages };
}
