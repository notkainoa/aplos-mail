import type { ImageRefusal, ProxiedImage } from '@aplos/engine/ports';
import {
  createImageProxy,
  type Connector,
  type ImageProxyOptions,
  type UpstreamResponse,
} from '../../src/host/proxy/fetch';
import type { PinnedTarget, Resolver } from '../../src/host/proxy/resolve';

/** Shared by the SSRF and hardening tests: original image headers, a fake DNS, a fake connector and a proxy over them. */

export const PUBLIC = '93.184.216.34';

// --- Original image headers, just enough bytes for each format's dimensions -----------------------------------------

export function bytes(...parts: (number[] | string | Uint8Array)[]): Uint8Array {
  const flat = parts.flatMap(part =>
    typeof part === 'string' ? [...part].map(c => c.charCodeAt(0)) : [...part],
  );
  return Uint8Array.from(flat);
}

export const u16le = (n: number) => [n & 255, (n >>> 8) & 255];
export const u16be = (n: number) => [(n >>> 8) & 255, n & 255];
export const u24le = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255];
export const u32le = (n: number) => [...u16le(n & 0xffff), ...u16le(n >>> 16)];
export const u32be = (n: number) => [...u16be(n >>> 16), ...u16be(n & 0xffff)];

export function png(width: number, height: number): Uint8Array {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return bytes(
    signature,
    u32be(13),
    'IHDR',
    u32be(width),
    u32be(height),
    [8, 6, 0, 0, 0],
    [0, 0, 0, 0],
  );
}

export function jpeg(width: number, height: number, { noFrame = false } = {}): Uint8Array {
  const app0 = bytes([0xff, 0xe0], u16be(16), 'JFIF\0', [1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const sof0 = bytes(
    [0xff, 0xc0],
    u16be(17),
    [8],
    u16be(height),
    u16be(width),
    [3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1],
  );
  const sos = bytes([0xff, 0xda], u16be(12), [3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0]);
  return bytes([0xff, 0xd8], app0, noFrame ? [] : sof0, sos, [0, 0, 0xff, 0xd9]);
}

export function gif(width: number, height: number): Uint8Array {
  return bytes('GIF89a', u16le(width), u16le(height), [0, 0, 0], [0x3b]);
}

export function riff(chunk: string, payload: Uint8Array): Uint8Array {
  return bytes('RIFF', u32le(payload.length + 12), 'WEBP', chunk, u32le(payload.length), payload);
}

export function webpVp8(width: number, height: number): Uint8Array {
  return riff('VP8 ', bytes([0x10, 0x02, 0], [0x9d, 0x01, 0x2a], u16le(width), u16le(height)));
}

export function webpVp8l(width: number, height: number): Uint8Array {
  const bits = ((width - 1) | ((height - 1) << 14)) >>> 0;
  return riff('VP8L', bytes([0x2f], u32le(bits), [0, 0, 0]));
}

export function webpVp8x(width: number, height: number): Uint8Array {
  return riff('VP8X', bytes([0, 0, 0, 0], u24le(width - 1), u24le(height - 1)));
}

export function svg(): Uint8Array {
  return bytes(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><script>1</script></svg>',
  );
}

/** A fake DNS: names map to answers; anything else fails like ENOTFOUND. Every call is recorded. */
export function dns(table: Record<string, string[]>) {
  const calls: string[] = [];
  const resolve: Resolver = async host => {
    calls.push(host);
    const answers = table[host];
    if (!answers) throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
    return answers.map(address => ({ address, family: address.includes(':') ? 6 : 4 }));
  };
  return { resolve, calls };
}

export const NAMES = {
  'img.example': [PUBLIC],
  'img.example.': [PUBLIC],
  'cdn.example': ['1.1.1.1'],
  'v6.example': ['2606:4700::1111'],
  'metadata.google.internal': ['169.254.169.254'],
  'metadata.example': ['169.254.169.254'],
  'mixed.example': [PUBLIC, '10.0.0.1'],
  'mixed6.example': ['2606:4700::1111', 'fd00::1'],
  'mapped.example': ['::ffff:127.0.0.1'],
  'nat64.example': ['64:ff9b::a9fe:a9fe'],
  'empty.example': [],
  'private.example': ['192.168.1.20'],
};

export function chunks(body: Uint8Array | Uint8Array[]): AsyncIterable<Uint8Array> {
  const list = Array.isArray(body) ? body : [body];
  return (async function* () {
    yield* list;
  })();
}

export function reply(
  status: number,
  body: Uint8Array | Uint8Array[] = new Uint8Array(),
  extra: Partial<UpstreamResponse> = {},
): UpstreamResponse {
  return { status, body: chunks(body), close: () => undefined, ...extra };
}

export const redirect = (location: string) => reply(302, new Uint8Array(), { location });

/** A fake connector: every call records its pinned target and gets the handler's answer. */
export function upstream(handler: (target: PinnedTarget, n: number) => UpstreamResponse) {
  const targets: PinnedTarget[] = [];
  const connect: Connector = async target => {
    targets.push(target);
    return handler(target, targets.length);
  };
  return { connect, targets };
}

export function proxyWith(
  handler: (target: PinnedTarget, n: number) => UpstreamResponse,
  extra: ImageProxyOptions = {},
) {
  const resolver = dns(NAMES);
  const server = upstream(handler);
  const proxy = createImageProxy({ resolve: resolver.resolve, connect: server.connect, ...extra });
  return { proxy, resolver, server };
}

export const run = (signal = new AbortController().signal) => ({ token: 't1', signal });
export const refusedAs = (reason: ImageRefusal): ProxiedImage => ({ kind: 'refused', reason });
