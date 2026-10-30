import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import tls from 'node:tls';
import type { ImageRefusal, ProxiedImage } from '@aplos/engine/ports';
import {
  createImageProxy,
  nodeConnector,
  REQUEST_HEADERS,
  requestOptions,
  type Connector,
} from '../../src/host/proxy/fetch';
import type { PinnedTarget, Resolver } from '../../src/host/proxy/resolve';

/**
 * The real Node transport against servers on 127.0.0.1. The classifier stays strict: the fake resolver answers a
 * public address, and only the test's connector swaps that checked address for the local server's. No production
 * path reaches loopback, which the last tests prove with the default connector.
 */

const PUBLIC = '93.184.216.34';
const IMAGE = Uint8Array.from([
  ...[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13],
  ...[0x49, 0x48, 0x44, 0x52, 0, 0, 0, 2, 0, 0, 0, 2, 8, 6, 0, 0, 0, 0, 0, 0, 0],
]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');

const resolve: Resolver = async host => {
  if (host === 'img.example') return [{ address: PUBLIC, family: 4 }];
  if (host === 'loopback.example') return [{ address: '127.0.0.1', family: 4 }];
  throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
};

/** Connects to the local server in place of the checked public address; Host and SNI still carry the name. */
function toLocal(port: number, seen: PinnedTarget[] = []): Connector {
  return (target, signal) => {
    seen.push(target);
    return nodeConnector({ ...target, address: '127.0.0.1', family: 4, port }, signal);
  };
}

interface Seen {
  method?: string;
  url?: string;
  headers: string[];
  host?: string;
}

async function serve(handler: http.RequestListener) {
  const requests: Seen[] = [];
  const server = http.createServer((req, res) => {
    const names = req.rawHeaders.filter((_, i) => i % 2 === 0).map(n => n.toLowerCase());
    requests.push({ method: req.method, url: req.url, headers: names, host: req.headers.host });
    handler(req, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  const close = () => {
    server.closeAllConnections();
    return new Promise(done => server.close(done));
  };
  return { port, requests, close };
}

const run = (signal = new AbortController().signal) => ({ token: 't1', signal });
const refusedAs = (reason: ImageRefusal): ProxiedImage => ({ kind: 'refused', reason });

test('the request on the wire is a GET with only Host and the fixed headers, never a cookie', async () => {
  const server = await serve((_req, res) => {
    res.setHeader('Set-Cookie', 'track=1');
    res.end(IMAGE);
  });
  try {
    const proxy = createImageProxy({ resolve, connect: toLocal(server.port) });
    for (let i = 0; i < 2; i += 1) {
      const result = await proxy.fetch('http://img.example/a.png?x=1#frag', run());
      assert.equal(result.kind, 'image');
    }
    const expected = ['host', ...Object.keys(REQUEST_HEADERS).map(n => n.toLowerCase())];
    for (const seen of server.requests) {
      assert.equal(seen.method, 'GET');
      assert.equal(seen.url, '/a.png?x=1');
      assert.equal(seen.host, 'img.example');
      assert.deepEqual(seen.headers, expected);
    }
    assert.equal(server.requests.length, 2);
  } finally {
    await server.close();
  }
});

test('request options pin the socket to the checked address and answer any lookup with it', async () => {
  const target: PinnedTarget = {
    url: new URL('https://img.example/a.png'),
    secure: true,
    address: PUBLIC,
    family: 4,
    port: 443,
    hostHeader: 'img.example',
    servername: 'img.example',
    path: '/a.png',
  };
  const options = requestOptions(target, new AbortController().signal);
  assert.equal(options.host, PUBLIC);
  assert.equal(options.servername, 'img.example');
  assert.equal(options.agent, false);
  assert.deepEqual(options.headers, { Host: 'img.example', ...REQUEST_HEADERS });
  const lookup = options.lookup as unknown as (
    host: string,
    opts: { all?: boolean },
    cb: (...args: unknown[]) => void,
  ) => void;
  const answers: unknown[][] = [];
  lookup('evil.example', {}, (...args) => answers.push(args));
  lookup('evil.example', { all: true }, (...args) => answers.push(args));
  assert.deepEqual(answers, [
    [null, PUBLIC, 4],
    [null, [{ address: PUBLIC, family: 4 }]],
  ]);
  const literal = requestOptions(
    { ...target, servername: undefined },
    new AbortController().signal,
  );
  assert.equal(literal.servername, '', 'no SNI for an IP literal');
});

test('a redirect over the real transport is followed, and one to loopback or another port is not', async () => {
  const server = await serve((req, res) => {
    const to: Record<string, string> = {
      '/a': 'http://img.example/b',
      '/loop': 'http://127.0.0.1/',
      '/port': 'http://img.example:8080/',
      '/name': 'http://loopback.example/',
    };
    if (to[req.url ?? '']) res.writeHead(302, { Location: to[req.url ?? ''] }).end();
    else res.end(IMAGE);
  });
  try {
    const seen: PinnedTarget[] = [];
    const proxy = createImageProxy({ resolve, connect: toLocal(server.port, seen) });
    assert.equal((await proxy.fetch('http://img.example/a', run())).kind, 'image');
    assert.deepEqual(
      server.requests.map(r => r.url),
      ['/a', '/b'],
    );
    for (const path of ['/loop', '/port', '/name']) {
      const result = await proxy.fetch(`http://img.example${path}`, run());
      assert.deepEqual(result, refusedAs('redirects'), path);
    }
    assert.equal(server.requests.length, 5);
    assert.ok(seen.every(target => target.address === PUBLIC));
  } finally {
    await server.close();
  }
});

test('Content-Type is ignored: an SVG served as image/png is refused', async () => {
  const server = await serve((_req, res) =>
    res.writeHead(200, { 'Content-Type': 'image/png' }).end(SVG),
  );
  try {
    const proxy = createImageProxy({ resolve, connect: toLocal(server.port) });
    assert.deepEqual(await proxy.fetch('http://img.example/a.png', run()), refusedAs('type'));
  } finally {
    await server.close();
  }
});

test('an oversized chunked body is cut off, and a declared oversized one is never read', async () => {
  const server = await serve((req, res) => {
    if (req.url === '/declared') res.writeHead(200, { 'Content-Length': '5000' });
    res.write(IMAGE);
    const timer = setInterval(() => res.write(new Uint8Array(512)), 1);
    res.on('close', () => clearInterval(timer));
  });
  try {
    const proxy = createImageProxy({
      resolve,
      connect: toLocal(server.port),
      limits: { maxBytes: 2000 },
    });
    assert.deepEqual(await proxy.fetch('http://img.example/chunked', run()), refusedAs('size'));
    assert.deepEqual(await proxy.fetch('http://img.example/declared', run()), refusedAs('size'));
  } finally {
    await server.close();
  }
});

test('a server that stalls mid-body is cut off by the time limit and its socket closed', async () => {
  let socketClosed = false;
  const server = await serve((_req, res) => {
    res.write(IMAGE.subarray(0, 16));
    res.on('close', () => (socketClosed = true));
  });
  try {
    const proxy = createImageProxy({
      resolve,
      connect: toLocal(server.port),
      limits: { timeoutMs: 200 },
    });
    assert.deepEqual(await proxy.fetch('http://img.example/slow', run()), refusedAs('timeout'));
    for (let i = 0; i < 50 && !socketClosed; i += 1) await new Promise(r => setTimeout(r, 10));
    assert.equal(socketClosed, true);
  } finally {
    await server.close();
  }
});

test('aborting mid-body rejects with an AbortError', async () => {
  const server = await serve((_req, res) => void res.write(IMAGE.subarray(0, 16)));
  try {
    const proxy = createImageProxy({ resolve, connect: toLocal(server.port) });
    const controller = new AbortController();
    const pending = proxy.fetch('http://img.example/slow', run(controller.signal));
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(pending, { name: 'AbortError' });
  } finally {
    await server.close();
  }
});

test('TLS sends the original name as SNI to the checked address, and no SNI for an IP literal', async () => {
  const names: string[] = [];
  let handshakes = 0;
  // No certificate at all: the handshake fails after the client hello, which is all this test needs to see.
  const server = tls.createServer({
    SNICallback: (name, done) => {
      names.push(name);
      done(new Error('no certificate'));
    },
  });
  server.on('tlsClientError', () => (handshakes += 1));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  try {
    const seen: PinnedTarget[] = [];
    const proxy = createImageProxy({ resolve, connect: toLocal(port, seen) });
    assert.deepEqual(await proxy.fetch('https://img.example/a.png', run()), refusedAs('http'));
    assert.deepEqual(await proxy.fetch(`https://${PUBLIC}/a.png`, run()), refusedAs('http'));
    assert.deepEqual(names, ['img.example']);
    assert.equal(handshakes, 2);
    assert.deepEqual(
      seen.map(target => [target.address, target.servername]),
      [
        [PUBLIC, 'img.example'],
        [PUBLIC, undefined],
      ],
    );
  } finally {
    server.close();
  }
});

test('the production connector never reaches loopback, by name, literal or port', async () => {
  const server = await serve((_req, res) => res.end(IMAGE));
  try {
    const named = createImageProxy({ resolve });
    assert.deepEqual(await named.fetch('http://loopback.example/', run()), refusedAs('address'));
    const defaults = createImageProxy();
    const cases: [string, ImageRefusal][] = [
      [`http://127.0.0.1:${server.port}/`, 'port'],
      ['http://127.0.0.1/', 'address'],
      ['http://[::1]/', 'address'],
      ['http://localhost/', 'address'],
      ['http://2130706433/', 'address'],
    ];
    for (const [url, reason] of cases)
      assert.deepEqual(await defaults.fetch(url, run()), refusedAs(reason), url);
    assert.equal(server.requests.length, 0);
  } finally {
    await server.close();
  }
});
