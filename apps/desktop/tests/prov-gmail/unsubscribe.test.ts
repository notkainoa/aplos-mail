import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ListHeaders } from '@aplos/engine/ports';
import type { PinnedTarget, Resolver } from '../../src/host/proxy/resolve';
import {
  checkHttpsUrl,
  checkMailto,
  createUnsubscribeExecutor,
  listUris,
  oneClickOffered,
  oneClickOptions,
  oneClickTransport,
  planUnsubscribe,
  UNSUBSCRIBE_LIMITS,
  type MailSender,
  type OneClickResponse,
  type OneClickTransport,
  type UnsubscribeDeps,
} from '../../src/host/providers/google/unsubscribe';

/**
 * The List-Unsubscribe executor against hostile headers. No real network: names resolve through fake resolvers, and the
 * only sockets are to a local server on 127.0.0.1, reached by swapping the checked public address in the test's own
 * transport. Every refused case also asserts that no lookup or request happened.
 */

const PUBLIC = '93.184.216.34';
const POST = 'List-Unsubscribe=One-Click';
const LIST = 'https://list.example/unsub?u=1';

interface Spy {
  resolve: Resolver;
  transport: OneClickTransport;
  lookups: string[];
  targets: PinnedTarget[];
}

function emptyBody(): AsyncIterable<Uint8Array> {
  return (async function* () {})();
}

function fakeResponse(status: number, body = emptyBody()): OneClickResponse {
  return { status, body, close: () => undefined };
}

/** A resolver answering `answers` for every name, and a transport answering `status` without a socket. */
function spy(answers: string[] = [PUBLIC], status = 200): Spy {
  const lookups: string[] = [];
  const targets: PinnedTarget[] = [];
  return {
    lookups,
    targets,
    resolve: async host => {
      lookups.push(host);
      return answers.map(address => ({ address, family: address.includes(':') ? 6 : 4 }));
    },
    transport: async target => {
      targets.push(target);
      return fakeResponse(status);
    },
  };
}

function executor(s: Spy, extra: UnsubscribeDeps = {}) {
  return createUnsubscribeExecutor({ resolve: s.resolve, transport: s.transport, ...extra });
}

/** `null` leaves List-Unsubscribe-Post out. */
function headers(list: string, post: string | null = POST): ListHeaders {
  return post === null
    ? { listUnsubscribe: list }
    : { listUnsubscribe: list, listUnsubscribePost: post };
}

function run(s: Spy, h: ListHeaders, extra: UnsubscribeDeps = {}) {
  const signal = new AbortController().signal;
  return executor(s, extra).run({ from: 'me@mail.example', headers: h, signal });
}

// ---------------------------------------------------------------- header parsing

test('listUris reads every <uri> in order, across comma folding and mixed schemes', () => {
  assert.deepEqual(listUris('<mailto:leave@list.example>, <https://list.example/u>'), [
    'mailto:leave@list.example',
    'https://list.example/u',
  ]);
  assert.deepEqual(
    listUris('<https://a.example/1>,\r\n <mailto:b@list.example>,\r\n\t<https://c.example/3>'),
    ['https://a.example/1', 'mailto:b@list.example', 'https://c.example/3'],
  );
  assert.deepEqual(listUris('(comment) <https://a.example/1> junk, <https://b.example/2>'), [
    'https://a.example/1',
    'https://b.example/2',
  ]);
});

test('listUris skips malformed entries and stops at an unclosed bracket', () => {
  assert.deepEqual(listUris('https://bare.example/u, mailto:bare@list.example'), []);
  assert.deepEqual(listUris('<>, <https://a.example/1'), []);
  assert.deepEqual(listUris('<https://x.example/<https://a.example/1>'), []);
  assert.deepEqual(listUris('<https://a.example/1>, <https://b.example/2'), [
    'https://a.example/1',
  ]);
  assert.deepEqual(listUris(undefined), []);
  assert.deepEqual(listUris(''), []);
});

test('listUris ignores a huge header whole, quickly, and keeps at most eight entries', () => {
  const started = performance.now();
  assert.deepEqual(listUris(`<https://a.example/1>${'<'.repeat(1_000_000)}`), []);
  assert.deepEqual(
    listUris(`<https://a.example/${'x'.repeat(UNSUBSCRIBE_LIMITS.maxHeaderChars)}>`),
    [],
  );
  assert.ok(performance.now() - started < 500);
  const many = Array.from({ length: 20 }, (_, i) => `<https://a.example/${i}>`).join(', ');
  assert.equal(listUris(many).length, 8);
});

test('one-click needs List-Unsubscribe-Post to be exactly the RFC 8058 value', () => {
  assert.equal(oneClickOffered('List-Unsubscribe=One-Click'), true);
  assert.equal(oneClickOffered('  List-Unsubscribe=One-Click '), true);
  for (const post of [
    undefined,
    '',
    'list-unsubscribe=one-click',
    'List-Unsubscribe=One-Click; extra=1',
    'x List-Unsubscribe=One-Click',
    'List-Unsubscribe=One-Click\r\nBcc: a@b.example',
  ])
    assert.equal(oneClickOffered(post), false, String(post));
});

test('the plan follows Decision 5: one-click with both headers, else mailto, else the page', () => {
  assert.equal(planUnsubscribe(headers(`<${LIST}>`)).kind, 'oneClick');
  assert.equal(planUnsubscribe(headers(`<${LIST}>`, null)).kind, 'open');
  assert.equal(planUnsubscribe(headers(`<${LIST}>, <mailto:a@list.example>`, null)).kind, 'mailto');
  assert.equal(planUnsubscribe(headers('<mailto:a@list.example>')).kind, 'mailto');
  assert.equal(planUnsubscribe(headers('<http://list.example/u>')).kind, 'none');
  assert.equal(planUnsubscribe({}).kind, 'none');
  const mixed = planUnsubscribe(headers(`<mailto:a@list.example>, <${LIST}>`));
  assert.equal(mixed.kind, 'oneClick');
  assert.equal(mixed.kind === 'oneClick' && mixed.url.href, LIST);
});

// ---------------------------------------------------------------- URL checks

test('checkHttpsUrl refuses every non-https, credentialed, odd-port, fragment or literal URL', () => {
  const refused: [string, string][] = [
    ['http://list.example/u', 'scheme'],
    ['HTTP://list.example/u', 'scheme'],
    ['ftp://list.example/u', 'scheme'],
    ['javascript:alert(1)', 'scheme'],
    ['https:list.example/u', 'scheme'],
    ['https://user:pw@list.example/u', 'userinfo'],
    ['https://user@list.example/u', 'userinfo'],
    ['https://@list.example/u', 'userinfo'],
    ['https://list.example:8443/u', 'port'],
    ['https://list.example:80/u', 'port'],
    ['https://list.example/u#top', 'fragment'],
    ['https://list.example/u?a=1#', 'fragment'],
    ['https://127.0.0.1/u', 'host'],
    ['https://93.184.216.34/u', 'host'],
    ['https://0x7f.1/u', 'host'],
    ['https://2130706433/u', 'host'],
    ['https://[::1]/u', 'host'],
    ['https://[::ffff:127.0.0.1]/u', 'host'],
    ['https://[2606:4700::1]/u', 'host'],
    ['https://localhost/u', 'host'],
    ['https://a.localhost/u', 'host'],
    ['https://intranet/u', 'host'],
    ['https://list.example\\@evil.example/u', 'chars'],
    ['https://list.example/u u', 'chars'],
    ['https://list.example/u\r\nX-Evil: 1', 'chars'],
    ['https://list.example/\tu', 'chars'],
    ['https://list.example/u\u0000', 'chars'],
    ['https://list.example/\u202eu', 'chars'],
    ['https://li\u200bst.example/u', 'chars'],
    ['https://list.example/\u00a0u', 'chars'],
    ['https://list.example/u\u2028', 'chars'],
    ['https://list.example/\u00adu', 'chars'],
    [`https://list.example/${'a'.repeat(2_000)}`, 'length'],
  ];
  for (const [url, reason] of refused) {
    const checked = checkHttpsUrl(url);
    assert.deepEqual(checked, { ok: false, reason }, url);
  }
});

test('checkHttpsUrl accepts a plain https URL, with :443 normalised away, and shows IDN hosts as punycode', () => {
  const plain = checkHttpsUrl('https://list.example:443/u?a=1');
  assert.equal(plain.ok && plain.url.href, 'https://list.example/u?a=1');
  // A Cyrillic a (U+0430) in place of the Latin "a": the normalised URL shows the xn-- form, never the look-alike.
  const homograph = checkHttpsUrl('https://\u0430pple.example/u');
  assert.equal(homograph.ok && homograph.url.hostname.startsWith('xn--'), true);
  const plan = planUnsubscribe(headers('<https://\u0430pple.example/u>', null));
  assert.equal(plan.kind === 'open' && /^https:\/\/xn--/.test(plan.url), true);
  assert.equal(checkHttpsUrl(`https://list.example/${'a'.repeat(1_900)}`).ok, true);
  // Short raw, long once percent-encoded: the normalised URL is capped too.
  assert.deepEqual(checkHttpsUrl(`https://list.example/${'\u00e9'.repeat(400)}`), {
    ok: false,
    reason: 'length',
  });
});

// ---------------------------------------------------------------- refusals make no request

test('a refused URL is never looked up or contacted, even with the one-click header', async () => {
  for (const url of [
    'http://list.example/u',
    'https://user:pw@list.example/u',
    'https://list.example:8443/u',
    'https://list.example/u#x',
    'https://169.254.169.254/latest/meta-data',
    'https://[::1]/u',
    `https://list.example/${'a'.repeat(2_100)}`,
  ]) {
    const s = spy();
    const result = await run(s, headers(`<${url}>`));
    assert.equal(result.kind, 'none', url);
    assert.deepEqual([s.lookups, s.targets], [[], []], url);
  }
});

test('a name resolving to any private, loopback, link-local, metadata, CGNAT, ULA, mapped or unspecified address is refused before any request', async () => {
  const bad = [
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    '::',
    'fd00::1',
    'fe80::1',
    'ff02::1',
    '::ffff:10.0.0.1',
    '::ffff:169.254.169.254',
    '64:ff9b::a00:1',
  ];
  for (const address of [...bad.map(a => [a]), [PUBLIC, '10.0.0.1'], ['2606:4700::1', '::1']]) {
    const s = spy(address);
    const result = await run(s, headers(`<${LIST}>`));
    assert.equal(result.kind, 'failed', address.join());
    assert.match(result.message, /private or local network/);
    assert.equal(s.lookups.length, 1);
    assert.equal(s.targets.length, 0, address.join());
  }
});

test('a rebinding resolver cannot swap the address: one lookup per run, and the socket goes to the checked address', async () => {
  const answers = [PUBLIC, '127.0.0.1'];
  let calls = 0;
  const targets: PinnedTarget[] = [];
  const deps: UnsubscribeDeps = {
    resolve: async () => [{ address: answers[Math.min(calls++, 1)], family: 4 }],
    transport: async target => {
      targets.push(target);
      return fakeResponse(200);
    },
  };
  const unsub = createUnsubscribeExecutor(deps);
  const request = {
    from: 'me@mail.example',
    headers: headers(`<${LIST}>`),
    signal: new AbortController().signal,
  };
  assert.equal((await unsub.run(request)).kind, 'done');
  assert.equal(calls, 1);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].address, PUBLIC);
  assert.equal(targets[0].servername, 'list.example');
  assert.equal(targets[0].hostHeader, 'list.example');
  assert.equal(targets[0].secure, true);
  assert.equal(targets[0].port, 443);
  const options = oneClickOptions(targets[0], new AbortController().signal);
  assert.equal(options.host, PUBLIC);
  // Any lookup Node attempts is answered with the pinned address, never a second DNS query.
  const looked = await new Promise(done =>
    (options.lookup as (h: string, o: object, cb: (...a: unknown[]) => void) => void)(
      'list.example',
      {},
      (_e, a) => done(a),
    ),
  );
  assert.equal(looked, PUBLIC);
  assert.equal((await unsub.run(request)).kind, 'failed');
  assert.equal(calls, 2);
  assert.equal(targets.length, 1);
});

// ---------------------------------------------------------------- the request on the wire

interface Seen {
  method?: string;
  url?: string;
  names: string[];
  headers: http.IncomingHttpHeaders;
  body: string;
}

async function serve(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const names = req.rawHeaders.filter((_, i) => i % 2 === 0).map(n => n.toLowerCase());
      seen.push({
        method: req.method,
        url: req.url,
        names,
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      });
      handler(req, res);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  const close = () => {
    server.closeAllConnections();
    return new Promise(done => server.close(done));
  };
  return { port, seen, close };
}

/** The production request builder over plain HTTP to the local server, in place of the checked public address. */
function toLocal(port: number): OneClickTransport {
  const send = oneClickTransport(http);
  return (target, signal) => send({ ...target, address: '127.0.0.1', family: 4, port }, signal);
}

test('the one-click request is a POST with the exact body and fixed headers, never a cookie, referrer or credential', async () => {
  const server = await serve((_req, res) => {
    res.setHeader('Set-Cookie', 'track=1');
    res.end('ok');
  });
  try {
    const s = spy();
    for (let i = 0; i < 2; i += 1) {
      const result = await run(s, headers(`<${LIST}>`), { transport: toLocal(server.port) });
      assert.equal(result.kind, 'done');
    }
    assert.equal(server.seen.length, 2);
    for (const seen of server.seen) {
      assert.equal(seen.method, 'POST');
      assert.equal(seen.url, '/unsub?u=1');
      assert.equal(seen.body, 'List-Unsubscribe=One-Click');
      assert.deepEqual(seen.names.sort(), [
        'accept-encoding',
        'connection',
        'content-length',
        'content-type',
        'host',
        'user-agent',
      ]);
      assert.equal(seen.headers.host, 'list.example');
      assert.equal(seen.headers['content-type'], 'application/x-www-form-urlencoded');
      assert.equal(seen.headers['content-length'], '26');
      assert.equal(seen.headers['user-agent'], 'AplosMail-Unsubscribe/1');
    }
  } finally {
    await server.close();
  }
});

test('a redirect is never followed: the answer is unsure and only one request is made', async () => {
  const server = await serve((_req, res) => {
    res.writeHead(302, { Location: 'https://other.example/confirm' });
    res.end();
  });
  try {
    const s = spy();
    const result = await run(s, headers(`<${LIST}>`), { transport: toLocal(server.port) });
    assert.equal(result.kind, 'unsure');
    assert.equal(result.url, LIST);
    assert.equal(server.seen.length, 1);
    assert.deepEqual(s.lookups, ['list.example']);
  } finally {
    await server.close();
  }
  for (const status of [301, 303, 307, 308]) {
    const s = spy([PUBLIC], status);
    assert.equal((await run(s, headers(`<${LIST}>`))).kind, 'unsure', String(status));
    assert.equal(s.targets.length, 1);
  }
});

test('only a 2xx answer counts as done; any other status fails', async () => {
  for (const [status, kind] of [
    [200, 'done'],
    [202, 'done'],
    [204, 'done'],
    [400, 'failed'],
    [404, 'failed'],
    [500, 'failed'],
    [100, 'failed'],
    [0, 'failed'],
  ] as const) {
    const result = await run(spy([PUBLIC], status), headers(`<${LIST}>`));
    assert.equal(result.kind, kind, String(status));
  }
});

test('the response body is read to at most 64 KB, then the connection is dropped', async () => {
  let pulled = 0;
  let closed = 0;
  const chunk = new Uint8Array(16 * 1024);
  // Bounded at 4 MB so a broken cap fails the assertion instead of hanging the run.
  const body = (async function* () {
    while (pulled < 4 * 1024 * 1024) {
      pulled += chunk.byteLength;
      yield chunk;
    }
  })();
  const transport: OneClickTransport = async () => ({
    status: 200,
    body,
    close: () => (closed += 1),
  });
  const result = await run(spy(), headers(`<${LIST}>`), { transport });
  assert.equal(result.kind, 'done');
  assert.ok(pulled <= UNSUBSCRIBE_LIMITS.maxResponseBytes, `pulled ${pulled}`);
  assert.equal(closed, 1);
});

test('a server that never answers times out as unsure; a lookup that never answers fails without a request', async () => {
  const server = await serve(() => undefined);
  try {
    const result = await run(spy(), headers(`<${LIST}>`), {
      transport: toLocal(server.port),
      timeoutMs: 100,
    });
    assert.equal(result.kind, 'unsure');
    assert.match(result.message, /did not answer in time/);
  } finally {
    await server.close();
  }
  const s = spy();
  const hung: Resolver = () => new Promise(() => undefined);
  const result = await run(s, headers(`<${LIST}>`), { resolve: hung, timeoutMs: 50 });
  assert.equal(result.kind, 'failed');
  assert.equal(s.targets.length, 0);
  assert.throws(
    () => createUnsubscribeExecutor({ timeoutMs: UNSUBSCRIBE_LIMITS.timeoutMs + 1 }),
    RangeError,
  );
  assert.equal(UNSUBSCRIBE_LIMITS.timeoutMs, 10_000);
});

test('a failed lookup fails without a request; a broken connection after sending is unsure', async () => {
  const s = spy();
  const missing: Resolver = async () => {
    throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
  };
  assert.equal((await run(s, headers(`<${LIST}>`), { resolve: missing })).kind, 'failed');
  assert.equal(s.targets.length, 0);
  const broken: OneClickTransport = async () => {
    throw new Error('ECONNRESET');
  };
  assert.equal((await run(spy(), headers(`<${LIST}>`), { transport: broken })).kind, 'unsure');
});

test('a cancelled call rejects and sends nothing', async () => {
  const s = spy();
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  await assert.rejects(
    executor(s).run({
      from: 'me@mail.example',
      headers: headers(`<${LIST}>`),
      signal: controller.signal,
    }),
    /cancelled/,
  );
  assert.deepEqual([s.lookups, s.targets], [[], []]);
});

// ---------------------------------------------------------------- mailto

test('checkMailto takes one plain address with an optional subject and body', () => {
  assert.deepEqual(checkMailto('mailto:leave@list.example'), {
    to: 'leave@list.example',
    subject: 'unsubscribe',
    body: '',
  });
  assert.deepEqual(
    checkMailto('MAILTO:leave@list.example?subject=Stop%20please&body=id%3D42%0D%0Athanks'),
    {
      to: 'leave@list.example',
      subject: 'Stop please',
      body: 'id=42\r\nthanks',
    },
  );
});

test('checkMailto refuses header injection, extra fields, more than one address and oversize values', () => {
  for (const uri of [
    'mailto:leave@list.example?subject=x%0D%0ABcc:%20victim@else.example',
    'mailto:leave@list.example?subject=x%0Ay',
    'mailto:leave@list.example?subject=x\r\nBcc: v@else.example',
    'mailto:leave@list.example%0D%0ABcc:v@else.example',
    'mailto:leave@list.example?cc=v@else.example',
    'mailto:leave@list.example?bcc=v@else.example',
    'mailto:leave@list.example?to=v@else.example',
    'mailto:leave@list.example?in-reply-to=%3Cx@y%3E',
    'mailto:leave@list.example?X-Header=1',
    'mailto:leave@list.example?subject=a&subject=b',
    'mailto:a@list.example,b@list.example',
    'mailto:a@list.example%2Cb@list.example',
    'mailto:a@list.example;b@list.example',
    'mailto:Name%20%3Ca@list.example%3E',
    'mailto:a@[127.0.0.1]',
    'mailto:a@localhost',
    'mailto:a?b@list.example',
    'mailto:@list.example',
    'mailto:a..b@list.example',
    'mailto:a@b@list.example',
    'mailto:leave@list.example?subject=%E0%A4%A',
    'mailto:leave@list.example#frag',
    'mailto:leave@list.example?body=%00',
    'mailto:leave@list.example?subject=a%E2%80%A8b',
    'mailto:leave@list.example?subject=a%C2%85b',
    'mailto:leave@list.example?body=a%1Bb',
    `mailto:leave@list.example?subject=${'s'.repeat(201)}`,
    `mailto:leave@list.example?body=${'b'.repeat(1_001)}`,
    `mailto:${'a'.repeat(65)}@list.example`,
    'https://list.example/u',
  ])
    assert.equal(checkMailto(uri), null, uri);
});

test('mailto without a send seam asks the composer, with a mailto rebuilt from the checked fields only', async () => {
  const s = spy();
  const result = await run(s, headers('<mailto:leave@list.example?subject=Stop%20now&body=a%26b>'));
  assert.equal(result.kind, 'compose');
  assert.equal(result.url, 'mailto:leave@list.example?subject=Stop%20now&body=a%26b');
  assert.deepEqual([s.lookups, s.targets], [[], []]);
});

test('mailto with the send seam sends once from the receiving account, and reports a failed send', async () => {
  const sent: Parameters<MailSender>[0][] = [];
  const sendMail: MailSender = async mail => {
    sent.push(mail);
  };
  const result = await run(spy(), headers('<mailto:leave@list.example?subject=Stop>', null), {
    sendMail,
  });
  assert.equal(result.kind, 'done');
  assert.deepEqual(sent, [
    { to: 'leave@list.example', subject: 'Stop', body: '', from: 'me@mail.example' },
  ]);
  const failing: MailSender = async () => {
    throw new Error('outbox closed');
  };
  const failed = await run(spy(), headers('<mailto:leave@list.example>'), { sendMail: failing });
  assert.equal(failed.kind, 'failed');
});

test('one-click wins over mailto; the mail sender is not called then', async () => {
  let calls = 0;
  const sendMail: MailSender = async () => {
    calls += 1;
  };
  const result = await run(spy(), headers(`<mailto:leave@list.example>, <${LIST}>`), { sendMail });
  assert.equal(result.kind, 'done');
  assert.equal(calls, 0);
});

// ---------------------------------------------------------------- open the page

test('a page link is returned to open, never fetched, and describe names each method', () => {
  const s = spy();
  const unsub = executor(s);
  assert.deepEqual(unsub.describe(headers(`<${LIST}>`)), { method: 'oneClick' });
  assert.deepEqual(unsub.describe(headers(`<${LIST}>`, null)), { method: 'link', url: LIST });
  assert.deepEqual(unsub.describe(headers('<mailto:a@list.example>')), {
    method: 'mailto',
    url: 'mailto:a@list.example?subject=unsubscribe',
  });
  assert.deepEqual(unsub.describe({}), { method: 'none' });
  assert.deepEqual([s.lookups, s.targets], [[], []]);
});

test('run with only a page link answers open and makes no request', async () => {
  const s = spy();
  const result = await run(s, headers(`<${LIST}>`, null));
  assert.deepEqual({ kind: result.kind, url: result.url }, { kind: 'open', url: LIST });
  assert.deepEqual([s.lookups, s.targets], [[], []]);
  assert.equal((await run(s, {})).kind, 'none');
});
