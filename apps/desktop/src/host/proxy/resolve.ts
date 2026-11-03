import { lookup } from 'node:dns/promises';
import type { ImageRefusal } from '@aplos/engine/ports';
import { classifyAddress, ipv4Number } from './classify';
import { createSemaphore } from './limits';

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
export type Resolver = (host: string, signal?: AbortSignal) => Promise<ResolvedAddress[]>;

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

/** URL schemes a caller may allow; `parseTarget` and `pinTarget` default to both. */
export type Scheme = 'http' | 'https';

const ALL_SCHEMES: readonly Scheme[] = ['http', 'https'];

/** Lookups in flight at once: `getaddrinfo` runs on libuv's four-thread pool, which a slow DNS must not fill. */
export const MAX_LOOKUPS = 2;

type Lookup = (host: string) => Promise<ResolvedAddress[]>;

const getaddrinfo: Lookup = host => lookup(host, { all: true, order: 'verbatim' });

/**
 * A resolver around one lookup: at most `limit` calls in flight, the rest queued. A slot frees when its lookup
 * settles, not when its caller gives up, so abandoned lookups still count against the pool.
 */
export function createSystemResolver(
  run: Lookup = getaddrinfo,
  limit: number = MAX_LOOKUPS,
): Resolver {
  const slots = createSemaphore(limit);
  return async (host, signal) => {
    const release = await slots.acquire(signal);
    try {
      return await run(host);
    } finally {
      release();
    }
  };
}

/** The system resolver: one `getaddrinfo` call returning every answer, in the order the system gives them. */
export const systemResolver: Resolver = createSystemResolver();

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
  const name = host.toLowerCase().replace(/\.+$/, '');
  return name === 'localhost' || name.endsWith('.localhost');
}

/** Suffixes of names only a private network can answer; split-horizon DNS could point them at internal hosts. */
const PRIVATE_SUFFIXES = ['local', 'internal', 'lan', 'home.arpa'];

/** A name with no dot is a search-domain shortcut (`intranet`), and a private suffix is an internal name. */
function privateName(host: string): boolean {
  const name = host.replace(/\.+$/, '');
  return (
    !name.includes('.') ||
    PRIVATE_SUFFIXES.some(suffix => name === suffix || name.endsWith(`.${suffix}`))
  );
}

/**
 * A name with an empty label (`a..b`, `.example`, `printer.local..`) after its one legitimate trailing root dot. No
 * real host name has one, and the resolver's search-domain and mDNS handling of such names is not worth trusting.
 */
function hasEmptyLabel(host: string): boolean {
  return host.replace(/\.$/, '').split('.').includes('');
}

/**
 * Checks everything that needs no network: scheme (`scheme`, also for unparseable URLs), credentials in the authority
 * (`address`: userinfo never reaches an image host), port (`port`), and the host's shape. Only `schemes` (both by
 * default) are accepted; a caller that needs https alone gets `scheme` here, before anything is resolved.
 */
export function parseTarget(
  input: string | URL,
  ports: readonly number[],
  schemes: readonly Scheme[] = ALL_SCHEMES,
): ParsedTarget | ImageRefusal {
  const url = parseUrl(input);
  if (!url || !Object.hasOwn(DEFAULT_PORTS, url.protocol)) return 'scheme';
  if (!schemes.includes(url.protocol.slice(0, -1) as Scheme)) return 'scheme';
  if (url.username || url.password) return 'address';
  const port = url.port ? Number(url.port) : DEFAULT_PORTS[url.protocol];
  if (!ports.includes(port)) return 'port';
  const host = url.hostname;
  const literal = host.startsWith('[') || ipv4Number(host) !== null;
  // The WHATWG parser already folded or rejected numeric hosts; never hand a numeric-looking name to getaddrinfo.
  if (!host || localName(host) || (!literal && /^[0-9.]+$/.test(host))) return 'address';
  if (!literal && (privateName(host) || hasEmptyLabel(host))) return 'address';
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
async function pinName(
  parsed: ParsedTarget,
  resolve: Resolver,
  signal?: AbortSignal,
): Promise<PinResult> {
  const answers = await resolve(parsed.host, signal);
  if (!Array.isArray(answers) || answers.length === 0) return refused('address');
  const verdicts = answers.map(answer => classifyAddress(String(answer?.address)));
  const first = verdicts[0];
  if (!first.allowed || !verdicts.every(verdict => verdict.allowed)) return refused('address');
  return { ok: true, target: pinned(parsed, first.address, first.family) };
}

/**
 * The URL as one pinned connection target, or why it is refused. IP literals skip DNS but are classified the same
 * way. A resolver failure rejects (the caller reports it as `http`). `schemes` limits the accepted schemes (both by
 * default).
 */
export async function pinTarget(
  input: string | URL,
  ports: readonly number[],
  resolve: Resolver,
  signal?: AbortSignal,
  schemes?: readonly Scheme[],
): Promise<PinResult> {
  const parsed = parseTarget(input, ports, schemes);
  if (typeof parsed === 'string') return refused(parsed);
  if (!parsed.literal) return pinName(parsed, resolve, signal);
  const verdict = classifyAddress(parsed.host);
  if (!verdict.allowed) return refused('address');
  return { ok: true, target: pinned(parsed, verdict.address, verdict.family) };
}
