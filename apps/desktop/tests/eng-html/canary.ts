import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { canaryTag, DEFAULT_DNS_SUFFIX } from '../../../../packages/mail-html/corpus/index';

// The canaries for the leak harness (plans/engine/phase1-lanes.md section 8, html-2). Two independent ways to learn
// that a message made the browser reach for the network, both working offline:
//
//  1. An HTTP canary on a random loopback port. Every vector in the corpus points at it (`{{CANARY}}/<id>/<vector>`),
//     so each request names the message and the vector. It also answers anything that reaches it through the DNS
//     mapping below, where the message is named by the Host header.
//  2. A DNS canary. Each message owns the host `<tag>.canary-dns.example` (`{{CANARY_HOST}}`). Chromium is started
//     with `--host-resolver-rules` that map that host to `<tag>.localhost:<canary port>` and every other name to
//     "not found" (so no run ever asks a real resolver), and with `--log-net-log`. A lookup, prefetch, preconnect or
//     request for a canary host then shows up in the net log under the rewritten name, which still carries the tag.

export interface CanaryHit {
  /** `http` for a request; `upgrade` for a WebSocket handshake. */
  kind: 'http' | 'upgrade';
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  /** The corpus id the request belongs to: the first path segment, or the `<tag>` of the Host header. */
  messageId: string | undefined;
  /** False for traffic that is not Chromium (Node's own instrumentation can call a listening port). */
  fromBrowser: boolean;
  at: number;
}

export interface Canary {
  origin: string;
  port: number;
  hits: CanaryHit[];
  /** Raw TCP connections accepted (a preconnect opens one without sending a request). */
  connections: () => number;
  /** Tells the canary which messages exist, so later hits can name theirs. Call before any browser starts. */
  track: (entries: readonly { id: string }[]) => void;
  close: () => Promise<void>;
}

/** Chromium sends a user agent naming itself; Node's instrumentation sends `node` and a trace header. */
export function isBrowserTraffic(headers: IncomingHttpHeaders): boolean {
  if (headers.traceparent !== undefined) return false;
  return /Chrome|Electron|Chromium/i.test(headers['user-agent'] ?? '');
}

/** Maps `/<id>/<vector>` or a `<tag>.…` Host header back to a corpus id. */
export function attributeHit(
  url: string,
  host: string | undefined,
  idsByTag: ReadonlyMap<string, string>,
  ids: ReadonlySet<string>,
): string | undefined {
  const first = decodeURIComponent(url.split('?')[0].split('/')[1] ?? '');
  if (ids.has(first)) return first;
  const tag = /^(m\d+|g\d+)\./.exec(host ?? '')?.[1];
  return tag === undefined ? undefined : idsByTag.get(tag);
}

export async function startCanary(): Promise<Canary> {
  const hits: CanaryHit[] = [];
  let connections = 0;
  let ids = new Set<string>();
  let idsByTag = new Map<string, string>();
  const record = (
    kind: CanaryHit['kind'],
    method: string,
    url: string,
    headers: IncomingHttpHeaders,
  ) => {
    const messageId = attributeHit(url, headers.host, idsByTag, ids);
    hits.push({
      kind,
      method,
      url,
      headers,
      messageId,
      fromBrowser: isBrowserTraffic(headers),
      at: Date.now(),
    });
  };
  const server: Server = createServer((request, response) => {
    record('http', request.method ?? 'GET', request.url ?? '/', request.headers);
    response.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
    response.end('canary');
    request.resume();
  });
  server.on('upgrade', (request, socket) => {
    record('upgrade', request.method ?? 'GET', request.url ?? '/', request.headers);
    socket.destroy();
  });
  server.on('connection', () => {
    connections += 1;
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    hits,
    connections: () => connections,
    track(entries) {
      ids = new Set(entries.map(entry => entry.id));
      idsByTag = new Map(entries.map(entry => [canaryTag(entry.id), entry.id]));
    },
    close: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/**
 * Chromium's `--host-resolver-rules` for the DNS canary: each message's canary host goes to `<tag>.localhost:<port>`
 * (a name Chromium resolves to loopback by itself), every other host fails at once, so nothing is ever looked up
 * outside the machine. 127.0.0.1 and `*.localhost` stay reachable for the harness's own servers and the canary.
 */
export function hostResolverRules(
  entries: readonly { id: string }[],
  canaryPort: number,
  dnsSuffix: string = DEFAULT_DNS_SUFFIX,
): string {
  const rules = entries.map(
    entry =>
      `MAP ${canaryTag(entry.id)}.${dnsSuffix} ${canaryTag(entry.id)}.localhost:${canaryPort}`,
  );
  rules.push(`MAP *.${dnsSuffix} stray.localhost:${canaryPort}`);
  rules.push('MAP * ~NOTFOUND', 'EXCLUDE 127.0.0.1', 'EXCLUDE localhost', 'EXCLUDE *.localhost');
  return rules.join(', ');
}

export interface NetLogHit {
  messageId: string | undefined;
  /** The canary name seen, such as `m017.localhost` or `m017.canary-dns.example`. */
  name: string;
  /** The Chromium net-log event type, such as `HTTP_STREAM_JOB_CONTROLLER` or `HOST_RESOLVER_MANAGER_REQUEST`. */
  event: string;
  params: string;
}

interface NetLogFile {
  constants: { logEventTypes: Record<string, number> };
  events: { type: number; params?: unknown }[];
}

/**
 * Finds every net-log event that names a canary host (original or rewritten) or the canary port. The log is the
 * browser's own record: a request that Playwright never saw (a prefetch, a preconnect, a DNS lookup) is in it.
 */
export function scanNetLog(
  text: string,
  entries: readonly { id: string }[],
  canaryPort: number,
  dnsSuffix: string = DEFAULT_DNS_SUFFIX,
): NetLogHit[] {
  const idsByTag = new Map(entries.map(entry => [canaryTag(entry.id), entry.id]));
  const suffix = dnsSuffix.replaceAll('.', '\\.');
  const named = new RegExp(`\\b((?:m|g)\\d+|stray)\\.(?:localhost|${suffix})\\b`);
  const canaryAddress = new RegExp(`127\\.0\\.0\\.1:${canaryPort}\\b|localhost:${canaryPort}\\b`);
  const log = JSON.parse(text) as NetLogFile;
  const names = new Map(
    Object.entries(log.constants.logEventTypes).map(([name, code]) => [code, name]),
  );
  const found: NetLogHit[] = [];
  for (const event of log.events) {
    if (event.params === undefined) continue;
    const params = JSON.stringify(event.params);
    const match = named.exec(params);
    if (!match && !canaryAddress.test(params)) continue;
    found.push({
      messageId: match ? idsByTag.get(match[1]) : undefined,
      name: match ? match[0] : `127.0.0.1:${canaryPort}`,
      event: names.get(event.type) ?? String(event.type),
      params: params.slice(0, 200),
    });
  }
  return found;
}
