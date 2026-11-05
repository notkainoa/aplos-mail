import { frameHeaders, notFound, resourceHeaders, type ServeResponse } from './headers';
import { parseFramePath, type FrameRoute } from './paths';
import { sniffRaster } from './sniff';
import { isWindowId, type FrameRecord, type FrameTokens } from './tokens';

// `Mail/serve`'s response builder, pure: main forwards `{token, path}` and adds nothing. Every
// refusal is the same `notFound()`, and nothing here throws: a failure of any kind (a hostile
// value, a broken callback) is a 404.

export interface ServeRequest {
  /** The requesting frame's window, as main identifies it; never taken from the URL. */
  windowId: unknown;
  token: unknown;
  /** What follows `<token>/`: '' for the document, `cid/<n>` or `img/<n>`. */
  path: unknown;
}

export interface ServedBytes {
  /**
   * The bytes alone. Their type is sniffed here from the leading bytes (`sniffRaster`); a type the
   * caller, the proxy or the sender claims is never read, and anything that is not PNG, JPEG, GIF
   * or WebP is the 404.
   */
  bytes: Uint8Array;
}

type Bytes = ServedBytes | undefined | Promise<ServedBytes | undefined>;

export interface ServeDeps {
  now: () => number;
  /** `reporterHash()`, resolved once by the caller. */
  reporterHash: string;
  /** An allowed remote image (`img/<n>`), through the image proxy (slice 2). */
  imageBytes?: (token: string, index: number, url: string) => Bytes;
  /** An inline part (`cid/<n>`), from the message's stored attachment (slice 2). */
  cidBytes?: (record: FrameRecord, index: number, cid: string) => Bytes;
}

export async function serveFrame(
  registry: FrameTokens,
  request: ServeRequest,
  deps: ServeDeps,
): Promise<ServeResponse> {
  try {
    return await route(registry, request, deps);
  } catch {
    return notFound();
  }
}

async function route(
  registry: FrameTokens,
  request: ServeRequest,
  deps: ServeDeps,
): Promise<ServeResponse> {
  const target = parseFramePath(request.path);
  if (!target || !isWindowId(request.windowId)) return notFound();
  if (target.kind === 'document') return serveDocument(registry, request.windowId, request, deps);
  const record = registry.forResource(request.windowId, request.token, deps.now());
  if (!record) return notFound();
  const response = await serveResource(record, target, deps);
  return stillLive(registry, request.windowId, record, deps) ? response : notFound();
}

/** A release, replacement or expiry during the fetch wins: the bytes are dropped. */
function stillLive(
  registry: FrameTokens,
  windowId: string,
  record: FrameRecord,
  deps: ServeDeps,
): boolean {
  return registry.forResource(windowId, record.token, deps.now()) === record;
}

function serveDocument(
  registry: FrameTokens,
  windowId: string,
  request: ServeRequest,
  deps: ServeDeps,
): ServeResponse {
  const headers = frameHeaders(deps.reporterHash);
  const document = registry.takeDocument(windowId, request.token, deps.now());
  if (document === undefined) return notFound();
  return { status: 200, headers, body: new TextEncoder().encode(document) };
}

async function serveResource(
  record: FrameRecord,
  target: Exclude<FrameRoute, { kind: 'document' }>,
  deps: ServeDeps,
): Promise<ServeResponse> {
  const served =
    target.kind === 'img'
      ? imageFor(record, target.index, deps)
      : cidFor(record, target.index, deps);
  return toResponse(await served);
}

function imageFor(record: FrameRecord, index: number, deps: ServeDeps): Bytes {
  if (record.imagePolicy !== 'allow' || !deps.imageBytes) return undefined;
  const url = issued(record.remoteImages, index);
  return url === undefined ? undefined : deps.imageBytes(record.token, index, url);
}

function cidFor(record: FrameRecord, index: number, deps: ServeDeps): Bytes {
  const cid = issued(record.cids, index);
  return cid === undefined || !deps.cidBytes ? undefined : deps.cidBytes(record, index, cid);
}

/** Only an index this render numbered: own elements of the list, never inherited ones. */
function issued(list: readonly string[], index: number): string | undefined {
  return Number.isSafeInteger(index) && index >= 0 && index < list.length ? list[index] : undefined;
}

function toResponse(served: ServedBytes | undefined): ServeResponse {
  const mime = sniffRaster(served?.bytes);
  if (!served || !mime) return notFound();
  return { status: 200, headers: resourceHeaders(mime), body: served.bytes };
}
