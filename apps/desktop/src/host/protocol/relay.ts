/**
 * The `aplos-mail://` relay's decisions (lane eng-html, html-5; ARCH 10). Pure: no Electron, no Node module, so every
 * guard runs under node:test. `main/mail-protocol.ts` wires these to Electron on the real engine path only.
 *
 * Main adds nothing to a mail response: the engine's `Mail/serve` builds every header. Main's part is to answer only
 * GET, to split the URL without decoding it, to name the window that asked (from a header main itself stamps, never
 * one the page sent), and to turn anything unexpected into the one uniform 404.
 */
import { notFound, parseFrameUrl, type ServeResponse } from '@aplos/mail-html/frame';

/** The scheme, registered as `{standard: true, secure: true}` and nothing else (ARCH 10). */
export const MAIL_SCHEME = 'aplos-mail';

/** Privileges for `protocol.registerSchemesAsPrivileged`. No fetch, CORS, service-worker, CSP-bypass or stream rights. */
export const MAIL_PRIVILEGES: Readonly<{ standard: true; secure: true }> = Object.freeze({
  standard: true,
  secure: true,
});

/** The header main stamps in `onBeforeSendHeaders`: the requesting window's `webContentsId`. */
export const WINDOW_HEADER = 'X-Aplos-Window';
const WINDOW_HEADER_LOWER = WINDOW_HEADER.toLowerCase();

/** The only URL prefix served: scheme, `//`, host exactly `m`, then the path. No port, no userinfo. */
const PREFIX = `${MAIL_SCHEME}://m/`;

/** `Mail/serve`'s own bounds (contract: `token: line(64)`, `path: line(2_000)`); longer never reaches the engine. */
const MAX_TOKEN = 64;
const MAX_PATH = 2_000;

/** How long main waits for `Mail/serve` (the engine bounds a `cid` or `img` fetch at 10 s itself). */
export const SERVE_TIMEOUT_MS = 15_000;

/** Every header name the engine's `Mail/serve` writes (`@aplos/mail-html/frame` headers.ts). Nothing else passes. */
export const ENGINE_HEADERS: ReadonlySet<string> = new Set([
  'content-security-policy',
  'content-type',
  'content-disposition',
  'x-content-type-options',
  'x-dns-prefetch-control',
  'cache-control',
  'referrer-policy',
]);

/** The statuses `Mail/serve` answers: the document or a sub-resource, or the uniform refusal. */
const ENGINE_STATUSES: ReadonlySet<number> = new Set([200, 404]);

export interface ServeArgs {
  token: string;
  path: string;
  /** The requesting Electron window's id, as decimal text; the utility process swaps it for a connection id. */
  windowId: string;
}

export interface RelayDeps {
  /** Asks the engine (`Mail/serve` over main's control connection). Any rejection is the 404. */
  serve(args: ServeArgs): Promise<unknown>;
  /** The Electron window id of a `webContentsId`, or undefined when it is not a live app window. */
  windowOf(contentsId: number): number | undefined;
}

/** True for any `aplos-mail:` URL, in any case (Chromium lowercases a scheme, but the check does not rely on it). */
export function isMailUrl(url: unknown): boolean {
  const scheme = `${MAIL_SCHEME}:`;
  return typeof url === 'string' && url.slice(0, scheme.length).toLowerCase() === scheme;
}

/**
 * Token and path of a request URL, taken from the raw text: never `new URL()`, never decoded. `aplos-mail://m/` must
 * start the text exactly, the token runs to the next `/`, and the path is everything after it (a query included), so
 * a percent-escape, a dot segment or a `?` reaches the engine as written and its strict grammar refuses it.
 * Chromium canonicalizes a standard scheme's URL before main sees it (it resolves dot segments and lowercases the
 * host); what is left is still only a URL the engine judges, so nothing here hides or adds a segment.
 */
export function splitMailUrl(raw: unknown): { token: string; path: string } | undefined {
  if (typeof raw !== 'string' || !raw.startsWith(PREFIX)) return undefined;
  const rest = raw.slice(PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash < 0) return undefined;
  const token = rest.slice(0, slash);
  const path = rest.slice(slash + 1);
  if (token.length === 0 || token.length > MAX_TOKEN || path.length > MAX_PATH) return undefined;
  return { token, path };
}

/** The stamped `webContentsId`, when the header holds exactly one positive integer. */
function stampedContents(headers: { get(name: string): string | null }): number | undefined {
  const value = headers.get(WINDOW_HEADER);
  if (value === null || !/^[1-9][0-9]{0,15}$/.test(value)) return undefined;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : undefined;
}

/**
 * The request headers to send, for `onBeforeSendHeaders`: every spelling of `X-Aplos-Window` the page sent is removed
 * (from any URL), and an `aplos-mail:` request gets main's own stamp, `String(webContentsId)`. With no
 * `webContentsId` it gets none, and the handler answers 404.
 */
export function stampWindow(details: {
  url: string;
  webContentsId?: number;
  requestHeaders: Record<string, string>;
}): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(details.requestHeaders)) {
    if (name.toLowerCase() !== WINDOW_HEADER_LOWER) headers[name] = value;
  }
  const id = details.webContentsId;
  const known = typeof id === 'number' && Number.isSafeInteger(id) && id > 0;
  if (known && isMailUrl(details.url)) headers[WINDOW_HEADER] = String(id);
  return headers;
}

const NETWORK = /^(?:https?|wss?):/i;

/**
 * The session backstop (ARCH 10, `onBeforeRequest`): cancel an http, https, ws or wss request made by an opaque origin
 * (`initiatorOrigin` `'null'`: a sandboxed mail frame) or by a frame showing an `aplos-mail:` document. The sanitizer
 * and the frame's CSP already stop these; this is the layer below them.
 */
export function backstopCancels(details: {
  url: string;
  initiatorOrigin?: string;
  frameUrl?: string;
}): boolean {
  if (!NETWORK.test(details.url)) return false;
  return details.initiatorOrigin === 'null' || isMailUrl(details.frameUrl);
}

/** A frame document URL exactly as `Mail/frame` issues it: `aplos-mail://m/<32 lowercase hex>/`, nothing else. */
export function isMailDocumentUrl(url: unknown): boolean {
  return parseFrameUrl(url)?.route.kind === 'document';
}

function plainHeaders(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!ENGINE_HEADERS.has(name) || typeof value !== 'string') return undefined;
    headers[name] = value;
  }
  return headers;
}

/**
 * The engine's answer when it has exactly `Mail/serve`'s shape: status 200 or 404, bytes, and only the engine's own
 * header names (a CSP always among them). Anything else (another status, a `set-cookie`, a missing CSP) is undefined.
 */
export function servedResponse(answer: unknown): ServeResponse | undefined {
  if (!answer || typeof answer !== 'object') return undefined;
  const { status, headers, body } = answer as Record<string, unknown>;
  if (typeof status !== 'number' || !ENGINE_STATUSES.has(status)) return undefined;
  if (!(body instanceof Uint8Array)) return undefined;
  const checked = plainHeaders(headers);
  if (!checked || checked['content-security-policy'] === undefined) return undefined;
  return { status, headers: checked, body };
}

/** A `Response` carrying exactly the given status, headers and bytes. */
export function toResponse(served: ServeResponse): Response {
  const body = served.body.byteLength === 0 ? null : served.body;
  return new Response(body as BodyInit | null, { status: served.status, headers: served.headers });
}

/** Any method but GET: 405 with `Allow: GET` and the refusal's own headers, an empty body, and no engine call. */
export function methodNotAllowed(): Response {
  const refusal = notFound();
  return new Response(null, { status: 405, headers: { ...refusal.headers, allow: 'GET' } });
}

/** The uniform 404 (slice 1's `notFound()`), for every refusal main makes itself. */
export function refused(): Response {
  return toResponse(notFound());
}

async function answer(request: Request, deps: RelayDeps): Promise<Response> {
  const target = splitMailUrl(request.url);
  const contents = stampedContents(request.headers);
  const window = contents === undefined ? undefined : deps.windowOf(contents);
  if (!target || window === undefined) return refused();
  const served = servedResponse(await deps.serve({ ...target, windowId: String(window) }));
  return served ? toResponse(served) : refused();
}

/** The `protocol.handle('aplos-mail', …)` handler. It never throws: a failure of any kind is the uniform 404. */
export function createMailHandler(deps: RelayDeps): (request: Request) => Promise<Response> {
  return async request => {
    if (request.method !== 'GET') return methodNotAllowed();
    try {
      return await answer(request, deps);
    } catch {
      return refused();
    }
  };
}
