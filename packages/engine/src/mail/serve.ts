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
import { deadline, within } from './deadline';
import { partOf } from './message';
import { closeIterator, collectBytes } from './stream';

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
  // Defence in depth: the port's contract already forbids both an unbounded wait and an answer past the byte cap, but a
  // host proxy that hangs or overshoots must not hang `Mail/serve` or push 50 MB through the utility IPC and main.
  const limit = deadline(services.clock, IMAGE_PROXY_LIMITS.timeoutMs, signal);
  try {
    const image = await within(services.images.fetch(url, { token, signal }), limit);
    if (!image || image.kind !== 'image') return undefined;
    return image.bytes.byteLength <= IMAGE_PROXY_LIMITS.maxBytes
      ? { bytes: image.bytes }
      : undefined;
  } finally {
    limit.end();
  }
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
  // The proxy's whole-fetch timeout bounds the part too: a stalled provider stream cannot hold the request open.
  const limit = deadline(services.clock, IMAGE_PROXY_LIMITS.timeoutMs, signal);
  try {
    const opening = services.accounts.attachment(record.accountScope, ref);
    const chunks = await within(opening, limit);
    if (!chunks) {
      // The deadline won but the provider may still answer: close its stream the moment it does.
      void opening
        .then(c => {
          if (c) closeIterator(c[Symbol.asyncIterator]());
        })
        .catch(() => undefined);
      return undefined;
    }
    const bytes = await collectBytes(chunks, IMAGE_PROXY_LIMITS.maxBytes, limit);
    return bytes ? { bytes } : undefined;
  } finally {
    limit.end();
  }
}
