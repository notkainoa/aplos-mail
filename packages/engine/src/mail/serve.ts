import type { Input, Output } from '@aplos/contract';
import {
  notFound,
  reporterHash,
  serveFrame,
  type FrameRecord,
  type ServedBytes,
  type ServeDeps,
  type ServeResponse,
} from '@aplos/mail-html/frame';
import { IMAGE_PROXY_LIMITS } from '../ports';
import type { MethodContext } from '../methods/types';
import type { EngineServices } from '../runtime/services';
import { readBody } from '../store/bodies';
import { partOf } from './message';

// `Mail/serve` (scope `host`, main's control connection only): the whole response for one `aplos-mail://` request.
// It knows nothing about windows or sessions beyond the `windowId` main passes, and fails closed: no window, an empty
// one, any refusal or any failure is the one uniform 404. It never throws.

type Served = Output<'Mail/serve'>;

export async function serveMail(args: Input<'Mail/serve'>, ctx: MethodContext): Promise<Served> {
  try {
    return toOutput(await serveFor(args, ctx));
  } catch {
    return toOutput(notFound());
  }
}

/** The contract's `Bytes` is a plain `ArrayBuffer` view; a view on shared memory is copied out. */
function toOutput(response: ServeResponse): Served {
  const { body } = response;
  const plain = body.buffer instanceof ArrayBuffer ? (body as Uint8Array<ArrayBuffer>) : null;
  return { ...response, body: plain ?? new Uint8Array(body) };
}

async function serveFor(args: Input<'Mail/serve'>, ctx: MethodContext): Promise<ServeResponse> {
  const windowId: unknown = args.windowId;
  if (typeof windowId !== 'string' || windowId.length === 0) return notFound();
  const { services } = ctx;
  const deps: ServeDeps = {
    now: () => services.clock.now(),
    reporterHash: await reporterHash(),
    imageBytes: (token, _index, url) => proxiedImage(services, token, url, ctx.signal),
    cidBytes: (record, _index, cid) => inlinePart(services, record, cid, ctx.signal),
  };
  const request = { windowId, token: args.token, path: args.path };
  return serveFrame(services.mailFrames.tokens, request, deps);
}

/** An allowed remote image through the host's proxy; a refusal is the 404 (the reason stays in the proxy's log). */
async function proxiedImage(
  services: EngineServices,
  token: string,
  url: string,
  signal: AbortSignal,
): Promise<ServedBytes | undefined> {
  const image = await services.images.fetch(url, { token, signal });
  return image.kind === 'image' ? { bytes: image.bytes } : undefined;
}

/** The token's own message's inline part named by Content-ID, through the provider; at most the proxy's byte cap. */
async function inlinePart(
  services: EngineServices,
  record: FrameRecord,
  cid: string,
  signal: AbortSignal,
): Promise<ServedBytes | undefined> {
  const prefix = `${record.accountScope}:`;
  if (!record.messageId.startsWith(prefix)) return undefined;
  const remoteId = record.messageId.slice(prefix.length);
  const body = services.store.read(q => readBody(q, record.accountScope, remoteId));
  const part = partOf(body, cid);
  if (part === undefined) return undefined;
  const ref = { remoteMessageId: remoteId, part };
  const chunks = await services.accounts.attachment(record.accountScope, ref);
  const bytes = await collectBytes(chunks, IMAGE_PROXY_LIMITS.maxBytes, signal);
  return bytes ? { bytes } : undefined;
}

/** The whole stream, or undefined once it passes `max` bytes or the call is cancelled. */
export async function collectBytes(
  chunks: AsyncIterable<Uint8Array>,
  max: number,
  signal: AbortSignal,
): Promise<Uint8Array | undefined> {
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of chunks) {
    if (signal.aborted || !(chunk instanceof Uint8Array)) return undefined;
    size += chunk.byteLength;
    if (size > max) return undefined;
    parts.push(chunk);
  }
  return joinBytes(parts, size);
}

function joinBytes(parts: readonly Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}
