/** DNS lookups over HTTPS (JSON API), so they work wherever `fetch` does: desktop, browser preview and mobile. */

export type DnsType = 'MX' | 'TXT' | 'CNAME' | 'A' | 'AAAA';
export interface DnsOptions {
  fetch?: typeof fetch;
  signal?: AbortSignal;
  /** Per-resolver timeout; defaults to 8 seconds. */
  timeoutMs?: number;
}

/** Tried in order; the next one is used only when the previous could not answer. */
export const DOH_RESOLVERS = ['https://cloudflare-dns.com/dns-query', 'https://dns.google/resolve'];
const TYPE_CODES: Record<DnsType, number> = { A: 1, CNAME: 5, MX: 15, TXT: 16, AAAA: 28 };

interface DohAnswer {
  name?: string;
  type?: number;
  data?: string;
  TTL?: number;
}
interface DohResponse {
  Status?: number;
  Answer?: DohAnswer[];
}

/** Lowercase ASCII (punycode) form of a domain name without the trailing dot, or undefined when it is not one. */
export function normalizeDomain(name: string): string | undefined {
  let host = String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');
  if (!host || /[\s/?#@:\\%[\]<>"'`]/.test(host)) return undefined;
  if (/[^\x00-\x7f]/.test(host)) {
    try {
      host = new URL(`http://${host}`).hostname;
    } catch {
      return undefined;
    }
  }
  if (host.length > 253) return undefined;
  const labels = host.split('.');
  return labels.length >= 2 &&
    labels.every(label => /^[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?$/.test(label))
    ? host
    : undefined;
}

const bareHost = (value: string) => value.trim().toLowerCase().replace(/\.$/, '');

/** Joins the quoted character-strings of a TXT answer (`"a" "b"` → `ab`), undoing `\"`, `\\` and `\DDD` escapes. */
export function txtValue(data: string): string {
  const text = data.trim();
  if (!text.startsWith('"')) return text;
  let out = '',
    i = 0;
  while (i < text.length) {
    if (text[i] !== '"') {
      i++;
      continue;
    }
    i++;
    while (i < text.length && text[i] !== '"') {
      if (text[i] === '\\' && i + 1 < text.length) {
        const digits = /^\d{3}/.exec(text.slice(i + 1, i + 4));
        if (digits) {
          out += String.fromCharCode(Number(digits[0]));
          i += 4;
        } else {
          out += text[i + 1];
          i += 2;
        }
      } else out += text[i++];
    }
    i++;
  }
  return out;
}

function answers(list: DohAnswer[], type: DnsType): string[] {
  const code = TYPE_CODES[type],
    matching = list
      .filter(a => a.type === code && typeof a.data === 'string')
      .map(a => a.data as string);
  if (type === 'TXT') return matching.map(txtValue);
  if (type === 'MX') {
    const records = matching.map(data => {
      const [pref, host = ''] = data.trim().split(/\s+/);
      return { pref: Number(pref) || 0, host: bareHost(host) };
    });
    // A null MX ("0 .") means the domain accepts no mail; it is not a host to report.
    return [
      ...new Set(
        records
          .filter(r => r.host)
          .sort((a, b) => a.pref - b.pref)
          .map(r => r.host),
      ),
    ];
  }
  return [...new Set(matching.map(type === 'CNAME' ? bareHost : (d: string) => d.trim()))];
}

/** `outer` combined with a timeout, where the runtime supports both. */
export function timeoutSignal(outer: AbortSignal | undefined, ms: number): AbortSignal | undefined {
  const timer =
    typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(ms)
      : undefined;
  if (!outer) return timer;
  if (!timer) return outer;
  return typeof AbortSignal.any === 'function' ? AbortSignal.any([outer, timer]) : outer;
}

/**
 * Records of one type for a name. Resolves to `[]` when the name does not exist or has no such records,
 * and to `undefined` when no resolver could answer. Throws for names that are not valid domain names.
 */
export async function resolveDns(
  name: string,
  type: DnsType,
  options: DnsOptions = {},
): Promise<string[] | undefined> {
  const host = normalizeDomain(name);
  if (!host) throw new TypeError(`Not a valid domain name: ${name}`);
  const doFetch = options.fetch ?? globalThis.fetch,
    query = new URLSearchParams({ name: host, type }).toString();
  for (const base of DOH_RESOLVERS) {
    if (options.signal?.aborted) throw options.signal.reason;
    try {
      const response = await doFetch(`${base}?${query}`, {
        headers: { accept: 'application/dns-json' },
        signal: timeoutSignal(options.signal, options.timeoutMs ?? 8000),
      });
      if (!response.ok) continue;
      const body = (await response.json()) as DohResponse;
      if (body?.Status === 3) return [];
      if (body?.Status !== 0) continue;
      return answers(Array.isArray(body.Answer) ? body.Answer : [], type);
    } catch {
      if (options.signal?.aborted) throw options.signal.reason;
    }
  }
  return undefined;
}

/** Every `k=v` pair of a tag list in order, keys lowercased, repeats kept. */
export function tagList(record: string): [string, string][] {
  return record.split(';').flatMap(part => {
    const at = part.indexOf('='),
      key = at < 0 ? '' : part.slice(0, at).trim().toLowerCase();
    return key ? [[key, part.slice(at + 1).trim()] as [string, string]] : [];
  });
}

/** Keys that appear more than once; DKIM and DMARC treat such records as invalid. */
export function duplicateTags(record: string): string[] {
  const seen = new Set<string>(),
    dupes = new Set<string>();
  for (const [key] of tagList(record)) (seen.has(key) ? dupes : seen).add(key);
  return [...dupes];
}

/** Splits `k=v; k=v` tag lists (DKIM, DMARC, MTA-STS) into a map with lowercase keys; the first of repeated keys wins. */
export function parseTags(record: string): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const [key, value] of tagList(record)) if (!(key in tags)) tags[key] = value;
  return tags;
}
