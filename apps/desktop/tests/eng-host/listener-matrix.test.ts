import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import {
  startHttpListener,
  statusForError,
  type HttpLimits,
  type HttpListener,
} from '../../src/host/transports/http';
import { AUTH_REFUSED, type DoorwayLog } from '../../src/host/transports/auth';
import { ContractError } from '@aplos/contract/contract-error';
import {
  DB_EPOCH,
  fakeBackend,
  fakeRegistry,
  pause,
  rawConnect,
  stateFrame,
  type FakeBackend,
  type FakeRegistry,
} from './doorway-fakes';

/*
 * host-4, the loopback HTTP request matrix (plan 10 E7 acceptance): every refusal answers the right status and the
 * backend records no entry at all. Requests are written byte for byte on raw sockets, so duplicate headers, bad paths
 * and slow senders are exactly what the server sees.
 */

const ALL = ['read', 'triage', 'draft', 'send', 'ai', 'admin'];

interface Rig {
  reg: FakeRegistry;
  be: FakeBackend;
  listener: HttpListener;
  port: number;
  host: string;
  /** A client holding every grantable scope. */
  token: string;
  logs: string[];
}

async function rig(
  t: TestContext,
  options: { limits?: Partial<HttpLimits>; allowedOrigins?: string[] } = {},
): Promise<Rig> {
  const reg = fakeRegistry();
  const be = fakeBackend();
  const logs: string[] = [];
  const log: DoorwayLog = (code, fields) => void logs.push(JSON.stringify({ code, fields }));
  const listener = await startHttpListener({
    port: 0,
    registry: reg.registry,
    backend: be.backend,
    allowedOrigins: options.allowedOrigins,
    log,
    limits: {
      maxCallBytes: 1024,
      maxBlobBytes: 4096,
      headersTimeoutMs: 300,
      requestTimeoutMs: 600,
      bodyTimeoutMs: 300,
      checkIntervalMs: 50,
      heartbeatMs: 100,
      ...options.limits,
    },
  });
  t.after(() => listener.close());
  const { token } = reg.grant(ALL);
  return {
    reg,
    be,
    listener,
    port: listener.port,
    host: `127.0.0.1:${listener.port}`,
    token,
    logs,
  };
}

interface Req {
  method?: string;
  path: string;
  /** Host header; null sends none. Defaults to `127.0.0.1:<port>`. */
  host?: string | null;
  token?: string;
  headers?: [string, string][];
  body?: string;
  /** Content-Type; null sends none. Defaults to JSON when there is a body. */
  type?: string | null;
  version?: string;
}

function build(r: Rig, req: Req): string {
  const lines = [`${req.method ?? 'POST'} ${req.path} HTTP/${req.version ?? '1.1'}`];
  const host = req.host === undefined ? r.host : req.host;
  if (host !== null) lines.push(`Host: ${host}`);
  if (req.token) lines.push(`Authorization: Bearer ${req.token}`);
  const type = req.type === undefined && req.body !== undefined ? 'application/json' : req.type;
  if (type) lines.push(`Content-Type: ${type}`);
  if (req.body !== undefined) lines.push(`Content-Length: ${Buffer.byteLength(req.body)}`);
  for (const [name, value] of req.headers ?? []) lines.push(`${name}: ${value}`);
  lines.push('Connection: close');
  return `${lines.join('\r\n')}\r\n\r\n${req.body ?? ''}`;
}

interface Res {
  status: number;
  headers: Map<string, string[]>;
  body: string;
  raw: string;
}

function parse(raw: string): Res {
  const split = raw.indexOf('\r\n\r\n');
  const head = raw.slice(0, split).split('\r\n');
  const status = Number(head[0].split(' ')[1]);
  const headers = new Map<string, string[]>();
  for (const line of head.slice(1)) {
    const at = line.indexOf(':');
    const name = line.slice(0, at).toLowerCase();
    headers.set(name, [...(headers.get(name) ?? []), line.slice(at + 1).trim()]);
  }
  return { status, headers, body: raw.slice(split + 4), raw };
}

async function send(r: Rig, req: Req | string): Promise<Res> {
  const c = await rawConnect({ port: r.port });
  c.socket.write(typeof req === 'string' ? req : build(r, req));
  await c.closed(3_000);
  return parse(c.text());
}

const get = (r: Rig, path: string, extra: Partial<Req> = {}) =>
  send(r, { method: 'GET', path, token: r.token, ...extra });
const post = (r: Rig, method: string, args: unknown = {}, extra: Partial<Req> = {}) =>
  send(r, { path: `/v1/call/${method}`, token: r.token, body: JSON.stringify(args), ...extra });

const errorType = (res: Res) => (JSON.parse(res.body) as { error: { type: string } }).error.type;

function assertNoCors(res: Res) {
  for (const name of res.headers.keys()) assert.doesNotMatch(name, /^access-control-/);
}

/** The refusal shape: the status, no CORS, and nothing entered the backend. */
function assertRefused(r: Rig, res: Res, status: number) {
  assert.equal(res.status, status, res.raw.slice(0, 200));
  assertNoCors(res);
  assert.deepEqual(r.be.entered, []);
}

test('control: a good call reaches the backend with the caller from the stored client', async t => {
  const r = await rig(t);
  const res = await post(r, 'Thread/get', { ids: ['t1'] });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { method: 'Thread/get' });
  const [record] = r.be.calls;
  assert.equal(record.caller.via, 'http');
  assert.equal(record.caller.clientId, 'client-1');
  assert.deepEqual(record.args, { ids: ['t1'] });
});

test('every response carries no-store, nosniff, no-referrer and a fixed Content-Type, and no CORS', async t => {
  const r = await rig(t);
  const responses = [
    await post(r, 'Thread/get', { ids: ['t1'] }),
    await post(r, 'Thread/get', {}, { token: undefined }),
    await get(r, '/v1/openapi.json'),
    await get(r, '/nope'),
  ];
  for (const res of responses) {
    assert.deepEqual(res.headers.get('cache-control'), ['no-store']);
    assert.deepEqual(res.headers.get('x-content-type-options'), ['nosniff']);
    assert.deepEqual(res.headers.get('referrer-policy'), ['no-referrer']);
    assertNoCors(res);
  }
  assert.deepEqual(responses[0].headers.get('content-type'), ['application/json; charset=utf-8']);
  assert.deepEqual(responses[2].headers.get('content-type'), ['application/json; charset=utf-8']);
});

test('no token: 401, nothing executed', async t => {
  const r = await rig(t);
  const res = await post(r, 'Thread/get', { ids: ['t1'] }, { token: undefined });
  assertRefused(r, res, 401);
  assert.deepEqual(JSON.parse(res.body), { error: { type: 'forbidden', message: AUTH_REFUSED } });
});

test('a wrong token, a malformed header, a query-string token and a cookie token all get the same 401', async t => {
  const r = await rig(t);
  const noToken = await post(r, 'Thread/get', {}, { token: undefined });
  const variants: Partial<Req>[] = [
    { token: 'A'.repeat(43) },
    { token: undefined, headers: [['Authorization', `Basic ${r.token}`]] },
    { token: undefined, headers: [['Authorization', `bearer ${r.token}`]] },
    { token: undefined, headers: [['Authorization', `Bearer  ${r.token}`]] },
    { token: undefined, headers: [['Cookie', `token=${r.token}`]] },
    { token: r.token, headers: [['Authorization', `Bearer ${r.token}`]] }, // two Authorization headers
  ];
  for (const variant of variants) {
    const res = await post(r, 'Thread/get', {}, variant);
    assertRefused(r, res, 401);
    assert.equal(res.body, noToken.body);
  }
  const query = await send(r, { path: `/v1/call/Thread/get?token=${r.token}`, body: '{}' });
  assert.equal(query.status, 404, 'a query string is never a route, let alone a token');
  assert.deepEqual(r.be.entered, []);
});

test('a revoked token: 401, nothing executed', async t => {
  const r = await rig(t);
  const grant = r.reg.grant(['read']);
  r.reg.revoke(grant.id);
  assertRefused(r, await post(r, 'Thread/get', { ids: ['t1'] }, { token: grant.token }), 401);
});

test('wrong Host values get 421 with no body, even with a good token', async t => {
  const r = await rig(t);
  const hosts = [
    'evil.com',
    `evil.com:${r.port}`,
    `127.0.0.1.evil.com:${r.port}`,
    `localhost:${r.port + 1}`,
    `127.0.0.1:${r.port + 1}`,
    '127.0.0.1',
    'localhost',
    '',
    `[::1]:${r.port}`,
    `LOCALHOST:${r.port}`,
    `0.0.0.0:${r.port}`,
    `127.0.0.1:${r.port}, evil.com`,
    `127.0.0.1:${r.port}.`,
  ];
  for (const host of hosts) {
    const res = await post(r, 'Thread/get', { ids: ['t1'] }, { host });
    assertRefused(r, res, 421);
    assert.equal(res.body, '');
  }
});

test('DNS rebinding: an attacker hostname resolving to 127.0.0.1 is refused with and without a token', async t => {
  const r = await rig(t);
  for (const token of [undefined, r.token]) {
    for (const path of ['/v1/call/Thread/get', '/v1/events', '/v1/openapi.json']) {
      const method = path.includes('call') ? 'POST' : 'GET';
      const body = method === 'POST' ? '{}' : undefined;
      const res = await send(r, {
        method,
        path,
        token,
        body,
        host: `rebind.attacker.example:${r.port}`,
      });
      assertRefused(r, res, 421);
    }
  }
});

test('a missing Host (HTTP/1.0) gets 421', async t => {
  const r = await rig(t);
  const res = await post(r, 'Thread/get', {}, { host: null, version: '1.0' });
  assertRefused(r, res, 421);
});

test('duplicate Host headers get 421 (Node would otherwise keep only the first)', async t => {
  const r = await rig(t);
  for (const second of [r.host, 'evil.com', `localhost:${r.port}`]) {
    const res = await post(r, 'Thread/get', {}, { headers: [['Host', second]] });
    assertRefused(r, res, 421);
  }
  const folded = await post(
    r,
    'Thread/get',
    {},
    {
      host: null,
      headers: [
        ['host', r.host],
        ['HOST', r.host],
      ],
    },
  );
  assertRefused(r, folded, 421);
});

test('a wrong, null, foreign or duplicate Origin gets 403', async t => {
  const r = await rig(t);
  const origins = [
    'https://evil.com',
    'null',
    `http://127.0.0.1:${r.port}`,
    `http://localhost:${r.port}`,
    'file://',
    '',
  ];
  for (const origin of origins) {
    const res = await post(r, 'Thread/get', {}, { headers: [['Origin', origin]] });
    assertRefused(r, res, 403);
  }
});

test('a configured origin passes exactly; near misses and duplicates do not', async t => {
  const r = await rig(t, { allowedOrigins: ['http://localhost:5173'] });
  const ok = await post(
    r,
    'Thread/get',
    { ids: ['t1'] },
    { headers: [['Origin', 'http://localhost:5173']] },
  );
  assert.equal(ok.status, 200);
  assertNoCors(ok);
  r.be.entered.length = 0;
  for (const origin of [
    'http://localhost:5173/',
    'http://localhost:51730',
    'https://localhost:5173',
    'http://LOCALHOST:5173',
  ]) {
    const res = await post(r, 'Thread/get', {}, { headers: [['Origin', origin]] });
    assertRefused(r, res, 403);
  }
  const twice = await post(
    r,
    'Thread/get',
    {},
    {
      headers: [
        ['Origin', 'http://localhost:5173'],
        ['Origin', 'http://localhost:5173'],
      ],
    },
  );
  assertRefused(r, twice, 403);
  await assert.rejects(
    startHttpListener({
      port: 0,
      registry: r.reg.registry,
      backend: r.be.backend,
      allowedOrigins: ['*'],
    }),
  );
  await assert.rejects(
    startHttpListener({
      port: 0,
      registry: r.reg.registry,
      backend: r.be.backend,
      allowedOrigins: ['null'],
    }),
  );
});

test('a hostile OPTIONS preflight gets 405, no CORS headers, and runs nothing', async t => {
  const r = await rig(t, { allowedOrigins: ['http://localhost:5173'] });
  const preflight: [string, string][] = [
    ['Access-Control-Request-Method', 'POST'],
    ['Access-Control-Request-Headers', 'authorization, content-type'],
  ];
  for (const origin of ['https://evil.com', 'http://localhost:5173']) {
    for (const path of ['/v1/call/Submission/set', '/v1/events', '/v1/blob', '/v1/blob/abc', '*']) {
      const res = await send(r, {
        method: 'OPTIONS',
        path,
        token: r.token,
        headers: [['Origin', origin], ...preflight],
      });
      assert.ok([403, 405].includes(res.status), `${origin} ${path}: ${res.status}`);
      assertRefused(r, res, res.status);
    }
  }
  const plain = await send(r, { method: 'OPTIONS', path: '/v1/call/Thread/get', token: r.token });
  assertRefused(r, plain, 405);
});

test('blob path traversal and odd ids are 404 with nothing read', async t => {
  const r = await rig(t);
  const paths = [
    '/v1/blob/../..',
    '/v1/blob/..',
    '/v1/blob/.',
    '/v1/blob/../../etc/passwd',
    '/v1/blob/%2e%2e',
    '/v1/blob/%2e%2e%2fsecret',
    '/v1/blob/a%2fb',
    '/v1/blob/a%2Fb',
    '/v1/blob/%252e%252e',
    '/v1/blob/a\\..\\b',
    '/v1/blob/..%5c..',
    '/v1/blob/a%00b',
    '/v1/blob/%c0%ae%c0%ae',
    '/v1/blob//abc',
    '/v1/blob/abc/',
    '/v1/blob/abc/def',
    `/v1/blob/${'a'.repeat(257)}`,
    `/v1/blob/${'a'.repeat(3000)}`,
    '/v1/blob/a.b',
    '/v1/blob/abc?x=1',
    '/v1/blob/abc#frag',
    '/./v1/blob/abc',
    '/v1/./blob/abc',
    '/v1/x/../blob/abc',
    'http://evil.com/v1/blob/abc',
    `http://127.0.0.1:${0}/v1/blob/abc`,
  ];
  for (const path of paths) {
    const res = await get(r, path);
    assert.ok([400, 404, 421].includes(res.status), `${path}: ${res.status}`);
    assertRefused(r, res, res.status);
  }
  const nul = await send(
    r,
    `GET /v1/blob/a\0b HTTP/1.1\r\nHost: ${r.host}\r\nAuthorization: Bearer ${r.token}\r\n\r\n`,
  );
  assert.ok([400, 404].includes(nul.status));
  assert.deepEqual(r.be.entered, []);
});

test('unknown routes are 404 with no detail', async t => {
  const r = await rig(t);
  const paths = [
    '/',
    '/v1',
    '/v1/',
    '/v1/call',
    '/v1/call/Thread',
    '/v1/call/thread/get',
    '/v1/call/Thread/Get',
    '/v1/call/Thread/get/extra',
    '/v1/call/__proto__/constructor',
    '/v1/call/Object/toString',
    '/api/invoke',
    '/v2/call/Thread/get',
  ];
  for (const path of paths) {
    const method = path.startsWith('/v1/call/') ? 'POST' : 'GET';
    const res = await send(r, {
      method,
      path,
      token: r.token,
      body: method === 'POST' ? '{}' : undefined,
    });
    assert.equal(res.status, 404, path);
    if (path !== '/v1/call/Object/toString') assert.equal(res.body, '', path);
  }
  assert.deepEqual(r.be.entered, []);
});

test('an oversized body declared by Content-Length is 413 before it is read', async t => {
  const r = await rig(t);
  const head = `POST /v1/call/Thread/get HTTP/1.1\r\nHost: ${r.host}\r\nAuthorization: Bearer ${r.token}\r\nContent-Type: application/json\r\nContent-Length: 5000000\r\n\r\n`;
  const c = await rawConnect({ port: r.port });
  c.socket.write(head);
  await c.waitFor(text => text.includes('\r\n\r\n'));
  const res = parse(c.text());
  assertRefused(r, res, 413);
  assert.equal(errorType(res), 'tooLarge');
});

test('an oversized chunked body is 413 once it passes the cap', async t => {
  const r = await rig(t);
  const chunk = (data: string) => `${Buffer.byteLength(data).toString(16)}\r\n${data}\r\n`;
  const body = chunk(`{"ids":["${'x'.repeat(600)}`) + chunk(`${'y'.repeat(600)}"]}`) + '0\r\n\r\n';
  const res = await send(
    r,
    `POST /v1/call/Thread/get HTTP/1.1\r\nHost: ${r.host}\r\nAuthorization: Bearer ${r.token}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n${body}`,
  );
  assertRefused(r, res, 413);
});

test('an oversized blob upload is 413', async t => {
  const r = await rig(t);
  const res = await send(r, {
    method: 'PUT',
    path: '/v1/blob',
    token: r.token,
    type: 'image/png',
    body: 'z'.repeat(5000),
  });
  assertRefused(r, res, 413);
});

test('malformed JSON is 400 validation and the input is not echoed', async t => {
  const r = await rig(t);
  for (const body of ['{"ids": [canary-x9', '[1,2]', '"text"', '42', 'null']) {
    const res = await send(r, { path: '/v1/call/Thread/get', token: r.token, body });
    assertRefused(r, res, 400);
    assert.equal(errorType(res), 'validation');
    assert.doesNotMatch(res.body, /canary|\[1,2\]/);
  }
});

test('a call without application/json is 415', async t => {
  const r = await rig(t);
  const types: (string | null)[] = [
    'text/plain',
    'application/x-www-form-urlencoded',
    'multipart/form-data; boundary=x',
    'application/json; charset=latin1',
    'application/jsonx',
    null,
  ];
  for (const type of types) {
    const res = await send(r, { path: '/v1/call/Thread/get', token: r.token, body: '{}', type });
    assertRefused(r, res, 415);
  }
  const ok = await send(r, {
    path: '/v1/call/Thread/get',
    token: r.token,
    body: '{}',
    type: 'application/json; charset=UTF-8',
  });
  assert.equal(ok.status, 200);
});

test('slowloris headers: a client dribbling its header block is cut off at the headers timeout', async t => {
  const r = await rig(t);
  const c = await rawConnect({ port: r.port });
  c.socket.write(`POST /v1/call/Thread/get HTTP/1.1\r\nHost: ${r.host}\r\n`);
  const drip = setInterval(() => c.socket.write('X-Slow: a\r\n'), 50);
  t.after(() => clearInterval(drip));
  const ms = await c.closed(2_000);
  clearInterval(drip);
  assert.ok(ms < 2_000, `closed after ${ms} ms`);
  assert.deepEqual(r.be.entered, []);
});

test('slowloris body: a client dribbling its body is cut off at the body timeout', async t => {
  const r = await rig(t, { requestTimeoutMs: 5_000 });
  const c = await rawConnect({ port: r.port });
  c.socket.write(
    `POST /v1/call/Thread/get HTTP/1.1\r\nHost: ${r.host}\r\nAuthorization: Bearer ${r.token}\r\nContent-Type: application/json\r\nContent-Length: 500\r\n\r\n{`,
  );
  const drip = setInterval(() => !c.isClosed() && c.socket.write(' '), 50);
  t.after(() => clearInterval(drip));
  const ms = await c.closed(2_000);
  clearInterval(drip);
  assert.ok(ms < 2_000, `closed after ${ms} ms`);
  const res = parse(c.text());
  assert.equal(res.status, 408);
  assert.deepEqual(r.be.entered, []);
});

test('an idle connection that never sends a request is closed', async t => {
  const r = await rig(t);
  const c = await rawConnect({ port: r.port });
  const ms = await c.closed(2_000);
  assert.ok(ms < 2_000);
  assert.deepEqual(r.be.entered, []);
});

test('the connection cap closes connections past it', async t => {
  const r = await rig(t, {
    limits: { maxConnections: 3, headersTimeoutMs: 5_000, requestTimeoutMs: 5_000 },
  });
  const held = await Promise.all([1, 2, 3].map(() => rawConnect({ port: r.port })));
  await pause(50);
  const extra = await rawConnect({ port: r.port });
  extra.socket.write(build(r, { path: '/v1/call/Thread/get', token: r.token, body: '{}' }));
  await extra.closed(1_000);
  assert.equal(extra.text(), '');
  assert.ok(held.every(c => !c.isClosed()));
  assert.deepEqual(r.be.entered, []);
  held.forEach(c => c.socket.destroy());
});

test('method confusion: a known route with the wrong method is 405', async t => {
  const r = await rig(t);
  const cases: [string, string][] = [
    ['GET', '/v1/call/Thread/get'],
    ['PUT', '/v1/call/Thread/get'],
    ['POST', '/v1/events'],
    ['POST', '/v1/blob/abc'],
    ['GET', '/v1/blob'],
    ['POST', '/v1/openapi.json'],
    ['DELETE', '/v1/blob/abc'],
    ['HEAD', '/v1/openapi.json'],
    ['TRACE', '/v1/call/Thread/get'],
    ['PATCH', '/v1/call/Thread/get'],
  ];
  for (const [method, path] of cases) {
    const res = await send(r, { method, path, token: r.token });
    assertRefused(r, res, 405);
  }
});

test('secret, uiOnly, host and desktop methods are refused over HTTP and the backend is untouched', async t => {
  const r = await rig(t);
  const methods = [
    'Ai/setKey',
    'Ai/removeKey',
    'Account/connect',
    'Workflow/code',
    'Clients/grant',
    'Clients/list',
    'Listener/set',
    'Consent/grant',
    'Data/export',
    'Mail/frame',
    'Mail/serve',
    'Notification/claim',
    'Shell/open',
    'Ai/pasteKey',
    'Window/compose',
    'Fixture/control',
    'Nope/nope',
    'Blob/get',
    'Blob/put',
  ];
  for (const method of methods) {
    const res = await post(r, method, { opId: 'op-1' });
    assert.ok([403, 404].includes(res.status), `${method}: ${res.status}`);
    assert.match(errorType(res), /^(forbidden|unsupported)$/);
    assertRefused(r, res, res.status);
  }
});

test('a read client calling send, triage and admin methods is forbidden by the contract checkAccess', async t => {
  const r = await rig(t);
  const reader = r.reg.grant(['read']);
  for (const method of ['Submission/set', 'Thread/act', 'Settings/set', 'Draft/set']) {
    const res = await post(r, method, { opId: 'op-1' }, { token: reader.token });
    assertRefused(r, res, 403);
    assert.equal(errorType(res), 'forbidden');
  }
  const allowed = await post(r, 'Thread/get', { ids: ['t1'] }, { token: reader.token });
  assert.equal(allowed.status, 200);
});

test('a draft client can save but not send', async t => {
  const r = await rig(t);
  const drafter = r.reg.grant(['read', 'draft']);
  assert.equal(
    (await post(r, 'Draft/set', { opId: 'op-1' }, { token: drafter.token })).status,
    200,
  );
  const send = await post(r, 'Submission/set', { opId: 'op-2' }, { token: drafter.token });
  assert.equal(send.status, 403);
  assert.deepEqual(r.be.executed, ['Draft/set']);
});

test('a stored MCP client is limited to the MCP tools over HTTP', async t => {
  const r = await rig(t);
  const mcp = r.reg.grant(['read', 'triage', 'draft', 'admin'], 'mcp');
  for (const method of ['Thread/act', 'Draft/destroy', 'Settings/set', 'Queue/retry']) {
    const res = await post(r, method, { opId: 'op-1' }, { token: mcp.token });
    assertRefused(r, res, 403);
  }
  const ok = await post(r, 'Thread/get', { ids: ['t1'] }, { token: mcp.token });
  assert.equal(ok.status, 200);
  assert.equal(r.be.calls[0].caller.via, 'mcp');
});

test('a listener may not set window-only arguments', async t => {
  const r = await rig(t);
  const res = await post(r, 'Settings/set', { opId: 'op-1', patch: { ai: { background: true } } });
  assertRefused(r, res, 403);
});

test('Idempotency-Key becomes the opId; a bad, repeated or disagreeing key is 400', async t => {
  const r = await rig(t);
  const ok = await post(
    r,
    'Thread/act',
    { ids: ['t1'] },
    { headers: [['Idempotency-Key', 'op-abc']] },
  );
  assert.equal(ok.status, 200);
  assert.equal(r.be.calls[0].opId, 'op-abc');
  assert.deepEqual(r.be.calls[0].args, { ids: ['t1'], opId: 'op-abc' });
  const same = await post(
    r,
    'Thread/act',
    { opId: 'op-abc' },
    { headers: [['Idempotency-Key', 'op-abc']] },
  );
  assert.equal(same.status, 200);
  r.be.entered.length = 0;
  const bad: [string, string][][] = [
    [['Idempotency-Key', 'x'.repeat(201)]],
    [['Idempotency-Key', 'has space']],
    [
      ['Idempotency-Key', 'op-1'],
      ['Idempotency-Key', 'op-2'],
    ],
  ];
  for (const headers of bad) assertRefused(r, await post(r, 'Thread/act', {}, { headers }), 400);
  const disagree = await post(
    r,
    'Thread/act',
    { opId: 'op-x' },
    { headers: [['Idempotency-Key', 'op-y']] },
  );
  assertRefused(r, disagree, 400);
});

test('backend errors: a ContractError keeps its body and status; anything else is a bare 500', async t => {
  const r = await rig(t);
  r.be.handlers.set('Thread/get', () => {
    throw new ContractError({ type: 'notFound', message: 'That thread is gone.' });
  });
  r.be.handlers.set('Thread/why', () => {
    throw new Error('stack canary-7f3 at /Users/someone/secret.ts:12 sk-live-abc');
  });
  const notFound = await post(r, 'Thread/get', { ids: ['t1'] });
  assert.equal(notFound.status, 404);
  assert.deepEqual(JSON.parse(notFound.body), {
    error: { type: 'notFound', message: 'That thread is gone.' },
  });
  const boom = await post(r, 'Thread/why', { threadId: 't1' });
  assert.equal(boom.status, 500);
  assert.deepEqual(JSON.parse(boom.body), {
    error: { type: 'internal', message: 'Something went wrong. Try again.' },
  });
  assert.doesNotMatch(boom.raw, /canary|secret|sk-live/);
  assert.equal(statusForError('forbidden'), 403);
  assert.equal(statusForError('__proto__'), 500);
  assert.equal(statusForError('somethingNew'), 500);
});

test('the token never appears in a response or the log', async t => {
  const r = await rig(t);
  const revoked = r.reg.grant(['read']);
  r.reg.revoke(revoked.id);
  const texts = [
    (await post(r, 'Thread/get', { ids: ['t1'] })).raw,
    (await post(r, 'Thread/get', {}, { token: revoked.token })).raw,
    (await post(r, 'Ai/setKey', { key: r.token })).raw,
    (await send(r, { path: '/v1/call/Thread/get', token: r.token, body: `{"${r.token}` })).raw,
    (await post(r, 'Thread/get', {}, { host: 'evil.com' })).raw,
  ];
  for (const text of [...texts, ...r.logs]) {
    assert.ok(!text.includes(r.token));
    assert.ok(!text.includes(revoked.token));
  }
});

async function openEvents(r: Rig, token: string, headers: [string, string][] = []) {
  const c = await rawConnect({ port: r.port });
  const extra = headers.map(([name, value]) => `${name}: ${value}\r\n`).join('');
  c.socket.write(
    `GET /v1/events HTTP/1.1\r\nHost: ${r.host}\r\nAuthorization: Bearer ${token}\r\n${extra}\r\n`,
  );
  await c.waitFor(text => text.includes(': open'));
  return c;
}

test('SSE: frames carry id: <seq>, Last-Event-ID resumes, reset is an event, heartbeats flow', async t => {
  const r = await rig(t);
  const c = await openEvents(r, r.token, [['Last-Event-ID', '41']]);
  assert.match(c.text(), /content-type: text\/event-stream/i);
  assert.match(c.text(), /cache-control: no-store/i);
  assert.deepEqual(r.be.subscriptions[0].since, { dbEpoch: DB_EPOCH, seq: 41 });
  r.be.emit(stateFrame(42));
  await c.waitFor(text => text.includes('id: 42\nevent: state\ndata: '));
  r.be.reset({ frame: 'reset', dbEpoch: DB_EPOCH, seq: 43, reason: 'cannotCalculateChanges' });
  await c.waitFor(text => text.includes('event: reset'));
  await c.waitFor(text => text.includes(': hb'));
  const data = c.text().match(/data: (.*)\n/)?.[1];
  assert.deepEqual(JSON.parse(data ?? 'null'), stateFrame(42));
});

test('SSE: a bad or repeated Last-Event-ID is 400; a client without read is 403', async t => {
  const r = await rig(t);
  for (const value of ['abc', '-1', '1e3', '9'.repeat(16)]) {
    const res = await get(r, '/v1/events', { headers: [['Last-Event-ID', value]] });
    assertRefused(r, res, 400);
  }
  const twice = await get(r, '/v1/events', {
    headers: [
      ['Last-Event-ID', '1'],
      ['Last-Event-ID', '2'],
    ],
  });
  assertRefused(r, twice, 400);
  const sender = r.reg.grant(['send']);
  assertRefused(r, await get(r, '/v1/events', { token: sender.token }), 403);
});

test('revoking a client ends its SSE stream within 1 s and no frame follows', async t => {
  const r = await rig(t, { limits: { heartbeatMs: 60_000 } });
  const grant = r.reg.grant(['read']);
  const c = await openEvents(r, grant.token);
  const kept = await openEvents(r, r.token);
  r.be.emit(stateFrame(1));
  await c.waitFor(text => text.includes('id: 1\n'));
  const before = Date.now();
  r.reg.revoke(grant.id);
  await c.closed(1_000);
  assert.ok(Date.now() - before < 1_000);
  const seen = c.text();
  r.be.emit(stateFrame(2));
  await kept.waitFor(text => text.includes('id: 2\n'));
  assert.equal(c.text(), seen);
  assert.equal(r.be.subscribers(), 1);
  assertRefused(
    { ...r, be: { ...r.be, entered: [] } },
    await get(r, '/v1/events', { token: grant.token }),
    401,
  );
});

test('blobs: put then get round trip as octet-stream; another client gets 404', async t => {
  const r = await rig(t);
  const put = await send(r, {
    method: 'PUT',
    path: '/v1/blob',
    token: r.token,
    type: 'text/html',
    body: '<b>hi</b>',
  });
  assert.equal(put.status, 200);
  const { blobId, size } = JSON.parse(put.body) as { blobId: string; size: number };
  assert.equal(size, 9);
  const got = await get(r, `/v1/blob/${blobId}`);
  assert.equal(got.status, 200);
  assert.equal(got.body, '<b>hi</b>');
  assert.deepEqual(got.headers.get('content-type'), ['application/octet-stream']);
  assert.deepEqual(got.headers.get('content-disposition'), ['attachment']);
  assert.deepEqual(got.headers.get('x-aplos-blob-mime'), ['text/html']);
  const other = r.reg.grant(['read']);
  const foreign = await get(r, `/v1/blob/${blobId}`, { token: other.token });
  assert.equal(foreign.status, 404);
  const noScope = r.reg.grant(['read']);
  const upload = await send(r, {
    method: 'PUT',
    path: '/v1/blob',
    token: noScope.token,
    type: 'text/plain',
    body: 'x',
  });
  assert.equal(upload.status, 403);
  const badType = await send(r, {
    method: 'PUT',
    path: '/v1/blob',
    token: r.token,
    type: 'text/plain\u0000',
    body: 'x',
  });
  assert.ok([400, 415].includes(badType.status));
});

test('OpenAPI is served to an authenticated client only', async t => {
  const r = await rig(t);
  const res = await get(r, '/v1/openapi.json');
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { openapi: '3.1.0' });
  r.be.entered.length = 0;
  assertRefused(r, await get(r, '/v1/openapi.json', { token: undefined }), 401);
});

test('the listener binds 127.0.0.1 only', async t => {
  const r = await rig(t);
  const ipv6 = await new Promise<string>(resolve => {
    const socket = connect({ host: '::1', port: r.port });
    socket.once('connect', () => {
      socket.destroy();
      resolve('connected');
    });
    socket.once('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? 'error'));
  });
  assert.notEqual(ipv6, 'connected');
  assert.deepEqual(r.listener.describe(), { port: r.port });
});

test('close unbinds the port and drops open streams', async t => {
  const r = await rig(t);
  const c = await openEvents(r, r.token);
  await r.listener.close();
  await c.closed(1_000);
  await assert.rejects(rawConnect({ port: r.port }));
});
