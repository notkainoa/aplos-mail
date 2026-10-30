import { lookup } from 'node:dns/promises';
import type { ImageRefusal } from '@aplos/engine/ports';
import { classifyAddress, ipv4Number } from './classify';

/**
 * URL checks and the single DNS lookup. A URL is parsed once by the WHATWG parser (which folds decimal, octal, hex and
 * short IPv4 forms into a dotted quad), checked for scheme, credentials and port, and its host resolved exactly once.
 * The result is a pinned target: the one checked address to connect to, plus the original name for `Host` and SNI.
 */

export interface ResolvedAddress {
  address: string;
  family: number;
}

/** Every address for a name, in the order the system prefers. Injected by tests; never consulted for IP literals. */
export type Resolver = (host: string) => Promise<ResolvedAddress[]>;

export interface PinnedTarget {
  url: URL;
  secure: boolean;
  /** The checked address the socket connects to. */
  address: string;
  family: 4 | 6;
  port: number;
  /** `Host` header value: the URL's own host, with the port only when it is not the scheme's default. */
  hostHeader: string;
  /** TLS server name: the original host name without a trailing dot; absent for IP literals. */
  servername?: string;
  path: string;
}

export type PinResult = { ok: true; target: PinnedTarget } | { ok: false; reason: ImageRefusal };

interface ParsedTarget {
  url: URL;
  host: string;
  literal: boolean;
  port: number;
}

const DEFAULT_PORTS: Record<string, number> = { 'http:': 80, 'https:': 443 };

/** The system resolver: one `getaddrinfo` call returning every answer, in the order the system gives them. */
export const systemResolver: Resolver = host => lookup(host, { all: true, order: 'verbatim' });

function refused(reason: ImageRefusal): PinResult {
  return { ok: false, reason };
}

function parseUrl(input: string | URL): URL | null {
  try {
    return new URL(input);
  } catch {
    return null;
  }
}

/** Names the system resolves locally without asking DNS. The address check catches them too; this is belt and braces. */
function localName(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, '');
  return name === 'localhost' || name.endsWith('.localhost');
}

/**
 * Checks everything that needs no network: scheme (`scheme`, also for unparseable URLs), credentials in the authority
 * (`address`: userinfo never reaches an image host), port (`port`), and the host's shape.
 */
export function parseTarget(
  input: string | URL,
  ports: readonly number[],
): ParsedTarget | ImageRefusal {
  const url = parseUrl(input);
  if (!url || !Object.hasOwn(DEFAULT_PORTS, url.protocol)) return 'scheme';
  if (url.username || url.password) return 'address';
  const port = url.port ? Number(url.port) : DEFAULT_PORTS[url.protocol];
  if (!ports.includes(port)) return 'port';
  const host = url.hostname;
  const literal = host.startsWith('[') || ipv4Number(host) !== null;
  // The WHATWG parser already folded or rejected numeric hosts; never hand a numeric-looking name to getaddrinfo.
  if (!host || localName(host) || (!literal && /^[0-9.]+$/.test(host))) return 'address';
  return { url, host, literal, port };
}

function pinned(parsed: ParsedTarget, address: string, family: 4 | 6): PinnedTarget {
  const { url, host, literal, port } = parsed;
  return {
    url,
    secure: url.protocol === 'https:',
    address,
    family,
    port,
    hostHeader: url.host,
    servername: literal ? undefined : host.replace(/\.$/, ''),
    path: `${url.pathname}${url.search}`,
  };
}

/** Resolves once and refuses when any answer is refused; connects to the first answer, as the system ordered them. */
async function pinName(parsed: ParsedTarget, resolve: Resolver): Promise<PinResult> {
  const answers = await resolve(parsed.host);
  if (!Array.isArray(answers) || answers.length === 0) return refused('address');
  const verdicts = answers.map(answer => classifyAddress(String(answer?.address)));
  const first = verdicts[0];
  if (!first.allowed || !verdicts.every(verdict => verdict.allowed)) return refused('address');
  return { ok: true, target: pinned(parsed, first.address, first.family) };
}

/**
 * The URL as one pinned connection target, or why it is refused. IP literals skip DNS but are classified the same
 * way. A resolver failure rejects (the caller reports it as `http`).
 */
export async function pinTarget(
  input: string | URL,
  ports: readonly number[],
  resolve: Resolver,
): Promise<PinResult> {
  const parsed = parseTarget(input, ports);
  if (typeof parsed === 'string') return refused(parsed);
  if (!parsed.literal) return pinName(parsed, resolve);
  const verdict = classifyAddress(parsed.host);
  if (!verdict.allowed) return refused('address');
  return { ok: true, target: pinned(parsed, verdict.address, verdict.family) };
}
