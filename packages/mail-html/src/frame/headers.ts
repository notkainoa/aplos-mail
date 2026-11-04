// Every header of every `aplos-mail://` response (ARCH 10). Main adds nothing, so this is the
// whole set. Names are lowercase: `Mail/serve` returns a plain `Record<string, string>`, HTTP
// names are case-insensitive, and one spelling means a lookup or a test can never miss a header
// written in another case or hold the same header twice.
//
// Not sent, on purpose: `cross-origin-resource-policy`. The frame is sandboxed without
// `allow-same-origin`, so its origin is opaque ('null') and every `cid/<n>` or `img/<n>` it loads
// is a cross-origin request; `same-origin` would block the message's own images, and
// `cross-origin` would add nothing.

export type FrameHeaders = Record<string, string>;

export interface ServeResponse {
  status: number;
  headers: FrameHeaders;
  body: Uint8Array;
}

/** The base64 SHA-256 of 32 bytes: 43 characters and one `=`. */
const HASH_PATTERN = /^[A-Za-z0-9+/]{43}=$/;

export const RASTER_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

export type RasterType = (typeof RASTER_TYPES)[number];

/** For bytes that are not a frame document: nothing in them may run, load or style anything. */
const RESOURCE_CSP = "default-src 'none'; sandbox";

/** ARCH 10's policy, word for word, with the reporter's hash. */
export function frameCsp(reporterHash: string): string {
  if (!HASH_PATTERN.test(reporterHash)) throw new Error('frame headers: not a base64 SHA-256');
  return [
    "default-src 'none'",
    `script-src 'sha256-${reporterHash}'`,
    "style-src 'unsafe-inline'",
    'img-src aplos-mail: data:',
    'font-src aplos-mail: data:',
    "media-src 'none'",
    "connect-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    'sandbox allow-scripts allow-popups',
  ].join('; ');
}

/** What every response carries, a refusal included. */
function baseHeaders(): FrameHeaders {
  return {
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  };
}

/** The frame document's headers. */
export function frameHeaders(reporterHash: string): FrameHeaders {
  return {
    'content-security-policy': frameCsp(reporterHash),
    'content-type': 'text/html; charset=utf-8',
    ...baseHeaders(),
    'x-dns-prefetch-control': 'off',
  };
}

export function isRasterType(mime: unknown): mime is RasterType {
  return typeof mime === 'string' && (RASTER_TYPES as readonly string[]).includes(mime);
}

/**
 * A `cid/<n>` or `img/<n>` response, for bytes `sniffRaster` recognised: one of the four raster
 * types, shown inline. Anything else never gets here: `Mail/serve` answers it with `notFound()`,
 * so SVG, HTML or an executable labelled `image/png` is neither rendered nor offered as a download.
 */
export function resourceHeaders(mime: RasterType): FrameHeaders {
  if (!isRasterType(mime)) throw new Error('frame headers: not a raster type');
  return {
    'content-security-policy': RESOURCE_CSP,
    'content-type': mime,
    'content-disposition': 'inline',
    ...baseHeaders(),
  };
}

/** The one refusal: unknown, expired, released, reused, other-window and blocked all look like this. */
export function notFound(): ServeResponse {
  return {
    status: 404,
    headers: { 'content-security-policy': RESOURCE_CSP, ...baseHeaders() },
    body: new Uint8Array(0),
  };
}
