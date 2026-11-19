import test from 'node:test';
import assert from 'node:assert/strict';
import { IMAGE_PROXY_LIMITS } from '@aplos/engine/ports';
import type { ImageRefusal } from '@aplos/engine/ports';
import { classifyAddress } from '../../src/host/proxy/classify';
import {
  createImageProxy,
  type Connector,
  type UpstreamResponse,
} from '../../src/host/proxy/fetch';
import {
  parseTarget,
  pinTarget,
  type PinnedTarget,
  type Resolver,
} from '../../src/host/proxy/resolve';
import {
  MAX_IN_FLIGHT,
  PER_TOKEN_BYTES,
  proxyLimits,
  tokenBudget,
  TRACKED_TOKENS,
} from '../../src/host/proxy/limits';
import {
  dns,
  NAMES,
  png,
  jpeg,
  gif,
  webpVp8,
  webpVp8l,
  webpVp8x,
  svg,
  reply,
  redirect,
  upstream,
  proxyWith,
  run,
  refusedAs,
  PUBLIC,
} from './proxy-fixtures';

// --- The classifier ---------------------------------------------------------------------------------------------

const REFUSED_ADDRESSES: [string, string][] = [
  ['loopback v4', '127.0.0.1'],
  ['loopback v4, top of /8', '127.255.255.254'],
  ['loopback v6', '::1'],
  ['loopback v6, bracketed', '[::1]'],
  ['private 10/8', '10.0.0.1'],
  ['private 172.16/12', '172.16.0.1'],
  ['private 172.16/12, top', '172.31.255.255'],
  ['private 192.168/16', '192.168.1.1'],
  ['ULA fc00::/7', 'fc00::1'],
  ['ULA fd00::/8', 'fd12:3456::1'],
  ['link-local v4', '169.254.0.1'],
  ['cloud metadata', '169.254.169.254'],
  ['link-local v6', 'fe80::1'],
  ['link-local v6, top of /10', 'febf::1'],
  ['site-local v6 (deprecated)', 'fec0::1'],
  ['CGNAT 100.64/10', '100.64.0.1'],
  ['CGNAT 100.64/10, top', '100.127.255.255'],
  ['multicast v4', '224.0.0.1'],
  ['multicast v4, SSDP', '239.255.255.250'],
  ['multicast v6', 'ff02::1'],
  ['multicast v6, global scope', 'ff0e::1'],
  ['unspecified v4', '0.0.0.0'],
  ['this network 0/8', '0.1.2.3'],
  ['unspecified v6', '::'],
  ['benchmarking 198.18/15', '198.18.0.1'],
  ['benchmarking 198.18/15, top', '198.19.255.255'],
  ['benchmarking v6 2001:2::/48', '2001:2::1'],
  ['IETF protocol assignments 192.0.0/24', '192.0.0.170'],
  ['TEST-NET-1', '192.0.2.1'],
  ['TEST-NET-2', '198.51.100.1'],
  ['TEST-NET-3', '203.0.113.1'],
  ['6to4 relay anycast', '192.88.99.1'],
  ['AS112', '192.31.196.1'],
  ['AS112, top of /24', '192.31.196.255'],
  ['AMT 192.52.193/24', '192.52.193.1'],
  ['AMT 192.52.193/24, bottom', '192.52.193.0'],
  ['direct delegation AS112 192.175.48/24', '192.175.48.1'],
  ['direct delegation AS112 192.175.48/24, top', '192.175.48.255'],
  ['mapped AMT', '::ffff:192.52.193.1'],
  ['mapped direct delegation AS112', '::ffff:192.175.48.1'],
  ['reserved 240/4', '240.0.0.1'],
  ['limited broadcast', '255.255.255.255'],
  ['documentation v6', '2001:db8::1'],
  ['documentation v6 3fff::/20', '3fff::1'],
  ['discard-only 100::/64', '100::1'],
  ['Teredo 2001::/32', '2001:0:4136:e378:8000:63bf:3fff:fdd2'],
  ['ORCHIDv2', '2001:20::1'],
  ['IETF protocol assignments 2001::/23', '2001:1::1'],
  ['local-use NAT64 64:ff9b:1::/48', '64:ff9b:1::7f00:1'],
  ['6to4 embedding loopback', '2002:7f00:1::'],
  ['6to4 embedding private', '2002:c0a8:101::1'],
  ['6to4 embedding a public address (6to4 is refused outright)', '2002:808:808::1'],
  ['SRv6 SIDs', '5f00::1'],
  ['mapped loopback, dotted', '::ffff:127.0.0.1'],
  ['mapped loopback, hex', '::ffff:7f00:1'],
  ['mapped loopback, upper case', '::FFFF:7F00:1'],
  ['mapped loopback, bracketed', '[::ffff:7f00:1]'],
  ['mapped loopback, full form', '0:0:0:0:0:ffff:7f00:1'],
  ['mapped private', '::ffff:10.0.0.1'],
  ['mapped metadata', '::ffff:169.254.169.254'],
  ['mapped CGNAT', '::ffff:100.64.0.1'],
  ['compatible loopback, dotted', '::127.0.0.1'],
  ['compatible loopback, hex', '::7f00:1'],
  ['compatible public (deprecated form, refused outright)', '::8.8.8.8'],
  ['IPv4-translated', '::ffff:0:7f00:1'],
  ['NAT64 loopback, hex', '64:ff9b::7f00:1'],
  ['NAT64 loopback, dotted', '64:ff9b::127.0.0.1'],
  ['NAT64 metadata', '64:ff9b::a9fe:a9fe'],
  ['NAT64 private', '64:ff9b::a00:1'],
  ['NAT64 benchmarking', '64:ff9b::c612:1'],
  ['zone id on link-local', 'fe80::1%en0'],
  ['zone id on a global address', '2606:4700::1111%en0'],
  ['upper-case link-local', 'FE80::1'],
  ['a name', 'localhost'],
  ['empty', ''],
  ['octal form', '0177.0.0.1'],
  ['hex form', '0x7f.0.0.1'],
  ['decimal form', '2130706433'],
  ['short form', '127.1'],
  ['three parts', '1.2.3'],
  ['leading zero', '01.2.3.4'],
  ['octet over 255', '1.2.3.256'],
  ['triple colon', ':::1'],
  ['two double colons', '1::2::3'],
  ['nine groups', '1:2:3:4:5:6:7:8:9'],
  ['dangling double colon', '2606:4700::1111::'],
  ['five-digit group', '2606:47000::1'],
];

for (const [label, address] of REFUSED_ADDRESSES)
  test(`classifier refuses ${label}: ${JSON.stringify(address)}`, () => {
    assert.equal(classifyAddress(address).allowed, false);
  });

const ALLOWED_ADDRESSES: [string, string, 4 | 6][] = [
  ['8.8.8.8', '8.8.8.8', 4],
  ['1.1.1.1', '1.1.1.1', 4],
  [PUBLIC, PUBLIC, 4],
  ['11.0.0.1', '11.0.0.1', 4],
  ['100.128.0.1', '100.128.0.1', 4],
  ['169.255.0.1', '169.255.0.1', 4],
  ['172.32.0.1', '172.32.0.1', 4],
  ['192.169.0.1', '192.169.0.1', 4],
  ['198.20.0.1', '198.20.0.1', 4],
  ['192.52.192.255', '192.52.192.255', 4],
  ['192.52.194.0', '192.52.194.0', 4],
  ['192.175.47.255', '192.175.47.255', 4],
  ['192.175.49.0', '192.175.49.0', 4],
  ['223.255.255.254', '223.255.255.254', 4],
  ['2606:4700::1111', '2606:4700::1111', 6],
  ['[2606:4700::1111]', '2606:4700::1111', 6],
  ['2001:4860:4860::8888', '2001:4860:4860::8888', 6],
  ['2001:200::1', '2001:200::1', 6],
  ['::ffff:8.8.8.8', '8.8.8.8', 4],
  ['::ffff:808:808', '8.8.8.8', 4],
  ['64:ff9b::808:808', '64:ff9b::808:808', 6],
];

for (const [address, connectTo, family] of ALLOWED_ADDRESSES)
  test(`classifier allows public ${address}`, () => {
    assert.deepEqual(classifyAddress(address), { allowed: true, address: connectTo, family });
  });

// --- URLs: scheme, credentials, port and host, before any connection ---------------------------------------------

const REFUSED_URLS: [string, ImageRefusal][] = [
  ['http://127.0.0.1/a.png', 'address'],
  ['http://2130706433/', 'address'],
  ['http://0177.0.0.1/', 'address'],
  ['http://0x7f.0.0.1/', 'address'],
  ['http://0x7f000001/', 'address'],
  ['http://127.1/', 'address'],
  ['http://127.0.0.1./', 'address'],
  ['http://%31%32%37.0.0.1/', 'address'],
  ['http://0/', 'address'],
  ['http://0.0.0.0/', 'address'],
  ['http://[::]/', 'address'],
  ['http://[::1]/', 'address'],
  ['http://[0:0:0:0:0:0:0:1]/', 'address'],
  ['http://[::ffff:127.0.0.1]/', 'address'],
  ['http://[::ffff:7f00:1]/', 'address'],
  ['http://[::127.0.0.1]/', 'address'],
  ['http://[64:ff9b::7f00:1]/', 'address'],
  ['http://[64:ff9b::127.0.0.1]/', 'address'],
  ['http://[2002:7f00:1::]/', 'address'],
  ['http://169.254.169.254/latest/meta-data/', 'address'],
  ['http://10.0.0.1/', 'address'],
  ['http://172.16.0.1/', 'address'],
  ['http://192.168.0.1/', 'address'],
  ['http://100.64.0.1/', 'address'],
  ['http://198.18.0.1/', 'address'],
  ['http://224.0.0.1/', 'address'],
  ['http://255.255.255.255/', 'address'],
  ['http://[fc00::1]/', 'address'],
  ['http://[fe80::1]/', 'address'],
  ['http://[ff02::1]/', 'address'],
  ['http://[2001:db8::1]/', 'address'],
  ['HTTP://LOCALHOST/', 'address'],
  ['http://localhost./', 'address'],
  ['http://tracker.localhost/', 'address'],
  ['http://metadata.google.internal/computeMetadata/v1/', 'address'],
  ['http://intranet/', 'address'],
  ['http://intranet./', 'address'],
  ['http://printer.local/', 'address'],
  ['http://printer.local./', 'address'],
  ['http://nas.lan/', 'address'],
  ['http://service.internal/', 'address'],
  ['http://router.home.arpa/', 'address'],
  ['http://home.arpa/', 'address'],
  ['http://printer.local../', 'address'],
  ['http://intranet../', 'address'],
  ['http://a.internal.%2e/', 'address'],
  ['http://x.home.arpa../', 'address'],
  ['http://localhost../', 'address'],
  ['http://tracker.localhost../', 'address'],
  ['http://a..b.example/', 'address'],
  ['http://.example.com/', 'address'],
  ['http://img.example../', 'address'],
  ['http://img.example.%2E/', 'address'],
  ['http://LOCAL/', 'address'],
  ['http://mixed.example/', 'address'],
  ['http://mixed6.example/', 'address'],
  ['http://mapped.example/', 'address'],
  ['http://nat64.example/', 'address'],
  ['http://private.example/', 'address'],
  ['http://empty.example/', 'address'],
  ['http://a@img.example/', 'address'],
  ['http://a@127.0.0.1/', 'address'],
  ['http://user:pass@img.example/', 'address'],
  ['http://:pass@img.example/', 'address'],
  ['javascript:alert(1)', 'scheme'],
  ['data:image/png;base64,iVBORw0KGgo=', 'scheme'],
  ['file:///etc/passwd', 'scheme'],
  ['ftp://img.example/a.png', 'scheme'],
  ['ws://img.example/', 'scheme'],
  ['gopher://img.example:70/', 'scheme'],
  ['blob:https://img.example/0b8f', 'scheme'],
  ['//img.example/a.png', 'scheme'],
  ['not a url', 'scheme'],
  ['http://[fe80::1%25en0]/', 'scheme'],
  ['http://1.2.3.09/', 'scheme'],
  ['http://img.example:8080/', 'port'],
  ['https://img.example:8443/', 'port'],
  ['http://img.example:0/', 'port'],
  ['http://img.example:22/', 'port'],
  ['http://127.0.0.1:8080/', 'port'],
];

for (const [url, reason] of REFUSED_URLS)
  test(`url refused as ${reason}: ${url}`, async () => {
    const result = await pinTarget(url, IMAGE_PROXY_LIMITS.ports, dns(NAMES).resolve);
    assert.deepEqual(result, { ok: false, reason });
  });

test('one trailing root dot on an ordinary name is still accepted, and resolved without it', async () => {
  const resolver = dns({ 'example.com.': [PUBLIC] });
  const result = await pinTarget(
    'https://example.com./',
    IMAGE_PROXY_LIMITS.ports,
    resolver.resolve,
  );
  assert.ok(result.ok);
  assert.equal(result.target.servername, 'example.com');
  assert.equal(result.target.hostHeader, 'example.com.');
  assert.deepEqual(resolver.calls, ['example.com.']);
});

test('an https-only caller has http refused as scheme before anything is resolved', async () => {
  const resolver = dns(NAMES);
  const ports = IMAGE_PROXY_LIMITS.ports;
  const cases = [
    'http://img.example/',
    'http://8.8.8.8/',
    'http://img.example:443/',
    'ftp://img.example/',
  ];
  for (const url of cases)
    assert.deepEqual(await pinTarget(url, ports, resolver.resolve, undefined, ['https']), {
      ok: false,
      reason: 'scheme',
    });
  assert.deepEqual(resolver.calls, []);
  assert.equal(parseTarget('http://img.example/', ports, ['https']), 'scheme');
  const secure = await pinTarget('https://img.example/', ports, resolver.resolve, undefined, [
    'https',
  ]);
  assert.ok(secure.ok);
  assert.deepEqual(resolver.calls, ['img.example']);
  for (const url of ['http://img.example/', 'https://img.example/'])
    assert.ok((await pinTarget(url, ports, resolver.resolve)).ok, `${url} by default`);
  assert.equal(parseTarget('https://img.example/', ports, ['http']), 'scheme');
  assert.equal(parseTarget('https://img.example/', ports, []), 'scheme');
});

test('a URL is pinned to the checked address, with the original name kept for Host and SNI', async () => {
  const resolver = dns(NAMES);
  const result = await pinTarget(
    'http://IMG.example/a.png?x=1#frag',
    IMAGE_PROXY_LIMITS.ports,
    resolver.resolve,
  );
  assert.ok(result.ok);
  const { address, family, port, hostHeader, servername, path, secure } = result.target;
  assert.deepEqual(
    { address, family, port, hostHeader, servername, path, secure },
    {
      address: PUBLIC,
      family: 4,
      port: 80,
      hostHeader: 'img.example',
      servername: 'img.example',
      path: '/a.png?x=1',
      secure: false,
    },
  );
  assert.deepEqual(resolver.calls, ['img.example']);
});

const PINNED: [string, Partial<PinnedTarget>][] = [
  ['https://img.example:443/', { port: 443, hostHeader: 'img.example', secure: true }],
  ['http://img.example:443/', { port: 443, hostHeader: 'img.example:443', secure: false }],
  ['https://img.example./', { hostHeader: 'img.example.', servername: 'img.example' }],
  ['https://v6.example/', { address: '2606:4700::1111', family: 6, servername: 'v6.example' }],
  ['https://8.8.8.8/', { address: '8.8.8.8', hostHeader: '8.8.8.8', servername: undefined }],
  [
    'https://[2606:4700::1111]/',
    { address: '2606:4700::1111', hostHeader: '[2606:4700::1111]', servername: undefined },
  ],
  ['http://[::ffff:8.8.8.8]/', { address: '8.8.8.8', family: 4, servername: undefined }],
];

for (const [url, expected] of PINNED)
  test(`pinned target for ${url}`, async () => {
    const resolver = dns(NAMES);
    const result = await pinTarget(url, IMAGE_PROXY_LIMITS.ports, resolver.resolve);
    assert.ok(result.ok);
    for (const [key, value] of Object.entries(expected))
      assert.deepEqual(result.target[key as keyof PinnedTarget], value, key);
    if (!url.includes('.example')) assert.deepEqual(resolver.calls, [], 'IP literals skip DNS');
  });

// --- The proxy: DNS once, redirects, types, caps, budget, time ------------------------------------------------------

test('one lookup per hop: a rebinding resolver cannot swap the address after the check', async () => {
  let calls = 0;
  const rebinding: Resolver = async () => {
    calls += 1;
    return [{ address: calls === 1 ? PUBLIC : '127.0.0.1', family: 4 }];
  };
  const server = upstream(() => reply(200, png(2, 2)));
  const proxy = createImageProxy({ resolve: rebinding, connect: server.connect });
  const result = await proxy.fetch('https://rebind.example/a.png', run());
  assert.equal(result.kind, 'image');
  assert.equal(calls, 1);
  assert.equal(server.targets.length, 1);
  assert.equal(server.targets[0].address, PUBLIC);
  assert.equal(server.targets[0].servername, 'rebind.example');
});

test('a resolver answering public and private is refused without connecting', async () => {
  const { proxy, server } = proxyWith(() => reply(200, png(1, 1)));
  assert.deepEqual(await proxy.fetch('http://mixed.example/a.png', run()), refusedAs('address'));
  assert.equal(server.targets.length, 0);
});

test('a metadata-style name resolving to 169.254.169.254 is refused without connecting', async () => {
  const { proxy, server } = proxyWith(() => reply(200, png(1, 1)));
  const result = await proxy.fetch('http://metadata.example/', run());
  assert.deepEqual(result, refusedAs('address'));
  assert.equal(server.targets.length, 0);
});

test('each format with sane dimensions comes back as an image typed from its bytes', async () => {
  const bodies: [Uint8Array, string][] = [
    [png(640, 480), 'image/png'],
    [jpeg(640, 480), 'image/jpeg'],
    [gif(640, 480), 'image/gif'],
    [webpVp8(640, 480), 'image/webp'],
    [webpVp8l(640, 480), 'image/webp'],
    [webpVp8x(640, 480), 'image/webp'],
  ];
  for (const [body, mime] of bodies) {
    const { proxy } = proxyWith(() => reply(200, body, { contentLength: body.length }));
    const result = await proxy.fetch('https://img.example/a', run());
    assert.equal(result.kind, 'image', mime);
    assert.equal(result.kind === 'image' && result.mime, mime);
    assert.deepEqual(result.kind === 'image' && [...result.bytes], [...body]);
  }
});

const BAD_BODIES: [string, Uint8Array, ImageRefusal][] = [
  ['an SVG served as image/png', svg(), 'type'],
  ['HTML', new TextEncoder().encode('<!doctype html><title>x</title>'), 'type'],
  ['an empty body', new Uint8Array(), 'type'],
  ['a PNG signature alone', png(1, 1).subarray(0, 12), 'type'],
  ['a JPEG with no frame header', jpeg(0, 0, { noFrame: true }), 'type'],
  ['a zero-width PNG', png(0, 10), 'type'],
  ['a PNG declaring 100,000 x 100,000 pixels', png(100_000, 100_000), 'size'],
  ['a PNG one pixel over the cap', png(40_000_001, 1), 'size'],
  ['a JPEG declaring 65535 x 65535', jpeg(65535, 65535), 'size'],
  ['a GIF declaring 65535 x 65535', gif(65535, 65535), 'size'],
  ['a WebP declaring 16383 x 16383', webpVp8x(16383, 16383), 'size'],
];

for (const [label, body, reason] of BAD_BODIES)
  test(`${label} is refused as ${reason}`, async () => {
    const { proxy } = proxyWith(() => reply(200, body));
    assert.deepEqual(await proxy.fetch('https://img.example/a.png', run()), refusedAs(reason));
  });

test('a PNG exactly at the pixel cap is allowed', async () => {
  const { proxy } = proxyWith(() => reply(200, png(8000, 5000)));
  assert.equal((await proxy.fetch('https://img.example/a.png', run())).kind, 'image');
});

test('a declared Content-Length over the cap is refused before the body is read', async () => {
  let read = false;
  const body = (async function* () {
    read = true;
    yield png(1, 1);
  })();
  const { proxy } = proxyWith(() =>
    reply(200, [], { contentLength: IMAGE_PROXY_LIMITS.maxBytes + 1, body }),
  );
  assert.deepEqual(await proxy.fetch('https://img.example/a.png', run()), refusedAs('size'));
  assert.equal(read, false);
});

test('a body over the cap without Content-Length is cut off and refused while streaming', async () => {
  let sent = 0;
  const body = (async function* () {
    yield png(10, 10);
    for (;;) {
      sent += 1;
      yield new Uint8Array(400);
    }
  })();
  const { proxy } = proxyWith(() => reply(200, [], { body }), { limits: { maxBytes: 1000 } });
  assert.deepEqual(await proxy.fetch('https://img.example/a.png', run()), refusedAs('size'));
  assert.ok(sent <= 3, `stopped reading after ${sent} chunks`);
});

test('a non-image is refused after its leading bytes, without reading the rest', async () => {
  let sent = 0;
  const body = (async function* () {
    yield svg();
    for (;;) {
      sent += 1;
      yield new Uint8Array(1000);
    }
  })();
  const { proxy } = proxyWith(() => reply(200, [], { body }));
  assert.deepEqual(await proxy.fetch('https://img.example/a.svg', run()), refusedAs('type'));
  assert.equal(sent, 0);
});

test('the connection is always closed, whatever the outcome', async () => {
  let closed = 0;
  const close = () => void (closed += 1);
  const answers = [reply(200, png(1, 1)), reply(200, svg()), reply(404), redirect('/b')];
  for (const answer of answers) {
    const { proxy } = proxyWith(() => ({ ...answer, close }), { limits: { maxRedirects: 0 } });
    await proxy.fetch('https://img.example/a', run());
  }
  assert.equal(closed, answers.length);
});

test('three redirects are followed, each pinned again from scratch', async () => {
  const { proxy, resolver, server } = proxyWith((_target, n) =>
    n === 1
      ? redirect('https://cdn.example/b')
      : n === 2
        ? redirect('/c?d=1')
        : n === 3
          ? redirect('//img.example/e')
          : reply(200, png(3, 3)),
  );
  const result = await proxy.fetch('https://img.example/a', run());
  assert.equal(result.kind, 'image');
  assert.deepEqual(resolver.calls, ['img.example', 'cdn.example', 'cdn.example', 'img.example']);
  assert.deepEqual(
    server.targets.map(t => `${t.address} ${t.hostHeader}${t.path}`),
    [
      `${PUBLIC} img.example/a`,
      '1.1.1.1 cdn.example/b',
      '1.1.1.1 cdn.example/c?d=1',
      `${PUBLIC} img.example/e`,
    ],
  );
});

test('a fourth redirect is refused without making the fifth request', async () => {
  const { proxy, server } = proxyWith((_target, n) => redirect(`/hop${n}`));
  assert.deepEqual(await proxy.fetch('https://img.example/a', run()), refusedAs('redirects'));
  assert.equal(server.targets.length, 4);
});

const BAD_REDIRECTS: [string, string][] = [
  ['a private address', 'http://10.0.0.1/a.png'],
  ['loopback', 'http://127.0.0.1/'],
  ['loopback by decimal', 'http://2130706433/'],
  ['mapped loopback', 'http://[::ffff:127.0.0.1]/'],
  ['the metadata address', 'http://169.254.169.254/latest/meta-data/'],
  ['a name resolving to a private address', 'https://private.example/'],
  ['port 8080', 'http://img.example:8080/a.png'],
  ['port 8080 on loopback', 'http://127.0.0.1:8080/'],
  ['javascript:', 'javascript:alert(1)'],
  ['data:', 'data:image/png;base64,iVBORw0KGgo='],
  ['file:', 'file:///etc/passwd'],
  ['credentials', 'http://user:pass@img.example/'],
  ['an unparseable target', 'http://[::1/'],
];

for (const [label, location] of BAD_REDIRECTS)
  test(`a redirect to ${label} is refused as redirects`, async () => {
    const { proxy, server } = proxyWith(() => redirect(location));
    assert.deepEqual(await proxy.fetch('https://img.example/a', run()), refusedAs('redirects'));
    assert.equal(server.targets.length, 1, 'the refused target is never connected to');
  });

const HTTP_FAILURES: [string, () => UpstreamResponse][] = [
  ['404', () => reply(404, png(1, 1))],
  ['500', () => reply(500)],
  ['304', () => reply(304)],
  ['300 with a Location', () => reply(300, [], { location: '/b' })],
  ['302 without a Location', () => reply(302)],
  ['101', () => reply(101)],
  [
    'a body stream that fails',
    () =>
      reply(200, [], {
        body: (async function* () {
          yield png(1, 1).subarray(0, 4);
          throw new Error('socket hang up');
        })(),
      }),
  ],
];

for (const [label, answer] of HTTP_FAILURES)
  test(`${label} is refused as http`, async () => {
    const { proxy } = proxyWith(answer);
    assert.deepEqual(await proxy.fetch('https://img.example/a', run()), refusedAs('http'));
  });

test('a connection failure and a DNS failure are refused as http', async () => {
  const failing = createImageProxy({
    resolve: dns(NAMES).resolve,
    connect: async () => {
      throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
    },
  });
  assert.deepEqual(await failing.fetch('https://img.example/a', run()), refusedAs('http'));
  const { proxy } = proxyWith(() => reply(200, png(1, 1)));
  assert.deepEqual(await proxy.fetch('https://nowhere.example/a', run()), refusedAs('http'));
});

test('the 101st request on one token is refused as budget, and release starts it over', async () => {
  const { proxy, server } = proxyWith(() => reply(200, png(1, 1)));
  for (let i = 0; i < IMAGE_PROXY_LIMITS.perToken; i += 1)
    assert.equal((await proxy.fetch('https://img.example/a', run())).kind, 'image', `request ${i}`);
  assert.deepEqual(await proxy.fetch('https://img.example/a', run()), refusedAs('budget'));
  assert.equal(server.targets.length, IMAGE_PROXY_LIMITS.perToken);
  const other = { token: 't2', signal: new AbortController().signal };
  assert.equal((await proxy.fetch('https://img.example/a', other)).kind, 'image');
  proxy.release('t1');
  assert.equal((await proxy.fetch('https://img.example/a', run())).kind, 'image');
});

test('redirect hops spend the budget too', async () => {
  const hopThenImage = (target: PinnedTarget) =>
    target.path === '/a' ? redirect('/b') : reply(200, png(1, 1));
  const { proxy, server } = proxyWith(hopThenImage, { limits: { perToken: 3 } });
  assert.equal((await proxy.fetch('https://img.example/a', run())).kind, 'image');
  assert.deepEqual(await proxy.fetch('https://img.example/a', run()), refusedAs('budget'));
  assert.equal(server.targets.length, 3);
});

test('budgets track a bounded number of tokens, forgetting the oldest first', () => {
  const budget = tokenBudget({ perToken: 1, perTokenBytes: 10, maxTokens: 2 });
  assert.equal(budget.take('a'), true);
  assert.equal(budget.take('b'), true);
  assert.equal(budget.take('a'), false);
  assert.equal(budget.take('c'), true);
  assert.equal(budget.size(), 2);
  assert.equal(budget.take('b'), false, 'b is still tracked');
  assert.equal(budget.take('a'), true, 'a was the oldest and was forgotten');
  budget.release('a');
  budget.release('c');
  assert.equal(budget.size(), 0);
  const many = tokenBudget(proxyLimits());
  for (let i = 0; i < TRACKED_TOKENS * 4; i += 1) many.take(`token-${i}`);
  assert.equal(many.size(), TRACKED_TOKENS);
});

test('a fetch that outlives the time limit is refused as timeout', async () => {
  const stalled: Connector = (_target, signal) =>
    new Promise((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason)),
    );
  const proxy = createImageProxy({
    resolve: dns(NAMES).resolve,
    connect: stalled,
    limits: { timeoutMs: 50 },
  });
  const started = Date.now();
  assert.deepEqual(await proxy.fetch('https://img.example/a', run()), refusedAs('timeout'));
  assert.ok(Date.now() - started < 2000);
});

test('the time limit covers the whole chain, even a connector that ignores the signal', async () => {
  const deaf: Connector = () => new Promise(() => undefined);
  const slowDns: Resolver = () => new Promise(() => undefined);
  for (const options of [{ connect: deaf, resolve: dns(NAMES).resolve }, { resolve: slowDns }]) {
    const proxy = createImageProxy({ ...options, limits: { timeoutMs: 30 } });
    assert.deepEqual(await proxy.fetch('https://img.example/a', run()), refusedAs('timeout'));
  }
});

test('aborting rejects with the abort reason instead of resolving a refusal', async () => {
  const controller = new AbortController();
  const stalled: Connector = (_target, signal) =>
    new Promise((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason)),
    );
  const proxy = createImageProxy({ resolve: dns(NAMES).resolve, connect: stalled });
  const pending = proxy.fetch('https://img.example/a', run(controller.signal));
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, { name: 'AbortError' });
  await assert.rejects(proxy.fetch('https://img.example/a', run(controller.signal)), {
    name: 'AbortError',
  });
});

test('limits can be tightened but never loosened', () => {
  assert.deepEqual(proxyLimits().ports, [80, 443]);
  assert.equal(proxyLimits({ maxBytes: 10 }).maxBytes, 10);
  const loosen = [
    { maxRedirects: 4 },
    { maxBytes: IMAGE_PROXY_LIMITS.maxBytes + 1 },
    { maxPixels: IMAGE_PROXY_LIMITS.maxPixels + 1 },
    { timeoutMs: IMAGE_PROXY_LIMITS.timeoutMs + 1 },
    { perToken: 101 },
    { perTokenBytes: PER_TOKEN_BYTES + 1 },
    { maxInFlight: MAX_IN_FLIGHT + 1 },
    { maxTokens: TRACKED_TOKENS + 1 },
    { maxBytes: -1 },
    { timeoutMs: Number.NaN },
    { perToken: Infinity },
    { maxRedirects: 1.5 },
  ];
  for (const overrides of loosen)
    assert.throws(() => proxyLimits(overrides), RangeError, JSON.stringify(overrides));
  assert.throws(() => createImageProxy({ limits: { maxRedirects: 10 } }), RangeError);
  const ports = { ports: [8080] } as unknown as Parameters<typeof proxyLimits>[0];
  assert.deepEqual(proxyLimits(ports).ports, [80, 443], 'ports are not configurable');
  assert.ok(Object.isFrozen(proxyLimits()));
});
