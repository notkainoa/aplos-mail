/**
 * The SSRF classifier: decides whether one IP address may be connected to. Allowlist first: IPv4 must sit outside
 * every IANA special-purpose block (RFC 6890 and its updates); IPv6 must be global unicast (2000::/3) outside the
 * special-purpose blocks, or a mapped or NAT64 form of an allowed IPv4 address. Anything unparseable is refused.
 */

export type AddressVerdict =
  { allowed: true; address: string; family: 4 | 6 } | { allowed: false; address: string };

type Block = readonly [prefix: string, bits: number];

/** Every IPv4 special-purpose block, globally reachable or not: none of them hosts a sender's images. */
const REFUSED_V4: readonly Block[] = [
  ['0.0.0.0', 8], // "this network", unspecified
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // CGNAT shared space
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.31.196.0', 24], // AS112-v4
  ['192.52.193.0', 24], // AMT
  ['192.88.99.0', 24], // deprecated 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['192.175.48.0', 24], // direct delegation AS112
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, limited broadcast 255.255.255.255
];

/** Special-purpose blocks inside 2000::/3. Everything outside 2000::/3 is refused before these are consulted. */
const REFUSED_V6_GLOBAL: readonly Block[] = [
  ['2001::', 23], // IETF protocol assignments: Teredo, benchmarking, ORCHID, AMT, AS112, DRIP
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4, deprecated; may embed any IPv4 address
  ['3fff::', 20], // documentation
  ['5f00::', 16], // SRv6 SIDs
];

const MAPPED: Block = ['::ffff:0:0', 96];
const NAT64: Block = ['64:ff9b::', 96];
const GLOBAL_UNICAST: Block = ['2000::', 3];

const DECIMAL_OCTET = /^(0|[1-9][0-9]{0,2})$/;

/** A strict dotted quad (no octal, hex, short or decimal forms) as a 32-bit number, or null. */
export function ipv4Number(text: string): number | null {
  const parts = text.split('.');
  if (parts.length !== 4 || !parts.every(part => DECIMAL_OCTET.test(part))) return null;
  const octets = parts.map(Number);
  if (octets.some(octet => octet > 255)) return null;
  return octets.reduce((value, octet) => value * 256 + octet, 0);
}

function ipv4Text(value: number): string {
  return [24, 16, 8, 0].map(shift => (value >>> shift) & 255).join('.');
}

/** Rewrites a dotted IPv4 tail (`::ffff:1.2.3.4`) as two hex groups, or null when the tail is not a dotted quad. */
function hexTail(text: string): string | null {
  const cut = text.lastIndexOf(':');
  const tail = text.slice(cut + 1);
  if (!tail.includes('.')) return text;
  const value = ipv4Number(tail);
  if (value === null) return null;
  return `${text.slice(0, cut + 1)}${(value >>> 16).toString(16)}:${(value & 0xffff).toString(16)}`;
}

const HEX_GROUP = /^[0-9a-f]{1,4}$/;

function groups(text: string): string[] {
  return text ? text.split(':') : [];
}

/** An IPv6 address (no brackets, no zone id) as a 128-bit integer, or null. */
export function ipv6Number(input: string): bigint | null {
  const text = hexTail(input.toLowerCase());
  if (text === null || text.includes('%')) return null;
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = groups(halves[0]);
  const tail = halves.length === 2 ? groups(halves[1]) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const all = [...head, ...Array<string>(missing).fill('0'), ...tail];
  if (!all.every(group => HEX_GROUP.test(group))) return null;
  return all.reduce((value, group) => (value << 16n) | BigInt(parseInt(group, 16)), 0n);
}

function inV4Block(value: number, [prefix, bits]: Block): boolean {
  const base = ipv4Number(prefix) as number;
  const size = 2 ** (32 - bits);
  return Math.floor(value / size) === Math.floor(base / size);
}

function inV6Block(value: bigint, [prefix, bits]: Block): boolean {
  const shift = BigInt(128 - bits);
  return value >> shift === (ipv6Number(prefix) as bigint) >> shift;
}

function v4Allowed(value: number): boolean {
  return !REFUSED_V4.some(block => inV4Block(value, block));
}

function embeddedV4(value: bigint): number {
  return Number(value & 0xffffffffn);
}

function classifyV4(text: string, value: number): AddressVerdict {
  return v4Allowed(value) ? { allowed: true, address: ipv4Text(value), family: 4 } : refuse(text);
}

function classifyV6(text: string, value: bigint): AddressVerdict {
  // A mapped address is the IPv4 host itself, so connect to that host over IPv4.
  if (inV6Block(value, MAPPED)) return classifyV4(text, embeddedV4(value));
  if (inV6Block(value, NAT64))
    return v4Allowed(embeddedV4(value))
      ? { allowed: true, address: text.toLowerCase(), family: 6 }
      : refuse(text);
  if (!inV6Block(value, GLOBAL_UNICAST)) return refuse(text);
  if (REFUSED_V6_GLOBAL.some(block => inV6Block(value, block))) return refuse(text);
  return { allowed: true, address: text.toLowerCase(), family: 6 };
}

function refuse(address: string): AddressVerdict {
  return { allowed: false, address };
}

/** Classifies one address as a resolver or URL gives it: a dotted quad, or IPv6 with or without brackets. */
export function classifyAddress(address: string): AddressVerdict {
  const bare = address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address;
  const v4 = ipv4Number(bare);
  if (v4 !== null) return classifyV4(address, v4);
  const v6 = bare.includes(':') ? ipv6Number(bare) : null;
  if (v6 !== null) return classifyV6(bare, v6);
  return refuse(address);
}
