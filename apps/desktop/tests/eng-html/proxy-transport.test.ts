import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import net, { type AddressInfo } from 'node:net';
import tls from 'node:tls';
import type { ImageRefusal, ProxiedImage } from '@aplos/engine/ports';
import {
  createImageProxy,
  nodeConnector,
  requestOptions,
  type Connector,
} from '../../src/host/proxy/fetch';
import type { PinnedTarget, Resolver } from '../../src/host/proxy/resolve';
import { makeFixtures, opensslAvailable, type Credentials, type Fixtures } from './tls-fixtures';

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
  /** Every header exactly as it arrived, name and value, in order. */
  headers: string[][];
  host?: string;
}

/** What the proxy must send, written out here so a changed `REQUEST_HEADERS` cannot change the expectation. */
const EXPECTED_HEADERS = [
  ['Host', 'img.example'],
  ['User-Agent', 'Mozilla/5.0'],
  ['Accept', 'image/png,image/jpeg,image/gif,image/webp'],
  ['Accept-Encoding', 'identity'],
  ['Connection', 'close'],
];

function seen(req: http.IncomingMessage): Seen {
  const headers: string[][] = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2)
    headers.push([req.rawHeaders[i], req.rawHeaders[i + 1]]);
  return { method: req.method, url: req.url, headers, host: req.headers.host };
}

function listening(server: http.Server | https.Server, requests: Seen[]) {
  server.listen(0, '127.0.0.1');
  const ready = once(server, 'listening');
  const close = () => {
    server.closeAllConnections();
    return new Promise(done => server.close(done));
  };
  return ready.then(() => ({
    port: (server.address() as AddressInfo).port,
    requests,
    close,
  }));
}

async function serve(handler: http.RequestListener) {
  const requests: Seen[] = [];
  const server = http.createServer((req, res) => {
    requests.push(seen(req));
    handler(req, res);
  });
  return listening(server, requests);
}

/** An HTTPS server with the given credentials; handshakes that fail are counted, requests that arrive are kept. */
async function serveTls(credentials: Credentials) {
  const requests: Seen[] = [];
  const server = https.createServer(credentials, (req, res) => {
    requests.push(seen(req));
    res.end(IMAGE);
  });
  let rejected = 0;
  server.on('tlsClientError', () => (rejected += 1));
  const started = await listening(server, requests);
  return { ...started, rejected: () => rejected };
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
    for (const request of server.requests) {
      assert.equal(request.method, 'GET');
      assert.equal(request.url, '/a.png?x=1');
      assert.equal(request.host, 'img.example');
      assert.deepEqual(request.headers, EXPECTED_HEADERS, 'exactly these, no Cookie or Referer');
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
  assert.deepEqual(options.headers, Object.fromEntries(EXPECTED_HEADERS));
  assert.equal(options.method, 'GET');
  assert.equal(options.setHost, false);
  assert.equal(options.rejectUnauthorized, undefined, 'certificate checks stay at the default');
  assert.equal(options.checkServerIdentity, undefined);
  assert.equal(options.ca, undefined);
  assert.equal(options.maxHeaderSize, 8 * 1024);
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

/**
 * Records the local port of every TLS client socket this process opens, so a server can tell its own test's
 * connections from a stray one (a scanner or another process hitting the same ephemeral port on a busy machine).
 */
function trackingClientPorts(context: TestContext): Set<number> {
  const ports = new Set<number>();
  const original = tls.connect;
  context.mock.method(tls, 'connect', (...args: Parameters<typeof tls.connect>) => {
    const socket = original(...args);
    socket.once('connect', () => ports.add(socket.localPort as number));
    return socket;
  });
  return ports;
}

test('TLS sends the original name as SNI to the checked address, and no SNI for an IP literal', async t => {
  const ours = trackingClientPorts(t);
  const names: string[] = [];
  // Keyed by the client's port, so a repeated event for one socket or a stray connection cannot change a count.
  const accepted = new Set<number>();
  const failed = new Set<number>();
  // No certificate at all: the handshake fails after the client hello, which is all this test needs to see.
  const server = tls.createServer({
    SNICallback: (name, done) => {
      names.push(name);
      done(new Error('no certificate'));
    },
  });
  const ports = new WeakMap<object, number>();
  server.on('connection', socket => {
    ports.set(socket, socket.remotePort as number);
    accepted.add(socket.remotePort as number);
  });
  server.on('tlsClientError', (_error, socket) => {
    const port = ports.get((socket as unknown as { _parent: object })._parent);
    if (port !== undefined) failed.add(port);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  const mine = (all: Set<number>) => [...all].filter(p => ours.has(p));
  try {
    // A stray client on the same port, as a busy machine produces: it must not change what is counted.
    const stray = net.connect(port, '127.0.0.1');
    stray.on('error', () => undefined);
    stray.end('GET / HTTP/1.1\r\n\r\n');
    await until(() => failed.size >= 1);
    const seen: PinnedTarget[] = [];
    const proxy = createImageProxy({ resolve, connect: toLocal(port, seen) });
    assert.deepEqual(await proxy.fetch('https://img.example/a.png', run()), refusedAs('http'));
    assert.deepEqual(await proxy.fetch(`https://${PUBLIC}/a.png`, run()), refusedAs('http'));
    await until(() => mine(failed).length >= 2);
    assert.ok(
      accepted.size >= 3,
      'the stray was accepted too (more strays are possible), and is not counted as ours',
    );
    assert.equal(mine(accepted).length, 2, 'one connection per fetch, no retry');
    assert.equal(mine(failed).length, 2);
    assert.deepEqual(names, ['img.example']);
    assert.deepEqual(
      seen.map(target => [target.address, target.servername]),
      [
        [PUBLIC, 'img.example'],
        [PUBLIC, undefined],
      ],
    );
  } finally {
    await new Promise(done => server.close(done));
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

// --- Certificates are really checked -------------------------------------------------------------------------------

// Skip ONLY when the `openssl` command line is missing, and never in CI (it has one): any other failure to make the
// fixtures (an unsupported flag, a full temp dir) must fail the file loudly instead of silently dropping the TLS tests.
const haveOpenssl = opensslAvailable();
if (!haveOpenssl && process.env.CI) throw new Error('openssl is required in CI for the TLS tests');
const fixtures: Fixtures | undefined = haveOpenssl ? makeFixtures() : undefined;
const needsOpenssl = fixtures ? {} : { skip: 'the openssl command line is not available' };

/** Trusts `ca` for the duration of `body`, on top of the system roots. Process-wide, so tests here run one at a time. */
async function trusting<T>(ca: string, body: () => Promise<T>): Promise<T> {
  const original = tls.getCACertificates('default');
  tls.setDefaultCACertificates([...original, ca]);
  try {
    return await body();
  } finally {
    tls.setDefaultCACertificates(original);
  }
}

/** Remembers why each connection failed, so a test can tell a certificate error from any other failure. */
function recording(inner: Connector, codes: string[]): Connector {
  return async (target, signal) => {
    try {
      return await inner(target, signal);
    } catch (error) {
      codes.push(String((error as { code?: string }).code));
      throw error;
    }
  };
}

test(
  'an HTTPS server with a certificate the trusted CA signed for the name is fetched',
  needsOpenssl,
  async () => {
    const fx = fixtures as Fixtures;
    const server = await serveTls(fx.good);
    try {
      await trusting(fx.ca, async () => {
        const codes: string[] = [];
        const proxy = createImageProxy({
          resolve,
          connect: recording(toLocal(server.port), codes),
        });
        const result = await proxy.fetch('https://img.example/a.png', run());
        assert.equal(result.kind, 'image');
        assert.deepEqual(codes, []);
      });
      assert.equal(server.requests.length, 1);
      assert.deepEqual(server.requests[0].headers, EXPECTED_HEADERS);
    } finally {
      await server.close();
    }
  },
);

const BAD_CERTIFICATES: [string, (fx: Fixtures) => Credentials, string][] = [
  ['a self-signed certificate', fx => fx.selfSigned, 'DEPTH_ZERO_SELF_SIGNED_CERT'],
  ['a certificate from a CA nobody trusts', fx => fx.unknownCa, 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'],
  ['a trusted certificate for another name', fx => fx.wrongName, 'ERR_TLS_CERT_ALTNAME_INVALID'],
];

for (const [label, pick, code] of BAD_CERTIFICATES)
  test(`${label} is refused with a TLS error, and no request is sent`, needsOpenssl, async () => {
    const fx = fixtures as Fixtures;
    const server = await serveTls(pick(fx));
    try {
      await trusting(fx.ca, async () => {
        const codes: string[] = [];
        const proxy = createImageProxy({
          resolve,
          connect: recording(toLocal(server.port), codes),
        });
        assert.deepEqual(await proxy.fetch('https://img.example/a.png', run()), refusedAs('http'));
        assert.deepEqual(codes, [code]);
      });
      assert.equal(server.requests.length, 0, 'the request never left the client');
    } finally {
      await server.close();
    }
  });

test(
  'an IP literal is checked against the address itself, so a name-only certificate fails',
  needsOpenssl,
  async () => {
    const fx = fixtures as Fixtures;
    const server = await serveTls(fx.good);
    try {
      await trusting(fx.ca, async () => {
        const codes: string[] = [];
        const proxy = createImageProxy({
          resolve,
          connect: recording(toLocal(server.port), codes),
        });
        assert.deepEqual(await proxy.fetch(`https://${PUBLIC}/a.png`, run()), refusedAs('http'));
        assert.deepEqual(codes, ['ERR_TLS_CERT_ALTNAME_INVALID']);
      });
      assert.equal(server.requests.length, 0);
    } finally {
      await server.close();
    }
  },
);

// --- Oversized response headers ----------------------------------------------------------------------------------

test('a response whose header block is over the limit is refused, and a modest one is not', async () => {
  const server = await serve((req, res) => {
    const size = req.url === '/big' ? 12 * 1024 : 2 * 1024;
    res.setHeader('X-Padding', 'a'.repeat(size));
    res.end(IMAGE);
  });
  try {
    const codes: string[] = [];
    const proxy = createImageProxy({ resolve, connect: recording(toLocal(server.port), codes) });
    assert.equal((await proxy.fetch('http://img.example/small', run())).kind, 'image');
    assert.deepEqual(await proxy.fetch('http://img.example/big', run()), refusedAs('http'));
    assert.deepEqual(codes, ['HPE_HEADER_OVERFLOW']);
  } finally {
    await server.close();
  }
});

// --- Fetches in flight --------------------------------------------------------------------------------------------

const until = async (done: () => boolean) => {
  for (let i = 0; i < 1000 && !done(); i += 1) await new Promise(r => setTimeout(r, 5));
  assert.ok(done(), 'condition not reached in time');
};

/**
 * A server that holds every response open until the test lets it go; it counts how many are open at once.
 * Only requests the proxy sent (Host `img.example`) count: a local port probe, such as another tool looking at a newly
 * opened port, gets an empty answer and is not held, counted or listed in `requests`.
 */
async function slowServer() {
  const held: http.ServerResponse[] = [];
  let open = 0;
  let peak = 0;
  const server = await serve((req, res) => {
    if (req.headers.host !== 'img.example') return void res.writeHead(404).end();
    open += 1;
    peak = Math.max(peak, open);
    held.push(res);
    res.on('close', () => (open -= 1));
  });
  const proxied = () => server.requests.filter(request => request.host === 'img.example');
  return {
    ...server,
    get requests() {
      return proxied();
    },
    held,
    open: () => open,
    peak: () => peak,
    releaseAll: () => held.splice(0).forEach(res => res.end(IMAGE)),
  };
}

test('a local port probe is answered at once and is not counted as a fetch', async () => {
  const server = await slowServer();
  try {
    const answer = await new Promise<number | undefined>((done, fail) => {
      http
        .get(
          { host: '127.0.0.1', port: server.port, path: '/' },
          res => (res.resume(), done(res.statusCode)),
        )
        .on('error', fail);
    });
    assert.equal(answer, 404);
    assert.equal(server.held.length, 0);
    assert.equal(server.requests.length, 0);
  } finally {
    await server.close();
  }
});

test('six slow fetches run at once and the rest wait their turn', { timeout: 30000 }, async () => {
  const server = await slowServer();
  try {
    const proxy = createImageProxy({ resolve, connect: toLocal(server.port) });
    const all = Array.from({ length: 14 }, (_, i) => proxy.fetch(`http://img.example/${i}`, run()));
    await until(() => server.held.length === 6);
    await new Promise(r => setTimeout(r, 100));
    assert.equal(server.held.length, 6, 'the seventh has not connected');
    // Release whatever is open until every fetch has finished: how many connect between two releases depends on load.
    let finished = false;
    const results = Promise.all(all).finally(() => (finished = true));
    while (!finished) {
      server.releaseAll();
      await new Promise(r => setTimeout(r, 5));
    }
    assert.ok((await results).every(result => result.kind === 'image'));
    assert.equal(server.requests.length, 14);
    assert.equal(server.peak(), 6);
  } finally {
    await server.close();
  }
});

test(
  'a waiting fetch can be aborted without connecting or leaking its slot',
  { timeout: 10000 },
  async () => {
    const server = await slowServer();
    try {
      const proxy = createImageProxy({
        resolve,
        connect: toLocal(server.port),
        limits: { maxInFlight: 1 },
      });
      const first = proxy.fetch('http://img.example/a', run());
      await until(() => server.held.length === 1);
      const controller = new AbortController();
      const waiting = proxy.fetch('http://img.example/b', run(controller.signal));
      setTimeout(() => controller.abort(), 30);
      await assert.rejects(waiting, { name: 'AbortError' });
      assert.equal(server.requests.length, 1, 'the aborted one never connected');
      const third = proxy.fetch('http://img.example/c', run());
      server.releaseAll();
      assert.equal((await first).kind, 'image');
      await until(() => server.held.length === 1);
      server.releaseAll();
      assert.equal((await third).kind, 'image');
      assert.deepEqual(
        server.requests.map(request => request.url),
        ['/a', '/c'],
      );
    } finally {
      await server.close();
    }
  },
);
