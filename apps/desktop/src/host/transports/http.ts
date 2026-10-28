import { createServer, STATUS_CODES, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { toReply, type ErrorBody, type Frame } from '@aplos/contract';
import { checkAccess, requireScope, type Caller } from '@aplos/contract/access';
import { ContractError } from '@aplos/contract/contract-error';
import {
  AUTH_REFUSED,
  authenticate,
  createSessionTracker,
  guardCall,
  type ClientRegistry,
  type DoorwayBackend,
  type DoorwayListener,
  type DoorwayLog,
  type SessionTracker,
} from './auth';

/*
 * The loopback HTTP half of the doorway (plan 10 E7 item 2, ARCH 9.4 and 12.3, contract README "Scopes and
 * transports"). It is bound to 127.0.0.1 only. Every request passes, in order: an exact Host allowlist (DNS rebinding),
 * an exact Origin allowlist (cross-site browser requests), a strict route parse (path traversal), the route's method,
 * then a Bearer token for a stored, unrevoked client. Only then is any body read or anything executed.
 */

export interface HttpLimits {
  /** JSON arguments of one call (413 past it). */
  maxCallBytes: number;
  /** One `PUT /v1/blob` (the contract's 25 MB). */
  maxBlobBytes: number;
  maxHeaderBytes: number;
  /** Time to receive the whole header block (slowloris headers); Node answers 408 and closes. */
  headersTimeoutMs: number;
  /** Time to receive the whole request; must be at least `headersTimeoutMs`. */
  requestTimeoutMs: number;
  /** Time to receive a body once its headers are in (slowloris bodies). */
  bodyTimeoutMs: number;
  keepAliveTimeoutMs: number;
  /** How often Node checks the two timeouts above. */
  checkIntervalMs: number;
  maxConnections: number;
  /** An SSE comment this often keeps idle streams and proxies alive. */
  heartbeatMs: number;
  /** Frames queued to an SSE client that does not read; past it the stream is dropped. */
  maxStreamBufferBytes: number;
  maxPathBytes: number;
}

export const defaultHttpLimits: HttpLimits = {
  maxCallBytes: 1024 * 1024,
  maxBlobBytes: 25 * 1024 * 1024,
  maxHeaderBytes: 16 * 1024,
  headersTimeoutMs: 10_000,
  requestTimeoutMs: 10_000,
  bodyTimeoutMs: 10_000,
  keepAliveTimeoutMs: 5_000,
  checkIntervalMs: 1_000,
  maxConnections: 64,
  heartbeatMs: 15_000,
  maxStreamBufferBytes: 8 * 1024 * 1024,
  maxPathBytes: 2_048,
};

export interface HttpListenerOptions {
  /** The port to bind on 127.0.0.1; 0 picks a free one (tests). */
  port: number;
  registry: ClientRegistry;
  backend: DoorwayBackend;
  /**
   * Exact browser origins allowed to call, e.g. the preview's Vite origin. Default none: any request carrying an
   * `Origin` is refused, so a web page can never reach the listener, even with a token it somehow learned.
   */
  allowedOrigins?: readonly string[];
  limits?: Partial<HttpLimits>;
  log?: DoorwayLog;
}

export interface HttpListener extends DoorwayListener {
  port: number;
}

/** Never `0.0.0.0` or `::` (ARCH 12.3 item 1): only this Mac can connect, and only over IPv4 loopback. */
const LOOPBACK = '127.0.0.1';

const BASE_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'Cross-Origin-Resource-Policy': 'same-origin',
} as const;
const JSON_TYPE = 'application/json; charset=utf-8';

interface Context {
  registry: ClientRegistry;
  backend: DoorwayBackend;
  tracker: SessionTracker;
  limits: HttpLimits;
  allowedOrigins: ReadonlySet<string>;
  allowedHosts: ReadonlySet<string>;
  log?: DoorwayLog;
}

/** Binds 127.0.0.1:`port` and serves the doorway's routes until `close`. */
export async function startHttpListener(options: HttpListenerOptions): Promise<HttpListener> {
  const limits = { ...defaultHttpLimits, ...options.limits };
  const tracker = createSessionTracker(options.registry);
  const ctx: Context = {
    registry: options.registry,
    backend: options.backend,
    tracker,
    limits,
    allowedOrigins: originSet(options.allowedOrigins ?? []),
    allowedHosts: new Set(),
    log: options.log,
  };
  const server = createServer(
    {
      maxHeaderSize: limits.maxHeaderBytes,
      headersTimeout: limits.headersTimeoutMs,
      requestTimeout: limits.requestTimeoutMs,
      keepAliveTimeout: limits.keepAliveTimeoutMs,
      connectionsCheckingInterval: limits.checkIntervalMs,
      // A missing Host is ours to answer (421, like every other wrong Host), not Node's 400.
      requireHostHeader: false,
    },
    (req, res) => void handle(req, res, ctx),
  );
  // Without this listener Node would answer `100 Continue` before the request was checked at all.
  server.on('checkContinue', (req, res) => void handle(req, res, ctx));
  server.on('clientError', clientError);
  server.maxConnections = limits.maxConnections;
  const port = await listen(server, options.port).catch(error => {
    tracker.dispose();
    throw error;
  });
  ctx.allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  options.log?.('doorway.http.listening', { transport: 'http' });
  return {
    port,
    describe: () => ({ port }),
    close: () => {
      tracker.dispose();
      server.closeAllConnections();
      return new Promise(resolve => server.close(() => resolve()));
    },
  };
}

function listen(server: ReturnType<typeof createServer>, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: LOOPBACK, port, exclusive: true }, () => {
      server.off('error', reject);
      const address = server.address() as AddressInfo;
      if (address.address !== LOOPBACK) {
        server.close();
        return reject(new Error('The tools listener must bind to 127.0.0.1 only.'));
      }
      resolve(address.port);
    });
  });
}

/** Configured origins must be exact `scheme://host[:port]` origins; `null` and wildcards are never allowed. */
function originSet(origins: readonly string[]): ReadonlySet<string> {
  for (const origin of origins) {
    const parsed = URL.canParse(origin) ? new URL(origin) : undefined;
    const web = parsed?.protocol === 'http:' || parsed?.protocol === 'https:';
    if (!parsed || !web || parsed.origin !== origin)
      throw new Error('An allowed origin must be an exact http(s) origin.');
  }
  return new Set(origins);
}

/** Malformed requests Node's parser rejects get a bare status and no echo of what was sent. */
function clientError(error: NodeJS.ErrnoException, socket: Duplex): void {
  if (!socket.writable || error.code === 'ECONNRESET') return void socket.destroy();
  const status = clientErrorStatus(error.code);
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nConnection: close\r\nContent-Length: 0\r\nCache-Control: no-store\r\n\r\n`,
  );
  setTimeout(() => socket.destroy(), 1_000).unref();
}

function clientErrorStatus(code: string | undefined): number {
  if (code === 'HPE_HEADER_OVERFLOW') return 431;
  if (code === 'ERR_HTTP_REQUEST_TIMEOUT') return 408;
  return 400;
}

type Route =
  | { kind: 'call'; method: string }
  | { kind: 'events' }
  | { kind: 'blobPut' }
  | { kind: 'blobGet'; id: string }
  | { kind: 'openapi' };

const ROUTE_METHOD: Record<Route['kind'], string> = {
  call: 'POST',
  events: 'GET',
  blobPut: 'PUT',
  blobGet: 'GET',
  openapi: 'GET',
};

/*
 * No route ever needs percent-encoding, a dot segment, a backslash, a query or a NUL, so the raw path may hold only
 * letters, digits, `.`, `_`, `-` and `/`. There is nothing to decode, so `%2f`, `%2e%2e`, `%252e` and overlong UTF-8
 * cannot smuggle a separator or a traversal past the parse.
 */
const SAFE_PATH = /^\/[A-Za-z0-9._/-]*$/;
const TYPE_NAME = /^[A-Z][A-Za-z0-9]{0,49}$/;
const VERB_NAME = /^[a-z][A-Za-z0-9]{0,49}$/;
/** Blob ids are opaque random handles (FR-6, at least 128 bits): base64url or hex, never a path. */
const BLOB_ID = /^[A-Za-z0-9_-]{1,256}$/;

/** The route a raw request target names, or undefined (404, no detail). */
export function parseRoute(target: string | undefined, maxPathBytes: number): Route | undefined {
  if (!target || target.length > maxPathBytes || !SAFE_PATH.test(target)) return undefined;
  const parts = target.slice(1).split('/');
  if (parts.some(part => part === '' || part === '.' || part === '..')) return undefined;
  if (parts[0] !== 'v1') return undefined;
  const [, first, second, third] = parts;
  if (parts.length === 4 && first === 'call' && TYPE_NAME.test(second) && VERB_NAME.test(third))
    return { kind: 'call', method: `${second}/${third}` };
  if (parts.length === 2 && first === 'events') return { kind: 'events' };
  if (parts.length === 2 && first === 'blob') return { kind: 'blobPut' };
  if (parts.length === 3 && first === 'blob' && BLOB_ID.test(second))
    return { kind: 'blobGet', id: second };
  if (parts.length === 2 && first === 'openapi.json') return { kind: 'openapi' };
  return undefined;
}

/** Every value of a header as sent, duplicates included (Node keeps only the first `Host` in `req.headers`). */
function headerValues(req: IncomingMessage, name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i + 1 < req.rawHeaders.length; i += 2)
    if (req.rawHeaders[i].toLowerCase() === name) values.push(req.rawHeaders[i + 1]);
  return values;
}

/**
 * The checks that need no token, in order. Host first: a DNS-rebinding page reaches 127.0.0.1 under its own name, so
 * exactly one Host naming this port on 127.0.0.1 or localhost is accepted (a comma-joined or repeated Host could make a
 * proxy and Node disagree). Then Origin: a browser always sends it on cross-site calls, so one that is present must be
 * an allowed origin. Then the method: OPTIONS never succeeds and never carries CORS headers, so no preflight passes.
 */
function precheck(req: IncomingMessage, ctx: Context): number | undefined {
  const hosts = headerValues(req, 'host');
  if (hosts.length !== 1 || !ctx.allowedHosts.has(hosts[0])) return 421;
  const origins = headerValues(req, 'origin');
  if (origins.length > 1 || (origins.length === 1 && !ctx.allowedOrigins.has(origins[0])))
    return 403;
  if (req.method !== 'GET' && req.method !== 'POST' && req.method !== 'PUT') return 405;
  return undefined;
}

/** Only `Authorization: Bearer <token>`, exactly once; never a query string or a cookie. */
function bearerToken(req: IncomingMessage): string | undefined {
  const values = headerValues(req, 'authorization');
  if (values.length !== 1) return undefined;
  const match = /^Bearer ([^\s]{1,300})$/.exec(values[0]);
  return match?.[1];
}

async function authorise(req: IncomingMessage, ctx: Context): Promise<Caller | undefined> {
  try {
    // Missing and malformed tokens go through `authenticate` too, so they take the same path as a wrong one.
    return await authenticate(ctx.registry, bearerToken(req), 'http');
  } catch {
    return undefined;
  }
}

async function handle(req: IncomingMessage, res: ServerResponse, ctx: Context): Promise<void> {
  try {
    await route(req, res, ctx);
  } catch (error) {
    // Only reached by a bug in this file: answer like any internal error, never with its message.
    ctx.log?.('doorway.http.internal', { transport: 'http' });
    sendError(res, error);
  }
}

async function route(req: IncomingMessage, res: ServerResponse, ctx: Context): Promise<void> {
  const early = precheck(req, ctx);
  if (early) return respond(res, early);
  const target = parseRoute(req.url, ctx.limits.maxPathBytes);
  if (!target) return respond(res, 404);
  if (req.method !== ROUTE_METHOD[target.kind])
    return respond(res, 405, undefined, { Allow: ROUTE_METHOD[target.kind] });
  const caller = await authorise(req, ctx);
  const release = caller && ctx.tracker.admit(caller.clientId ?? '', () => req.socket.destroy());
  if (!caller || !release) return refuseAuth(res, ctx);
  res.once('close', release);
  await serve(target, req, res, caller, ctx);
}

function serve(
  target: Route,
  req: IncomingMessage,
  res: ServerResponse,
  caller: Caller,
  ctx: Context,
): Promise<void> | void {
  if (target.kind === 'call') return serveCall(target.method, req, res, caller, ctx);
  if (target.kind === 'events') return serveEvents(req, res, caller, ctx);
  if (target.kind === 'blobGet') return serveBlobGet(target.id, res, caller, ctx);
  if (target.kind === 'blobPut') return serveBlobPut(req, res, caller, ctx);
  return respond(res, 200, ctx.backend.openapi());
}

function refuseAuth(res: ServerResponse, ctx: Context): void {
  ctx.log?.('doorway.http.unauthorised', { transport: 'http', status: 401 });
  const body = { error: { type: 'forbidden', message: AUTH_REFUSED } };
  respond(res, 401, JSON.stringify(body), { 'WWW-Authenticate': 'Bearer' });
}

const BAD_JSON = 'The request body is not valid JSON.';
const NOT_OBJECT = 'The request body must be a JSON object of arguments.';
const BAD_TYPE = 'Send the arguments as application/json.';
const BAD_KEY =
  'The Idempotency-Key header must be one opId, matching the opId in the body if any.';

async function serveCall(
  method: string,
  req: IncomingMessage,
  res: ServerResponse,
  caller: Caller,
  ctx: Context,
): Promise<void> {
  try {
    // Refuse a method the caller may not call before reading a byte of its body.
    guardCall(method, caller);
    if (!isMediaType(req, 'application/json')) return sendError(res, validation(BAD_TYPE), 415);
    const body = await readBody(req, res, ctx.limits.maxCallBytes, ctx.limits.bodyTimeoutMs);
    if (!body.ok) return refuseBody(res, body.status);
    const args = parseArgsBody(body.bytes);
    const keyed = applyIdempotencyKey(req, args);
    guardCall(method, caller, keyed.args);
    const signal = abortOnClose(res);
    const result = await ctx.backend.call(caller, method, keyed.args, { opId: keyed.opId, signal });
    respond(res, 200, JSON.stringify(result ?? null));
  } catch (error) {
    sendError(res, error);
  }
}

function parseArgsBody(bytes: Buffer): Record<string, unknown> {
  if (bytes.length === 0) return {};
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    // Never echo the input: it may hold mail text or a secret.
    throw validation(BAD_JSON);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw validation(NOT_OBJECT);
  return value as Record<string, unknown>;
}

/** Printable ASCII, the contract's `OpId` length: a key that could not be an `opId` is refused, never truncated. */
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,200}$/;

/** `Idempotency-Key` is the command's `opId` (contract README): one header, and the body's `opId` must agree with it. */
function applyIdempotencyKey(
  req: IncomingMessage,
  args: Record<string, unknown>,
): { args: Record<string, unknown>; opId?: string } {
  const keys = headerValues(req, 'idempotency-key');
  const bodyOpId = Object.hasOwn(args, 'opId') ? args.opId : undefined;
  if (keys.length === 0) return { args, opId: typeof bodyOpId === 'string' ? bodyOpId : undefined };
  const [key] = keys;
  if (keys.length > 1 || !IDEMPOTENCY_KEY.test(key)) throw validation(BAD_KEY);
  if (bodyOpId !== undefined && bodyOpId !== key) throw validation(BAD_KEY);
  return { args: { ...args, opId: key }, opId: key };
}

function abortOnClose(res: ServerResponse): AbortSignal {
  const controller = new AbortController();
  res.once('close', () => {
    if (!res.writableFinished) controller.abort();
  });
  return controller.signal;
}

/** Exactly one `Content-Type` whose media type is `type` (parameters other than a UTF-8 charset are refused). */
function isMediaType(req: IncomingMessage, type: string): boolean {
  const values = headerValues(req, 'content-type');
  if (values.length !== 1) return false;
  const [media, ...params] = values[0].split(';').map(part => part.trim().toLowerCase());
  return media === type && params.every(param => param === 'charset=utf-8');
}

type BodyResult = { ok: true; bytes: Buffer } | { ok: false; status: 400 | 408 | 413 };

/**
 * Reads a body up to `cap` bytes within `timeoutMs`. A declared Content-Length over the cap is refused before reading;
 * a chunked body is counted as it streams and refused the moment it passes the cap, so neither form can fill memory.
 * The timer runs from the first byte awaited, so a client dribbling one byte at a time is cut off (slowloris).
 */
function readBody(
  req: IncomingMessage,
  res: ServerResponse,
  cap: number,
  timeoutMs: number,
): Promise<BodyResult> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > cap) return Promise.resolve({ ok: false, status: 413 });
  if (req.headers.expect?.toLowerCase() === '100-continue') res.writeContinue();
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const settle = (result: BodyResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => settle({ ok: false, status: 408 }), timeoutMs);
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > cap) return settle({ ok: false, status: 413 });
      if (!settled) chunks.push(chunk);
    });
    req.once('end', () => settle({ ok: true, bytes: Buffer.concat(chunks, size) }));
    req.once('error', () => settle({ ok: false, status: 400 }));
    req.once('close', () => settle({ ok: false, status: 400 }));
  });
}

const BODY_REFUSALS: Record<400 | 408 | 413, ErrorBody> = {
  400: { type: 'validation', message: 'The request body did not arrive.' },
  408: { type: 'validation', message: 'The request body took too long to arrive.' },
  413: { type: 'tooLarge', message: 'The request body is too large.' },
};

/** Answers a refused body and drops the connection, so the rest of an oversized or stalled body is never read. */
function refuseBody(res: ServerResponse, status: 400 | 408 | 413): void {
  respond(res, status, JSON.stringify({ error: BODY_REFUSALS[status] }));
  res.req.resume();
  setTimeout(() => res.req.socket.destroy(), 1_000).unref();
}

function serveEvents(
  req: IncomingMessage,
  res: ServerResponse,
  caller: Caller,
  ctx: Context,
): void {
  let since: { dbEpoch: string; seq: number } | undefined;
  try {
    // Frames carry mail data, so the stream needs `read` like the reads it summarises.
    requireScope(caller, 'read');
    since = lastEventState(req, ctx.backend);
  } catch (error) {
    return sendError(res, error);
  }
  openStream(res, caller, since, ctx);
}

const SEQ = /^\d{1,15}$/;

/** `Last-Event-ID: <seq>` resumes within the engine's current `dbEpoch`; anything else is refused, never guessed. */
function lastEventState(
  req: IncomingMessage,
  backend: DoorwayBackend,
): { dbEpoch: string; seq: number } | undefined {
  const values = headerValues(req, 'last-event-id');
  if (values.length === 0) return undefined;
  if (values.length > 1 || !SEQ.test(values[0]))
    throw validation('Last-Event-ID must be one sequence number.');
  return { dbEpoch: backend.session().dbEpoch, seq: Number(values[0]) };
}

function openStream(
  res: ServerResponse,
  caller: Caller,
  since: { dbEpoch: string; seq: number } | undefined,
  ctx: Context,
): void {
  res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8' });
  res.write(': open\n\n');
  let open = true;
  const write = (text: string) => {
    if (!open || res.destroyed) return;
    res.write(text);
    // A client that stops reading must not make the engine buffer its frames without bound.
    if (res.writableLength > ctx.limits.maxStreamBufferBytes) res.destroy();
  };
  const heartbeat = setInterval(() => write(': hb\n\n'), ctx.limits.heartbeatMs);
  let unsubscribe: (() => void) | undefined;
  res.once('close', () => {
    open = false;
    clearInterval(heartbeat);
    quietly(() => unsubscribe?.());
  });
  try {
    unsubscribe = ctx.backend.subscribe(
      caller,
      since,
      frame => write(sseEvent(frame)),
      reset => write(sseEvent(reset)),
    );
  } catch {
    res.destroy();
  }
  if (!open) quietly(() => unsubscribe?.());
}

const EVENT_NAME = /^[A-Za-z][A-Za-z/]{0,39}$/;

/** One SSE event: `id: <seq>` when the frame has one, the frame's kind as the event name, the frame as one data line. */
export function sseEvent(frame: Frame): string {
  const json = serialise(frame);
  if (json === undefined) return '';
  const seq = 'seq' in frame ? frame.seq : undefined;
  const id = typeof seq === 'number' && Number.isSafeInteger(seq) ? `id: ${seq}\n` : '';
  const name = EVENT_NAME.test(frame.frame) ? frame.frame : 'frame';
  // JSON.stringify escapes every newline, so the data can never end the event or inject a field.
  return `${id}event: ${name}\ndata: ${json}\n\n`;
}

const MIME = /^[a-z0-9!#$&^_.+-]{1,100}\/[a-z0-9!#$&^_.+-]{1,100}$/;

async function serveBlobGet(
  id: string,
  res: ServerResponse,
  caller: Caller,
  ctx: Context,
): Promise<void> {
  try {
    checkAccess('Blob/get', caller, { blobId: id });
    const blob = await ctx.backend.blob.get(caller, id);
    const bytes = Buffer.from(blob.bytes.buffer, blob.bytes.byteOffset, blob.bytes.byteLength);
    const headers: Record<string, string | number> = {
      ...BASE_HEADERS,
      // Never the stored mime as Content-Type: a blob is data to download, not a page to render.
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment',
      'Content-Length': bytes.length,
    };
    const mime = blob.mime.toLowerCase();
    if (MIME.test(mime)) headers['X-Aplos-Blob-Mime'] = mime;
    res.writeHead(200, headers);
    res.end(bytes);
  } catch (error) {
    sendError(res, error);
  }
}

async function serveBlobPut(
  req: IncomingMessage,
  res: ServerResponse,
  caller: Caller,
  ctx: Context,
): Promise<void> {
  try {
    checkAccess('Blob/put', caller);
    const mime = blobMime(req);
    if (!mime) return sendError(res, validation('Send the file with its media type.'), 415);
    const body = await readBody(req, res, ctx.limits.maxBlobBytes, ctx.limits.bodyTimeoutMs);
    if (!body.ok) return refuseBody(res, body.status);
    const bytes = new Uint8Array(body.bytes.buffer, body.bytes.byteOffset, body.bytes.length);
    const stored = await ctx.backend.blob.put(caller, bytes, { mime });
    respond(res, 200, JSON.stringify({ blobId: stored.blobId, size: stored.size }));
  } catch (error) {
    sendError(res, error);
  }
}

function blobMime(req: IncomingMessage): string | undefined {
  const values = headerValues(req, 'content-type');
  if (values.length !== 1) return undefined;
  const media = values[0].split(';')[0].trim().toLowerCase();
  return MIME.test(media) ? media : undefined;
}

/**
 * HTTP statuses for the contract's error types. The README fixes only "a failure answers a non-2xx status with
 * {error}"; these follow the usual meanings, and an unknown type is a 500 so a client never mistakes it for its own
 * mistake.
 */
const ERROR_STATUS: Record<string, number> = {
  validation: 400,
  rangeTooLarge: 400,
  cancelled: 400,
  forbidden: 403,
  notFound: 404,
  unsupported: 404,
  stateMismatch: 409,
  conflict: 409,
  cannotCalculateChanges: 409,
  paused: 409,
  needsReauth: 409,
  permission: 409,
  notConfigured: 409,
  tooLarge: 413,
  internal: 500,
  notImplemented: 501,
  providerError: 502,
  unavailable: 503,
};

export function statusForError(type: string): number {
  return Object.hasOwn(ERROR_STATUS, type) ? ERROR_STATUS[type] : 500;
}

/**
 * Answers a failure as `{error}`. A `ContractError` keeps its body (the engine's own sentence); anything else is the
 * generic internal error, so a backend's stack, message or provider text never reaches the client.
 */
function sendError(res: ServerResponse, error: unknown, status?: number): void {
  const reply = toReply(0, { error });
  const body = reply.ok
    ? { type: 'internal', message: 'Something went wrong. Try again.' }
    : reply.error;
  const json =
    serialise({ error: body }) ??
    '{"error":{"type":"internal","message":"Something went wrong. Try again."}}';
  respond(res, status ?? statusForError(body.type), json);
}

const validation = (message: string) => new ContractError({ type: 'validation', message });

/**
 * Writes a whole response with the doorway's fixed headers. Every failure also closes the connection, so a request
 * whose body was never read cannot be mistaken for the next request on a kept-alive connection.
 */
function respond(
  res: ServerResponse,
  status: number,
  json?: string,
  extra: Record<string, string> = {},
): void {
  if (res.headersSent || res.destroyed) return;
  const body = json === undefined ? {} : { 'Content-Type': JSON_TYPE };
  const close = status >= 400 ? { Connection: 'close' } : {};
  res.writeHead(status, {
    ...BASE_HEADERS,
    ...body,
    'Content-Length': json === undefined ? 0 : Buffer.byteLength(json),
    ...extra,
    ...close,
  });
  res.end(json);
}

function serialise(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function quietly(fn: () => void): void {
  try {
    fn();
  } catch {
    // Teardown of one part never stops the rest.
  }
}
