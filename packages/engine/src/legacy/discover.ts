import { XMLParser } from 'fast-xml-parser';
import type { AccountPreset, ProviderKind, ServerSettings } from './provider';
import {
  duplicateTags,
  normalizeDomain,
  parseTags,
  resolveDns,
  timeoutSignal,
  type DnsOptions,
  type DnsType,
} from './dns';

/** How Aplos should connect an address, and how sure it is. */
export interface Discovery {
  email: string;
  domain: string;
  provider: ProviderKind;
  preset: AccountPreset;
  server?: ServerSettings;
  sessionUrl?: string;
  /** `known`: a consumer domain; `mx`: the domain's mail servers; `autoconfig`: a published config; `guess`: common host names. */
  confidence: 'known' | 'mx' | 'autoconfig' | 'guess';
  /** What the answer came from: a domain list, an MX host, a config URL. */
  source: string;
  /** What the user needs to sign in, in plain words. */
  help?: string;
  /** Set when Aplos cannot connect this kind of account yet, with the reason in plain words. */
  unsupported?: string;
}

export interface DiscoverOptions {
  fetch?: typeof fetch;
  signal?: AbortSignal;
  /** Resolves discovered hosts to vet them; defaults to the system resolver. */ lookup?: HostResolver;
}

type HostedPreset = Exclude<AccountPreset, 'generic'>;
interface PresetInfo {
  provider: ProviderKind;
  name: string;
  server?: ServerSettings;
  sessionUrl?: string;
  help: string;
}

const tls = (host: string, port: number, secure: boolean) => ({ host, port, secure });
export const PRESETS: Record<HostedPreset, PresetInfo> = {
  gmail: {
    provider: 'google',
    name: 'Google',
    help: 'Sign in with Google in your browser. Aplos never sees your password.',
  },
  outlook: {
    provider: 'microsoft',
    name: 'Microsoft',
    help: 'Sign in with Microsoft in your browser. Aplos never sees your password.',
  },
  icloud: {
    provider: 'imap',
    name: 'iCloud',
    server: {
      imap: tls('imap.mail.me.com', 993, true),
      smtp: tls('smtp.mail.me.com', 587, false),
      caldav: 'https://caldav.icloud.com',
    },
    help: 'iCloud needs an app-specific password, not your Apple Account password. Turn on two-factor authentication, then create one at appleid.apple.com under Sign-In and Security > App-Specific Passwords.',
  },
  yahoo: {
    provider: 'imap',
    name: 'Yahoo',
    server: {
      imap: tls('imap.mail.yahoo.com', 993, true),
      smtp: tls('smtp.mail.yahoo.com', 465, true),
    },
    help: 'Yahoo needs an app password, not your regular password. Create one at login.yahoo.com/account/security under Generate app password.',
  },
  aol: {
    provider: 'imap',
    name: 'AOL',
    server: { imap: tls('imap.aol.com', 993, true), smtp: tls('smtp.aol.com', 465, true) },
    help: 'AOL needs an app password, not your regular password. Create one at login.aol.com/account/security under Generate app password.',
  },
  fastmail: {
    provider: 'jmap',
    name: 'Fastmail',
    sessionUrl: 'https://api.fastmail.com/jmap/session',
    help: 'Fastmail needs an API token. Create one in Fastmail under Settings > Privacy & Security > API tokens, with access to Email and Email submission.',
  },
};
const GENERIC_HELP =
  'Use your email password, or an app password if your provider requires one for other mail apps.';

const COUNTRY_TLD = String.raw`(com|net|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})`;
const FASTMAIL_DOMAINS = new Set([
  'fastmail.com',
  'fastmail.fm',
  'fastmail.cn',
  'fastmail.co.uk',
  'fastmail.com.au',
  'fastmail.de',
  'fastmail.es',
  'fastmail.in',
  'fastmail.jp',
  'fastmail.mx',
  'fastmail.net',
  'fastmail.nl',
  'fastmail.org',
  'fastmail.se',
  'fastmail.to',
  'fastmail.tw',
  'fastmail.us',
  'messagingengine.com',
  'sent.com',
  'eml.cc',
  'fmail.co.uk',
  'mailbolt.com',
  'mailcan.com',
  'mailhaven.com',
  'mailmight.com',
  'ml1.net',
  'mm.st',
  'myfastmail.com',
  'proinbox.com',
  'promessage.com',
  'rushpost.com',
  'speedymail.org',
  'warpmail.net',
  'xsmail.com',
  '123mail.org',
  'airpost.net',
  'fastem.com',
  'fastemail.us',
  'fastimap.com',
  'fastmailbox.net',
  'fea.st',
  'imapmail.org',
  'ownmail.net',
  'postinbox.com',
  'realemail.net',
  'sent.as',
  'sent.at',
  'ssl-mail.com',
  'veryfast.biz',
]);
const KNOWN: [RegExp, HostedPreset][] = [
  [/^(gmail|googlemail)\.com$/, 'gmail'],
  [new RegExp(`^(outlook|hotmail|live)\\.${COUNTRY_TLD}$`), 'outlook'],
  [/^msn\.com$/, 'outlook'],
  [/^(icloud|me|mac)\.com$/, 'icloud'],
  [new RegExp(`^yahoo\\.${COUNTRY_TLD}$`), 'yahoo'],
  [/^(ymail|rocketmail)\.com$/, 'yahoo'],
  [new RegExp(`^aol\\.${COUNTRY_TLD}$`), 'aol'],
  [/^aim\.com$/, 'aol'],
];
const PROTON_DOMAINS = new Set(['proton.me', 'protonmail.com', 'protonmail.ch', 'pm.me']);
const PROTON_MX = /(^|\.)protonmail\.ch$/;
const PROTON_NOTE =
  'Proton Mail only works with other mail apps through Proton Mail Bridge, which Aplos does not support yet.';
// ---------------------------------------------------------------------------------------------------------
// Public-host checks. Discovered settings come from files and DNS the domain owner controls, so a hostile
// config could aim the user's password at this computer or the local network. Only discovered hosts are
// checked: servers the user types by hand may legitimately be on a LAN.

/** Addresses a host name resolves to; rejects when it cannot be resolved. */
export type HostResolver = (host: string) => Promise<string[]>;
/**
 * A and AAAA records over DNS-over-HTTPS, since the engine must run without Node. Desktop callers should pass
 * the system resolver (`node:dns/promises` lookup with `all:true`), which also sees split-horizon names.
 */
export function dohLookup(options: DnsOptions = {}): HostResolver {
  return async host => {
    const [a, aaaa] = await Promise.all([
      resolveDns(host, 'A', options),
      resolveDns(host, 'AAAA', options),
    ]);
    if (!a && !aaaa) throw new Error(`Couldn't resolve ${host}`);
    return [...(a ?? []), ...(aaaa ?? [])];
  };
}

/** IPv4 literal as a 32-bit number, accepting the forms `inet_aton` and URL parsers do (`127.1`, `0x7f.1`, `017700000001`). */
export function parseIPv4(text: string): number | undefined {
  const parts = text.split('.');
  if (parts.length > 4 || parts.some(p => !p)) return undefined;
  const nums = parts.map(p =>
    /^0x[0-9a-f]*$/i.test(p)
      ? parseInt(p.slice(2) || '0', 16)
      : /^0[0-7]*$/.test(p)
        ? parseInt(p, 8)
        : /^[1-9]\d*$/.test(p)
          ? Number(p)
          : NaN,
  );
  if (nums.some(n => !Number.isFinite(n))) return undefined;
  const last = nums.pop()!;
  if (nums.some(n => n > 255) || last >= 2 ** (8 * (4 - nums.length))) return undefined;
  return nums.reduce((acc, n, i) => acc + n * 2 ** (8 * (3 - i)), 0) + last;
}

/** IPv6 literal (brackets and zone allowed) as 16 bytes. */
export function parseIPv6(text: string): number[] | undefined {
  let s = text.replace(/^\[(.*)\]$/, '$1').replace(/%.*$/, '');
  if (!s.includes(':')) return undefined;
  const tail: number[] = [];
  const v4 = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const n =
      /^\d+(\.\d+){3}$/.test(v4[2]) && v4[2].split('.').every(p => Number(p) <= 255)
        ? parseIPv4(v4[2])
        : undefined;
    if (n === undefined) return undefined;
    tail.push(n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
    s = v4[1].endsWith('::') ? v4[1] : v4[1].slice(0, -1);
  }
  const halves = s.split('::');
  if (halves.length > 2) return undefined;
  const groups = (h: string) => (h ? h.split(':') : []);
  const head = groups(halves[0]),
    rest = halves.length === 2 ? groups(halves[1]) : [],
    want = 8 - tail.length / 2;
  if ([...head, ...rest].some(g => !/^[0-9a-f]{1,4}$/i.test(g))) return undefined;
  const fill = want - head.length - rest.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return undefined;
  const words = [...head, ...Array(halves.length === 2 ? fill : 0).fill('0'), ...rest].map(g =>
    parseInt(g, 16),
  );
  return [...words.flatMap(w => [w >> 8, w & 255]), ...tail];
}

const V4_BLOCKED: [number, number][] = [
  [0x00000000, 8],
  [0x0a000000, 8],
  [0x64400000, 10],
  [0x7f000000, 8],
  [0xa9fe0000, 16],
  [0xac100000, 12],
  [0xc0000000, 24],
  [0xc0a80000, 16],
  [0xc6120000, 15],
  [0xe0000000, 4],
  [0xf0000000, 4],
];
const v4Blocked = (n: number) =>
  V4_BLOCKED.some(
    ([base, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(base / 2 ** (32 - bits)),
  );
function v6Blocked(b: number[]): boolean {
  const zero = (from: number, to: number) => b.slice(from, to).every(x => x === 0),
    v4 = (at: number) => b[at] * 2 ** 24 + b[at + 1] * 2 ** 16 + b[at + 2] * 2 ** 8 + b[at + 3];
  if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return v4Blocked(v4(12));
  if (zero(0, 12)) return true; // ::, ::1 and deprecated IPv4-compatible forms
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zero(4, 12))
    return v4Blocked(v4(12)); // NAT64
  if (b[0] === 0x20 && b[1] === 0x02) return v4Blocked(v4(2)); // 6to4
  return (b[0] & 0xfe) === 0xfc || (b[0] === 0xfe && b[1] >= 0x80) || b[0] === 0xff; // fc00::/7, fe80::/10 and fec0::/10, ff00::/8
}

/** Whether an address literal is loopback, private, link-local, CGNAT, unspecified, multicast or reserved; undefined for non-literals. */
export function blockedAddress(text: string): boolean | undefined {
  const v6 = parseIPv6(text);
  if (v6) return v6Blocked(v6);
  const v4 = parseIPv4(text);
  return v4 === undefined ? undefined : v4Blocked(v4);
}

const LOCAL_NAME = /(^|\.)(localhost|local|internal|localdomain|home\.arpa|lan|intranet)$/;
/** The checks that need no lookup: local-only names and every IP literal in a non-public range. */
function publicName(host: string): boolean {
  const name = host.trim().toLowerCase().replace(/\.$/, '');
  if (!name) return false;
  const literal = blockedAddress(name);
  if (literal !== undefined) return !literal;
  // Names whose last label is numeric are parsed as IPv4 by URL parsers, so they are never treated as plain names.
  if (!name.includes('.') || LOCAL_NAME.test(name) || /(^|\.)(0x[0-9a-f]*|\d+)$/i.test(name))
    return false;
  return true;
}

/**
 * Whether a discovered server host is safe to send credentials to: not a local name, not a non-public IP literal,
 * and not resolving to any non-public address. A name that does not resolve is allowed, since nothing can connect to it.
 */
export async function publicHost(
  host: string,
  resolve: HostResolver = dohLookup(),
): Promise<boolean> {
  if (!publicName(host)) return false;
  if (blockedAddress(host.trim()) !== undefined) return true;
  let addresses: string[];
  try {
    addresses = await resolve(host.trim().toLowerCase().replace(/\.$/, ''));
  } catch {
    return true;
  }
  return addresses.every(a => blockedAddress(a) === false);
}

async function publicServer(server: ServerSettings, resolve?: HostResolver): Promise<boolean> {
  let caldav: string | undefined;
  if (server.caldav) {
    try {
      const url = new URL(server.caldav);
      if (url.protocol !== 'https:') return false;
      caldav = url.hostname;
    } catch {
      return false;
    }
  }
  const hosts = [server.imap.host, server.smtp.host, ...(caldav ? [caldav] : [])];
  return (await Promise.all(hosts.map(h => publicHost(h, resolve)))).every(Boolean);
}
/** Preset for a consumer mail domain whose settings are known without any lookup. */
export function knownDomain(domain: string): HostedPreset | undefined {
  return FASTMAIL_DOMAINS.has(domain)
    ? 'fastmail'
    : KNOWN.find(([pattern]) => pattern.test(domain))?.[1];
}

const MX_PATTERNS: [RegExp, HostedPreset][] = [
  [/(^|\.)(google|googlemail)\.com$/, 'gmail'],
  [/(^|\.)outlook\.com$/, 'outlook'],
  [/\.mx\.microsoft$/, 'outlook'],
  [/(^|\.)mail\.icloud\.com$/, 'icloud'],
  [/(^|\.)messagingengine\.com$/, 'fastmail'],
  [/aol.*\.yahoodns\.net$/, 'aol'],
  [/\.yahoodns\.net$/, 'yahoo'],
];
/** Preset for a domain hosted elsewhere, judged from one of its MX hosts. */
export function mxPreset(host: string): HostedPreset | undefined {
  return MX_PATTERNS.find(([pattern]) => pattern.test(host))?.[1];
}

/** Preset implied by an IMAP host from a published config (a domain on Google with an autoconfig file, say). */
const IMAP_PATTERNS: [RegExp, HostedPreset][] = [
  [/(^|\.)(gmail|googlemail)\.com$/, 'gmail'],
  [/(^|\.)(outlook|office365)\.com$/, 'outlook'],
  [/(^|\.)mail\.me\.com$/, 'icloud'],
  [/(^|\.)mail\.yahoo\.com$/, 'yahoo'],
  [/(^|\.)aol\.com$/, 'aol'],
  [/(^|\.)(fastmail\.com|messagingengine\.com)$/, 'fastmail'],
];

const SECOND_LEVEL = /^(co|com|net|org|gov|edu|ac|ne|or)\.[a-z]{2}$/;
/** Best-effort registrable domain (`mx1.mail.host.co.uk` → `host.co.uk`) without a public-suffix list. */
export function registrableDomain(host: string): string {
  const labels = host.split('.'),
    keep = SECOND_LEVEL.test(labels.slice(-2).join('.')) ? 3 : 2;
  return labels.slice(-keep).join('.');
}

function copyServer(server?: ServerSettings): ServerSettings | undefined {
  return server && { ...server, imap: { ...server.imap }, smtp: { ...server.smtp } };
}

function fromPreset(
  email: string,
  domain: string,
  preset: HostedPreset,
  confidence: Discovery['confidence'],
  source: string,
  help?: string,
): Discovery {
  const info = PRESETS[preset],
    result: Discovery = {
      email,
      domain,
      provider: info.provider,
      preset,
      confidence,
      source,
      help: help ?? info.help,
    };
  const server = copyServer(info.server);
  if (server) result.server = server;
  if (info.sessionUrl) result.sessionUrl = info.sessionUrl;
  return result;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  parseTagValue: false,
  processEntities: false,
  isArray: name =>
    name === 'emailProvider' || name === 'incomingServer' || name === 'outgoingServer',
});
const text = (value: unknown): string =>
  typeof value === 'object' && value
    ? String((value as Record<string, unknown>)['#text'] ?? '')
    : String(value ?? '');

/** IMAP and SMTP settings from a Thunderbird-style `config-v1.1.xml`, or undefined when it has no usable secure pair. */
export function parseAutoconfig(xml: string, email: string): ServerSettings | undefined {
  const at = email.lastIndexOf('@'),
    local = email.slice(0, at),
    domain = email.slice(at + 1);
  const fill = (value: string) =>
    value
      .trim()
      .replace(/%EMAILADDRESS%/g, email)
      .replace(/%EMAILLOCALPART%/g, local)
      .replace(/%EMAILDOMAIN%/g, domain);
  let doc: any;
  try {
    doc = parser.parse(xml);
  } catch {
    return undefined;
  }
  const provider = doc?.clientConfig?.emailProvider?.[0];
  if (!provider || typeof provider !== 'object') return undefined;
  const best = (list: unknown, type: string) => {
    const servers = (Array.isArray(list) ? list : [])
      .filter(s => s && s['@type'] === type)
      .map(s => {
        const host = normalizeDomain(fill(text(s.hostname))),
          port = Number(text(s.port)),
          socket = text(s.socketType).trim().toUpperCase();
        // Plain-text connections would send the password unencrypted, so only TLS and STARTTLS entries count.
        const secure =
          socket === 'SSL' || socket === 'TLS' ? true : socket === 'STARTTLS' ? false : undefined;
        if (
          !host ||
          !publicName(host) ||
          !Number.isInteger(port) ||
          port < 1 ||
          port > 65535 ||
          secure === undefined
        )
          return undefined;
        return { host, port, secure, username: fill(text(s.username)) };
      })
      .filter(s => s !== undefined);
    return servers.find(s => s.secure) ?? servers[0];
  };
  const imap = best(provider.incomingServer, 'imap'),
    smtp = best(provider.outgoingServer, 'smtp');
  if (!imap || !smtp) return undefined;
  const settings: ServerSettings = {
    imap: { host: imap.host, port: imap.port, secure: imap.secure },
    smtp: { host: smtp.host, port: smtp.port, secure: smtp.secure },
  };
  if (imap.username && imap.username !== email && !imap.username.includes('%'))
    settings.username = imap.username;
  return settings;
}

const MAX_REDIRECTS = 3;
const hostResolver = (options: DiscoverOptions) =>
  options.lookup ?? dohLookup({ fetch: options.fetch, signal: options.signal });
async function fetchAutoconfig(
  url: string,
  email: string,
  options: DiscoverOptions,
): Promise<ServerSettings | undefined> {
  try {
    let next = new URL(url);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      // Each hop is vetted before it is requested: plain HTTP could be tampered with, and a private host would be a request into the local network.
      if (next.protocol !== 'https:' || !(await publicHost(next.hostname, hostResolver(options))))
        return undefined;
      const response = await (options.fetch ?? globalThis.fetch)(next.href, {
        redirect: 'manual',
        headers: { accept: 'application/xml, text/xml;q=0.9, */*;q=0.1' },
        signal: timeoutSignal(options.signal, 8000),
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) return undefined;
        next = new URL(location, next);
        continue;
      }
      if (!response.ok) return undefined;
      const body = await response.text(),
        settings = body.length > 1_000_000 ? undefined : parseAutoconfig(body, email);
      return settings && (await publicServer(settings, hostResolver(options)))
        ? settings
        : undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Splits and validates an address; throws a user-facing error when it is not one. */
export function splitEmail(input: string): { email: string; local: string; domain: string } {
  const email = String(input ?? '').trim(),
    at = email.lastIndexOf('@');
  const local = email.slice(0, at),
    domain = at > 0 ? normalizeDomain(email.slice(at + 1)) : undefined;
  if (!domain || !local || /\s/.test(local))
    throw new Error('Enter a full email address, like name@example.com.');
  return { email: `${local}@${domain}`, local, domain };
}

/**
 * Works out how to connect an address: known consumer domains first, then the domain's MX hosts, then
 * published autoconfig files (the domain's own, then Thunderbird's ISPDB), and finally common host names.
 */
export async function discoverAccount(
  input: string,
  options: DiscoverOptions = {},
): Promise<Discovery> {
  const { email, domain } = splitEmail(input),
    dns: DnsOptions = { fetch: options.fetch, signal: options.signal };
  if (PROTON_DOMAINS.has(domain))
    return {
      email,
      domain,
      provider: 'imap',
      preset: 'generic',
      confidence: 'known',
      source: `${domain} is a Proton Mail address`,
      unsupported: PROTON_NOTE,
    };
  const known = knownDomain(domain);
  if (known)
    return fromPreset(
      email,
      domain,
      known,
      'known',
      `${domain} is a ${PRESETS[known].name} address`,
    );

  const mx = await resolveDns(domain, 'MX', dns);
  for (const host of mx ?? []) {
    if (PROTON_MX.test(host))
      return {
        email,
        domain,
        provider: 'imap',
        preset: 'generic',
        confidence: 'mx',
        source: `MX record ${host}`,
        unsupported: PROTON_NOTE,
      };
    const preset = mxPreset(host);
    if (!preset) continue;
    const help =
      preset === 'icloud'
        ? `${PRESETS.icloud.help} Sign in with your Apple Account email address, not ${email}.`
        : undefined;
    return fromPreset(email, domain, preset, 'mx', `MX record ${host}`, help);
  }

  const query = new URLSearchParams({ emailaddress: email }).toString(),
    ispdb = 'https://autoconfig.thunderbird.net/v1.1/';
  const urls = [
    `https://autoconfig.${domain}/mail/config-v1.1.xml?${query}`,
    `https://${domain}/.well-known/autoconfig/mail/config-v1.1.xml?${query}`,
    `${ispdb}${domain}`,
  ];
  const mxDomain = mx?.[0] && registrableDomain(mx[0]);
  if (mxDomain && mxDomain !== domain) urls.push(`${ispdb}${mxDomain}`);
  const found = await Promise.all(urls.map(url => fetchAutoconfig(url, email, options)));
  const index = found.findIndex(Boolean);
  if (index >= 0) {
    const server = found[index] as ServerSettings,
      preset = IMAP_PATTERNS.find(([pattern]) => pattern.test(server.imap.host))?.[1];
    if (preset) return fromPreset(email, domain, preset, 'autoconfig', urls[index]);
    return {
      email,
      domain,
      provider: 'imap',
      preset: 'generic',
      server,
      confidence: 'autoconfig',
      source: urls[index],
      help: GENERIC_HELP,
    };
  }

  const guess = { imap: tls(`imap.${domain}`, 993, true), smtp: tls(`smtp.${domain}`, 465, true) };
  return {
    email,
    domain,
    provider: 'imap',
    preset: 'generic',
    confidence: 'guess',
    source: 'common host names',
    ...((await publicServer(guess, hostResolver(options))) ? { server: guess } : {}),
    help: `Aplos couldn't find published settings for ${domain}, so these are common guesses. Check the server names with your mail provider. ${GENERIC_HELP}`,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Custom-domain DNS health

export type DomainCheckId = 'mx' | 'spf' | 'dkim' | 'dmarc' | 'mta-sts';
export type CheckStatus = 'pass' | 'warn' | 'fail' | 'unknown';
export interface DomainCheck {
  id: DomainCheckId;
  status: CheckStatus;
  title: string;
  detail: string;
  fix?: string;
  records: string[];
}
export interface DomainReport {
  domain: string;
  provider: ProviderKind | 'unknown';
  /** The host the rules were checked against; `generic` when it is not one Aplos knows. */
  preset: AccountPreset;
  checks: DomainCheck[];
}
export interface CheckDomainOptions extends DiscoverOptions {
  provider?: ProviderKind | 'unknown';
}

const RANK: Record<CheckStatus, number> = { pass: 0, unknown: 1, warn: 2, fail: 3 };
const worst = (statuses: CheckStatus[]): CheckStatus =>
  statuses.reduce<CheckStatus>((a, b) => (RANK[b] > RANK[a] ? b : a), 'pass');
const UNREACHABLE = "Couldn't look this up. Check your internet connection and try again.";

function choosePreset(
  given: CheckDomainOptions['provider'],
  detected: HostedPreset | undefined,
): AccountPreset {
  if (!given || given === 'unknown') return detected ?? 'generic';
  if (detected && PRESETS[detected].provider === given) return detected;
  return given === 'google'
    ? 'gmail'
    : given === 'microsoft'
      ? 'outlook'
      : given === 'jmap'
        ? 'fastmail'
        : 'generic';
}

function mxFix(domain: string, preset: AccountPreset): string {
  switch (preset) {
    case 'gmail':
      return 'Add one MX record with priority 1 pointing to smtp.google.com, and remove any others.';
    case 'outlook':
      return `Add one MX record with priority 0 pointing to ${domain.replace(/\./g, '-')}.mail.protection.outlook.com (the Microsoft 365 admin center under Settings > Domains shows the exact value), and remove any others.`;
    case 'icloud':
      return 'Add two MX records with priority 10: mx01.mail.icloud.com and mx02.mail.icloud.com, and remove any others.';
    case 'fastmail':
      return 'Add two MX records: in1-smtp.messagingengine.com with priority 10 and in2-smtp.messagingengine.com with priority 20, and remove any others.';
    default:
      return 'Add the MX records your mail provider gives you at your DNS host.';
  }
}

function mxCheck(
  domain: string,
  mx: string[] | undefined,
  detected: HostedPreset | undefined,
  preset: AccountPreset,
): DomainCheck {
  const base = { id: 'mx' as const, title: 'Mail servers (MX)' };
  if (!mx) return { ...base, status: 'unknown', detail: UNREACHABLE, records: [] };
  if (!mx.length)
    return {
      ...base,
      status: 'fail',
      detail: `${domain} has no MX records, so other servers don't know where to deliver its mail.`,
      fix: mxFix(domain, preset),
      records: [],
    };
  const where = detected ? `${mx[0]} (${PRESETS[detected].name})` : mx[0];
  if (preset !== 'generic' && detected !== preset) {
    const name = PRESETS[preset].name;
    return {
      ...base,
      status: 'warn',
      detail: `Mail for ${domain} goes to ${where}, not ${name}. New mail won't reach your ${name} mailbox until the MX records change.`,
      fix: mxFix(domain, preset),
      records: mx,
    };
  }
  return {
    ...base,
    status: 'pass',
    detail: `Mail for ${domain} is delivered to ${where}.`,
    records: mx,
  };
}

const SPF_INCLUDE: Partial<Record<AccountPreset, string>> = {
  gmail: '_spf.google.com',
  outlook: 'spf.protection.outlook.com',
  icloud: 'icloud.com',
  fastmail: 'spf.messagingengine.com',
};
const SPF_LOOKUPS = new Set(['include', 'a', 'mx', 'ptr', 'exists', 'redirect']);
const isSpf = (record: string) => /^v=spf1(\s|$)/i.test(record.trim());
const spfTerms = (record: string) => record.trim().split(/\s+/).slice(1).filter(Boolean);
function spfTerm(term: string) {
  const qualifier = /^[+\-~?]/.test(term) ? term[0] : '+',
    rest = qualifier === term[0] ? term.slice(1) : term;
  const match = /^([a-z0-9_.-]+)([:=/]?)(.*)$/i.exec(rest),
    name = (match?.[1] ?? rest).toLowerCase();
  const value = match?.[2] === ':' || match?.[2] === '=' ? match[3].split('/')[0] : '';
  return { qualifier, name, value };
}
const isAll = (term: string) => spfTerm(term).name === 'all';
/** The terms a receiver evaluates: nothing after `all`, and no `redirect` when there is an `all` (RFC 7208 5.1, 6.1). */
function liveSpfTerms(record: string): string[] {
  const terms = spfTerms(record),
    all = terms.findIndex(isAll);
  return all < 0 ? terms : terms.slice(0, all).filter(t => spfTerm(t).name !== 'redirect');
}

/** Rebuilds an SPF record with `include` added just before the closing `all` (or `~all` when there is none). */
function withInclude(record: string, include: string): string {
  const terms = spfTerms(record),
    all = terms.findIndex(isAll);
  if (all < 0)
    return `v=spf1 ${[...terms.filter(t => !t.toLowerCase().startsWith('redirect=')), `include:${include}`, '~all'].join(' ')}`;
  terms.splice(all, 0, `include:${include}`);
  return `v=spf1 ${terms.join(' ')}`;
}

function mergeSpf(records: string[]): string {
  const terms = new Set<string>();
  let strict = false;
  for (const record of records)
    for (const term of spfTerms(record)) {
      if (isAll(term)) {
        strict ||= term.startsWith('-');
        continue;
      }
      if (!term.toLowerCase().startsWith('redirect=')) terms.add(term);
    }
  return `v=spf1 ${[...terms, strict ? '-all' : '~all'].join(' ')}`;
}

interface SpfWalk {
  lookups: number;
  includes: Set<string>;
  broken: string[];
  partial: boolean;
}

/** Counts the DNS lookups a receiver would make, following include and redirect targets until the limit is passed. */
async function walkSpf(
  record: string,
  walk: SpfWalk,
  dns: (name: string, type: DnsType) => Promise<string[] | undefined>,
  depth: number,
): Promise<void> {
  for (const raw of liveSpfTerms(record)) {
    const term = spfTerm(raw);
    if (!SPF_LOOKUPS.has(term.name)) continue;
    walk.lookups++;
    if (walk.lookups > 10) return;
    if (
      (term.name !== 'include' && term.name !== 'redirect') ||
      !term.value ||
      term.value.includes('%')
    )
      continue;
    const target = term.value.toLowerCase();
    walk.includes.add(target);
    if (depth >= 10) continue;
    const txt = await dns(target, 'TXT').catch(() => [] as string[]);
    if (!txt) {
      walk.partial = true;
      continue;
    }
    const nested = txt.filter(isSpf);
    if (nested.length !== 1) {
      walk.broken.push(target);
      continue;
    }
    await walkSpf(nested[0], walk, dns, depth + 1);
  }
}

async function spfCheck(
  domain: string,
  txt: string[] | undefined,
  preset: AccountPreset,
  dns: (name: string, type: DnsType) => Promise<string[] | undefined>,
): Promise<DomainCheck> {
  const base = { id: 'spf' as const, title: 'Approved senders (SPF)' },
    include = SPF_INCLUDE[preset];
  if (!txt) return { ...base, status: 'unknown', detail: UNREACHABLE, records: [] };
  const records = txt.filter(isSpf);
  if (!records.length)
    return {
      ...base,
      status: 'fail',
      detail: `${domain} has no SPF record, so receivers can't tell which servers may send its mail and are more likely to mark it as spam.`,
      fix: include
        ? `Add a TXT record at ${domain}: v=spf1 include:${include} ~all`
        : `Add a TXT record at ${domain} with the SPF value your mail provider recommends, such as v=spf1 mx ~all.`,
      records: [],
    };
  if (records.length > 1)
    return {
      ...base,
      status: 'fail',
      detail: `${domain} has ${records.length} SPF records. Receivers treat that as an error and ignore all of them.`,
      fix: `Replace them with a single TXT record: ${mergeSpf(records)}`,
      records,
    };

  const record = records[0],
    terms = spfTerms(record),
    live = liveSpfTerms(record),
    issues: { status: CheckStatus; text: string }[] = [],
    fixes: string[] = [];
  const top = live.filter(t => SPF_LOOKUPS.has(spfTerm(t).name)).length;
  const walk: SpfWalk = {
    lookups: 0,
    includes: new Set(
      live
        .map(spfTerm)
        .filter(t => t.name === 'include' || t.name === 'redirect')
        .map(t => t.value.toLowerCase()),
    ),
    broken: [],
    partial: false,
  };
  if (top <= 10) await walkSpf(record, walk, dns, 0);
  else walk.lookups = top;
  if (walk.lookups > 10) {
    issues.push({
      status: 'fail',
      text: `It needs more than 10 DNS lookups${top > 10 ? '' : ' once its includes are followed'}, which is SPF's limit, so receivers reject it as broken.`,
    });
    fixes.push(
      'Remove includes for services you no longer use, or replace a:/mx: entries with ip4:/ip6: addresses.',
    );
  }
  if (walk.broken.length)
    issues.push({
      status: 'warn',
      text: `These includes don't have exactly one SPF record of their own: ${walk.broken.join(', ')}. Receivers may treat the record as broken.`,
    });

  const all = terms.find(isAll),
    allTerm = all ? spfTerm(all) : undefined,
    redirect = terms.some(t => spfTerm(t).name === 'redirect');
  if (allTerm?.qualifier === '+') {
    issues.push({
      status: 'warn',
      text: `It ends with ${all}, which lets any server in the world send mail as ${domain}.`,
    });
    fixes.push(`Change ${all} to ~all (or -all once you're sure every sender is listed).`);
  } else if (allTerm?.qualifier === '?') {
    issues.push({
      status: 'warn',
      text: 'It ends with ?all, which tells receivers nothing about unlisted servers.',
    });
    fixes.push("Change ?all to ~all (or -all once you're sure every sender is listed).");
  } else if (!allTerm && !redirect) {
    issues.push({
      status: 'warn',
      text: "It doesn't end with ~all or -all, so receivers treat unlisted servers as neutral.",
    });
    fixes.push('Add ~all to the end of the record.');
  }

  if (include && !walk.includes.has(include) && !walk.partial) {
    issues.push({
      status: 'warn',
      text: `It doesn't include ${PRESETS[preset as HostedPreset].name} (include:${include}), so mail you send through ${PRESETS[preset as HostedPreset].name} may fail SPF.`,
    });
    fixes.push(`Change the TXT record to: ${withInclude(record, include)}`);
  }
  const status = worst(issues.map(i => i.status));
  const summary =
    status === 'pass'
      ? `One SPF record${allTerm ? ` ending in ${all}` : ''}, using ${walk.lookups} of 10 DNS lookups${walk.partial ? ' (some includes could not be checked)' : ''}.`
      : issues.map(i => i.text).join(' ');
  return {
    ...base,
    status,
    detail: summary,
    ...(fixes.length ? { fix: fixes.join(' ') } : {}),
    records,
  };
}

const GENERIC_SELECTORS = [
  'default',
  'selector1',
  'selector2',
  'google',
  'k1',
  's1',
  's2',
  'dkim',
  'mail',
];
const DKIM_SELECTORS: Partial<Record<AccountPreset, string[]>> = {
  gmail: ['google'],
  outlook: ['selector1', 'selector2'],
  icloud: ['sig1'],
  fastmail: ['fm1', 'fm2', 'fm3'],
};
const DKIM_TARGET: Partial<Record<AccountPreset, RegExp>> = {
  outlook: /(\.onmicrosoft\.com|\.dkim\.mail\.microsoft)$/,
  icloud: /\.icloudmailadmin\.com$/,
  fastmail: /\.dkim\.fmhosted\.com$/,
};

function dkimFix(domain: string, preset: AccountPreset): string {
  switch (preset) {
    case 'gmail':
      return `In the Google Admin console, open Apps > Google Workspace > Gmail > Authenticate email, generate a key, publish it as a TXT record at google._domainkey.${domain}, then click Start authentication.`;
    case 'outlook':
      return 'In the Microsoft Defender portal, open Email & collaboration > Policies & rules > Threat policies > Email authentication settings > DKIM, add the two CNAME records it shows for selector1._domainkey and selector2._domainkey, then turn on signing.';
    case 'icloud':
      return `Add a CNAME record at sig1._domainkey.${domain} pointing to sig1.dkim.${domain}.at.icloudmailadmin.com.`;
    case 'fastmail':
      return `Add CNAME records at fm1._domainkey.${domain}, fm2._domainkey.${domain} and fm3._domainkey.${domain} pointing to fm1.${domain}.dkim.fmhosted.com, fm2.${domain}.dkim.fmhosted.com and fm3.${domain}.dkim.fmhosted.com.`;
    default:
      return "Turn on DKIM signing in your mail provider's admin settings and publish the record it gives you.";
  }
}

async function dkimCheck(
  domain: string,
  preset: AccountPreset,
  dns: (name: string, type: DnsType) => Promise<string[] | undefined>,
): Promise<DomainCheck> {
  const base = { id: 'dkim' as const, title: 'Message signing (DKIM)' },
    selectors = DKIM_SELECTORS[preset] ?? GENERIC_SELECTORS,
    target = DKIM_TARGET[preset];
  const probes = await Promise.all(
    selectors.map(async selector => {
      const name = `${selector}._domainkey.${domain}`,
        [txt, cname] = await Promise.all([dns(name, 'TXT'), dns(name, 'CNAME')]);
      const keys = (txt ?? []).filter(r => /(^|;)\s*(v\s*=\s*DKIM1|p\s*=)/i.test(r));
      return {
        selector,
        failed: !txt && !cname,
        keys,
        cname: cname?.[0],
        revoked: keys.some(k => (parseTags(k).p ?? '').replace(/\s+/g, '') === ''),
      };
    }),
  );
  const records = probes.flatMap(p => [
    ...(p.cname ? [`${p.selector}._domainkey CNAME ${p.cname}`] : []),
    ...p.keys.map(
      k => `${p.selector}._domainkey TXT ${k.length > 80 ? `${k.slice(0, 77)}...` : k}`,
    ),
  ]);
  // A CNAME to the host does not make a selector good when the key it leads to is revoked.
  const good = probes.filter(
    p => !p.revoked && (p.keys.length || (p.cname && target?.test(p.cname))),
  );
  const revoked = probes.filter(p => p.revoked);
  const label = (list: typeof probes) => list.map(p => `${p.selector}._domainkey`).join(', ');
  if (good.length) {
    const via =
      good[0].cname && target?.test(good[0].cname)
        ? ` (it points to ${PRESETS[preset as HostedPreset].name})`
        : '';
    const note = revoked.length
      ? ` The key at ${label(revoked)} is empty, which means it was revoked; remove it if nothing uses it.`
      : '';
    return {
      ...base,
      status: 'pass',
      detail: `Found a DKIM key at ${label(good)}${via}.${note}`,
      records,
    };
  }
  if (revoked.length)
    return {
      ...base,
      status: 'fail',
      detail: `The DKIM key at ${label(revoked)} is empty (p=), which means it was revoked. Mail signed with it fails DKIM.`,
      fix: dkimFix(domain, preset),
      records,
    };
  const dangling = probes.filter(p => p.cname);
  if (dangling.length)
    return {
      ...base,
      status: 'warn',
      detail: `${label(dangling)} points to ${dangling[0].cname}, but no DKIM key is published there.`,
      fix: dkimFix(domain, preset),
      records,
    };
  if (probes.some(p => p.failed))
    return { ...base, status: 'unknown', detail: UNREACHABLE, records };
  return {
    ...base,
    status: 'warn',
    detail: `No DKIM key was found at the usual names (${selectors.join(', ')}). DNS can't list every name a key might use, so your provider may use a different one; its admin settings will show it.`,
    fix: dkimFix(domain, preset),
    records,
  };
}

function dmarcCheck(domain: string, txt: string[] | undefined): DomainCheck {
  const base = { id: 'dmarc' as const, title: 'Spoofing policy (DMARC)' };
  if (!txt) return { ...base, status: 'unknown', detail: UNREACHABLE, records: [] };
  const records = txt.filter(r => /^v\s*=\s*DMARC1\s*(;|$)/i.test(r.trim()));
  const suggested = `v=DMARC1; p=none; rua=mailto:dmarc-reports@${domain}`;
  if (!records.length)
    return {
      ...base,
      status: 'fail',
      detail: `${domain} has no DMARC record, so receivers have no instructions for mail that pretends to come from it. Gmail and Yahoo expect one from regular senders.`,
      fix: `Add a TXT record at _dmarc.${domain}: ${suggested}. Once the reports show your own mail passing, change p=none to p=quarantine.`,
      records: [],
    };
  if (records.length > 1)
    return {
      ...base,
      status: 'fail',
      detail: `_dmarc.${domain} has ${records.length} DMARC records. Receivers ignore all of them when there is more than one.`,
      fix: 'Delete all but one DMARC record.',
      records,
    };
  const tags = parseTags(records[0]),
    policy = tags.p?.toLowerCase(),
    pct = tags.pct === undefined ? 100 : Number(tags.pct);
  const reports = tags.rua
    ? ` Reports go to ${tags.rua.replace(/mailto:/gi, '')}.`
    : ' It has no rua= address, so nobody receives reports about mail sent as your domain.';
  const partial = pct < 100 ? ` It applies to only ${pct}% of failing mail.` : '';
  const POLICIES = ['none', 'quarantine', 'reject'],
    dupes = duplicateTags(records[0]),
    problems: string[] = [];
  if (dupes.length) problems.push(`it repeats ${dupes.map(t => `${t}=`).join(', ')}`);
  if (!policy || !POLICIES.includes(policy))
    problems.push('it has no valid p= policy (none, quarantine or reject)');
  if (tags.sp !== undefined && !POLICIES.includes(tags.sp.toLowerCase()))
    problems.push(`sp=${tags.sp} is not none, quarantine or reject`);
  if (tags.pct !== undefined && !(/^\d{1,3}$/.test(tags.pct) && pct <= 100))
    problems.push(`pct=${tags.pct} is not a whole number from 0 to 100`);
  if (problems.length)
    return {
      ...base,
      status: 'fail',
      detail: `The DMARC record is invalid: ${problems.join('; ')}. Receivers may ignore it.`,
      fix: `Change the record so each tag appears once with a valid value, such as: ${policy && POLICIES.includes(policy) ? `v=DMARC1; p=${policy}${tags.rua ? `; rua=${tags.rua}` : ''}` : suggested}`,
      records,
    };
  if (policy === 'none')
    return {
      ...base,
      status: 'warn',
      detail: `The policy is p=none, which only monitors: mail pretending to be from ${domain} is still delivered.${reports}`,
      fix: 'Once reports show your own mail passing, change p=none to p=quarantine (and later p=reject).',
      records,
    };
  return {
    ...base,
    status: 'pass',
    detail: `Mail that fails the checks is ${policy === 'reject' ? 'rejected' : 'sent to spam'}.${partial}${reports}`,
    records,
  };
}

function mtaStsCheck(domain: string, txt: string[] | undefined): DomainCheck {
  const base = { id: 'mta-sts' as const, title: 'Encrypted delivery (MTA-STS, optional)' };
  if (!txt) return { ...base, status: 'unknown', detail: UNREACHABLE, records: [] };
  const records = txt.filter(r => /^v\s*=\s*STSv1\s*(;|$)/i.test(r.trim()));
  if (records.length === 1)
    return {
      ...base,
      status: 'pass',
      detail:
        'MTA-STS is published, so other servers know to always use encryption when delivering to you.',
      records,
    };
  if (records.length > 1)
    return {
      ...base,
      status: 'warn',
      detail: `_mta-sts.${domain} has ${records.length} records; there should be exactly one.`,
      fix: 'Delete all but one MTA-STS record.',
      records,
    };
  return {
    ...base,
    status: 'warn',
    detail:
      'Optional and low priority. MTA-STS tells other servers to always use encryption when delivering to you; most domains do without it.',
    fix: `Publish a policy at https://mta-sts.${domain}/.well-known/mta-sts.txt and a TXT record at _mta-sts.${domain}: v=STSv1; id=1 (change the id whenever the policy changes).`,
    records: [],
  };
}

/** Checks the DNS records that decide whether a custom domain's mail is delivered and trusted. */
export async function checkDomain(
  input: string,
  options: CheckDomainOptions = {},
): Promise<DomainReport> {
  const domain = normalizeDomain(
    String(input ?? '')
      .trim()
      .replace(/^.*@/, ''),
  );
  if (!domain) throw new Error('Enter a domain name, like example.com.');
  const dnsOptions: DnsOptions = { fetch: options.fetch, signal: options.signal };
  const dns = (name: string, type: DnsType) => resolveDns(name, type, dnsOptions);
  const mx = await dns(domain, 'MX'),
    detected = mx?.map(mxPreset).find(Boolean),
    preset = choosePreset(options.provider, detected);
  const [txt, dmarc, sts, dkim] = await Promise.all([
    dns(domain, 'TXT'),
    dns(`_dmarc.${domain}`, 'TXT'),
    dns(`_mta-sts.${domain}`, 'TXT'),
    dkimCheck(domain, preset, dns),
  ]);
  const provider =
    preset !== 'generic' ? PRESETS[preset].provider : (options.provider ?? 'unknown');
  return {
    domain,
    provider,
    preset,
    checks: [
      mxCheck(domain, mx, detected, preset),
      await spfCheck(domain, txt, preset, dns),
      dkim,
      dmarcCheck(domain, dmarc),
      mtaStsCheck(domain, sts),
    ],
  };
}
