import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import type { ImageProxy, ImageRefusal, ProxiedImage } from '@aplos/engine/ports';
import { readImageHeader, sniffMime, SNIFF_BYTES } from './image-type';
import {
  createSemaphore,
  proxyLimits,
  tokenBudget,
  type LimitOverrides,
  type ProxyLimits,
  type Release,
} from './limits';
import { pinTarget, systemResolver, type PinnedTarget, type Resolver } from './resolve';

/**
 * The image proxy (plan 10 E4 item 6, ARCH 10 "Remote images"): a host adapter implementing `ImageProxy`. Each hop is
 * pinned (one lookup, every answer checked) and connected to by address; redirects are followed by hand and each one
 * is pinned again from scratch. Nothing from the mail or the renderer reaches the request: the headers are fixed.
 */

/** Every header sent besides `Host`. No cookies, `Referer`, `Authorization` or anything from the caller. */
export const REQUEST_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'User-Agent': 'Mozilla/5.0',
  Accept: 'image/png,image/jpeg,image/gif,image/webp',
  'Accept-Encoding': 'identity',
  Connection: 'close',
});

/** Half Node's default: an image host's response headers are a few hundred bytes. */
const MAX_HEADER_BYTES = 8 * 1024;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export interface UpstreamResponse {
  status: number;
  location?: string;
  contentLength?: number;
  body: AsyncIterable<Uint8Array>;
  /** Drops the connection; called once the proxy is done with the response. */
  close(): void;
}

/** Opens one GET to a pinned target. Injected by tests; production uses `nodeConnector`. */
export type Connector = (target: PinnedTarget, signal: AbortSignal) => Promise<UpstreamResponse>;

export interface ImageProxyOptions {
  resolve?: Resolver;
  connect?: Connector;
  /** Tighter limits for tests; loosening throws. */
  limits?: LimitOverrides;
}

export interface HostImageProxy extends ImageProxy {
  /** Forgets a token's request count, e.g. when its render is released. */
  release(token: string): void;
}

type Step = ProxiedImage | { kind: 'redirect'; location: URL };

function refusal(reason: ImageRefusal): ProxiedImage {
  return { kind: 'refused', reason };
}

/** Answers any lookup Node attempts with the pinned address, so no second DNS query can happen. */
function pinnedLookup(target: PinnedTarget): LookupFunction {
  return ((_host: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    if (options?.all) callback(null, [{ address: target.address, family: target.family }]);
    else callback(null, target.address, target.family);
  }) as LookupFunction;
}

/** Request options for a pinned target: the socket goes to the checked address, `Host` and SNI carry the name. */
export function requestOptions(target: PinnedTarget, signal: AbortSignal): https.RequestOptions {
  return {
    method: 'GET',
    host: target.address,
    family: target.family,
    port: target.port,
    path: target.path,
    headers: { Host: target.hostHeader, ...REQUEST_HEADERS },
    setHost: false,
    // An empty servername turns SNI off for IP literals; certificates are then checked against the address.
    servername: target.servername ?? '',
    lookup: pinnedLookup(target),
    agent: false,
    maxHeaderSize: MAX_HEADER_BYTES,
    signal,
  };
}

function headerText(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function lengthOf(value: string | undefined): number | undefined {
  return value !== undefined && /^[0-9]+$/.test(value) ? Number(value) : undefined;
}

function upstream(response: http.IncomingMessage): UpstreamResponse {
  // Errors surface through iteration; this keeps one that arrives while nobody iterates from crashing the host.
  response.on('error', () => undefined);
  return {
    status: response.statusCode ?? 0,
    location: headerText(response.headers.location),
    contentLength: lengthOf(headerText(response.headers['content-length'])),
    body: response,
    close: () => response.destroy(),
  };
}

/** The production connector: Node's own HTTP and HTTPS clients, no agent pooling, no cookie jar. */
export const nodeConnector: Connector = (target, signal) =>
  new Promise((resolve, reject) => {
    const transport = target.secure ? https : http;
    const request = transport.request(requestOptions(target, signal), response =>
      resolve(upstream(response)),
    );
    request.on('error', reject);
    request.end();
  });

function joined(chunks: Uint8Array[], total: number): Uint8Array {
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

function toImage(bytes: Uint8Array, limits: ProxyLimits): ProxiedImage {
  const header = readImageHeader(bytes);
  if (!header) return refusal('type');
  if (header.width * header.height > limits.maxPixels) return refusal('size');
  return { kind: 'image', mime: header.mime, bytes };
}

/** Streams the body under the byte cap, refusing a non-image as soon as its leading bytes arrive. */
async function readImage(
  response: UpstreamResponse,
  limits: ProxyLimits,
  signal: AbortSignal,
  spend: (bytes: number) => boolean,
): Promise<ProxiedImage> {
  if ((response.contentLength ?? 0) > limits.maxBytes) return refusal('size');
  const chunks: Uint8Array[] = [];
  let total = 0;
  let sniffed = false;
  for await (const chunk of response.body) {
    signal.throwIfAborted();
    total += chunk.byteLength;
    if (total > limits.maxBytes) return refusal('size');
    if (!spend(chunk.byteLength)) return refusal('budget');
    chunks.push(chunk);
    if (!sniffed && total >= SNIFF_BYTES) {
      if (!sniffMime(joined(chunks, total))) return refusal('type');
      sniffed = true;
    }
  }
  return toImage(joined(chunks, total), limits);
}

function redirectStep(response: UpstreamResponse, base: URL): Step {
  if (!response.location) return refusal('http');
  try {
    return { kind: 'redirect', location: new URL(response.location, base) };
  } catch {
    return refusal('redirects');
  }
}

/** Rejects with the signal's reason once it aborts. */
function whenAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

/** A time allowance that runs only between `resume` and `pause`; it calls `expire` once the allowance is used up. */
interface Allowance {
  resume(): void;
  pause(): void;
  stop(): void;
}

function allowance(ms: number, expire: () => void): Allowance {
  let left = ms;
  let since = 0;
  let timer: NodeJS.Timeout | undefined;
  function pause() {
    if (!timer) return;
    clearTimeout(timer);
    timer = undefined;
    left -= Date.now() - since;
  }
  function resume() {
    if (timer) return;
    since = Date.now();
    timer = setTimeout(expire, Math.max(left, 0));
  }
  return { resume, pause, stop: pause };
}

/** The two clocks of one fetch: `work` runs while it does something, `wait` while it queues for a slot. */
interface Clocks {
  signal: AbortSignal;
  work: Allowance;
  wait: Allowance;
  /** True once either allowance ran out (the caller's own abort is not a timeout). */
  expired(): boolean;
}

function clocks(caller: AbortSignal, limits: ProxyLimits): Clocks {
  const deadline = new AbortController();
  const work = allowance(limits.timeoutMs, () => deadline.abort());
  const wait = allowance(limits.waitMs, () => deadline.abort());
  return {
    signal: AbortSignal.any([caller, deadline.signal]),
    work,
    wait,
    expired: () => deadline.signal.aborted,
  };
}

export function createImageProxy(options: ImageProxyOptions = {}): HostImageProxy {
  const limits = proxyLimits(options.limits);
  const resolve = options.resolve ?? systemResolver;
  const connect = options.connect ?? nodeConnector;
  const budget = tokenBudget(limits);
  const slots = createSemaphore(limits.maxInFlight);

  /** Waits for a slot on the wait clock, so the work clock (the fetch's own time limit) starts at the grant. */
  async function granted(token: string, clock: Clocks): Promise<Release> {
    clock.work.pause();
    clock.wait.resume();
    try {
      return await slots.acquire(clock.signal, token);
    } finally {
      clock.wait.pause();
      clock.work.resume();
    }
  }

  /** One hop in a slot: a hostile mail's hundred URLs queue here instead of buffering a hundred bodies at once. */
  async function request(target: PinnedTarget, token: string, clock: Clocks): Promise<Step> {
    const { signal } = clock;
    const release = await granted(token, clock);
    try {
      const response = await connect(target, signal);
      try {
        if (REDIRECTS.has(response.status)) return redirectStep(response, target.url);
        if (response.status < 200 || response.status > 299) return refusal('http');
        return await readImage(response, limits, signal, bytes => budget.spendBytes(token, bytes));
      } finally {
        response.close();
      }
    } finally {
      release();
    }
  }

  async function follow(start: string, token: string, clock: Clocks): Promise<ProxiedImage> {
    const { signal } = clock;
    let url: string | URL = start;
    for (let hop = 0; ; hop += 1) {
      signal.throwIfAborted();
      if (hop > limits.maxRedirects) return refusal('redirects');
      if (!budget.take(token)) return refusal('budget');
      const pin = await pinTarget(url, limits.ports, resolve, signal);
      if (!pin.ok) return refusal(hop === 0 ? pin.reason : 'redirects');
      signal.throwIfAborted();
      const step = await request(pin.target, token, clock);
      if (step.kind !== 'redirect') return step;
      // A secure page's image must not fall back to plain http, where anyone on the path can swap it.
      if (pin.target.secure && step.location.protocol !== 'https:') return refusal('redirects');
      url = step.location;
    }
  }

  async function fetchImage(
    url: string,
    { token, signal }: { token: string; signal: AbortSignal },
  ): Promise<ProxiedImage> {
    signal.throwIfAborted();
    const clock = clocks(signal, limits);
    clock.work.resume();
    try {
      return await Promise.race([follow(url, token, clock), whenAborted(clock.signal)]);
    } catch {
      if (signal.aborted) throw signal.reason;
      return refusal(clock.expired() ? 'timeout' : 'http');
    } finally {
      clock.work.stop();
      clock.wait.stop();
    }
  }

  return { fetch: fetchImage, release: token => budget.release(token) };
}
