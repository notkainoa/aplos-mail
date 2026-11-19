// Temporary home: these move next to the shared provider code when the engine restructure lands.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createHttpClient,
  HttpFailure,
} from '../../../apps/desktop/src/host/providers/shared/http';
import { FakeClock } from '../../emulators/src/kit/clock';

type Call = { url: string; init: RequestInit };

function recorder(handler: (call: Call) => Promise<Response> | Response) {
  const calls: Call[] = [];
  const fetchFake = (async (url: string | URL, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { calls, fetchFake };
}

const UA = 'AplosMail/0.3 (gzip)';
const neverSettles = ({ init }: Call) =>
  new Promise<Response>((_, reject) => {
    init.signal!.addEventListener(
      'abort',
      () => reject(new DOMException('aborted', 'AbortError')),
      { once: true },
    );
  });

test('one request is exactly one fetch, with gzip headers, body and Retry-After', async () => {
  const clock = new FakeClock({ auto: false });
  const { calls, fetchFake } = recorder(
    () => new Response('{"a":1}', { status: 429, headers: { 'Retry-After': '90' } }),
  );
  const http = createHttpClient({ fetch: fetchFake, clock, userAgent: UA, timeoutMs: 10_000 });
  const res = await http.request('https://example.invalid/x', {
    method: 'POST',
    headers: { Authorization: 'Bearer t' },
    body: 'b',
  });
  assert.equal(calls.length, 1);
  assert.equal(res.status, 429);
  assert.equal(res.ok, false);
  assert.deepEqual(res.json(), { a: 1 });
  assert.equal(res.text(), '{"a":1}');
  assert.equal(res.retryAfterMs, 90_000);
  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.get('user-agent'), UA);
  assert.match(headers.get('user-agent')!, /gzip/);
  assert.equal(headers.get('accept-encoding'), 'gzip');
  assert.equal(headers.get('authorization'), 'Bearer t');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(clock.pending, 0, 'timeout timer is cancelled after the call');
});

test('a user agent without gzip gets it appended; a 5xx is a response, not a retry', async () => {
  const clock = new FakeClock({ auto: false });
  const { calls, fetchFake } = recorder(() => new Response('', { status: 503 }));
  const http = createHttpClient({ fetch: fetchFake, clock, userAgent: 'AplosMail/0.3' });
  const res = await http.request('https://example.invalid/x');
  assert.equal(res.status, 503);
  assert.equal(res.retryAfterMs, undefined);
  assert.equal(calls.length, 1);
  assert.equal(new Headers(calls[0].init.headers).get('user-agent'), 'AplosMail/0.3 (gzip)');
});

test('Retry-After as an HTTP-date is measured on the injected clock', async () => {
  const clock = new FakeClock({ auto: false });
  const date = new Date(clock.now() + 45_000).toUTCString();
  const { fetchFake } = recorder(
    () => new Response('', { status: 429, headers: { 'Retry-After': date } }),
  );
  const res = await createHttpClient({ fetch: fetchFake, clock, userAgent: UA }).request(
    'https://example.invalid/x',
  );
  assert.ok(res.retryAfterMs! > 44_000 && res.retryAfterMs! <= 45_000);
});

test('timeout on the fake clock: timeout, written true, one fetch, no retry', async () => {
  const clock = new FakeClock(); // auto: jumps when everything is waiting on the clock
  const { calls, fetchFake } = recorder(neverSettles);
  const http = createHttpClient({ fetch: fetchFake, clock, userAgent: UA, timeoutMs: 20_000 });
  const start = clock.now();
  await assert.rejects(
    http.request('https://example.invalid/x'),
    (e: unknown) => e instanceof HttpFailure && e.kind === 'timeout' && e.written === true,
  );
  assert.equal(clock.now() - start, 20_000);
  assert.equal(calls.length, 1);
});

test('the caller can abort: aborted, written true', async () => {
  const clock = new FakeClock({ auto: false });
  const { calls, fetchFake } = recorder(neverSettles);
  const http = createHttpClient({ fetch: fetchFake, clock, userAgent: UA });
  const controller = new AbortController();
  const pending = http.request('https://example.invalid/x', { signal: controller.signal });
  controller.abort();
  await assert.rejects(
    pending,
    (e: unknown) => e instanceof HttpFailure && e.kind === 'aborted' && e.written === true,
  );
  assert.equal(calls.length, 1);
  assert.equal(clock.pending, 0);
});

test('already aborted: no fetch at all, written false', async () => {
  const clock = new FakeClock({ auto: false });
  const { calls, fetchFake } = recorder(() => new Response('x'));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    createHttpClient({ fetch: fetchFake, clock, userAgent: UA }).request(
      'https://example.invalid/x',
      { signal: controller.signal },
    ),
    (e: unknown) => e instanceof HttpFailure && e.kind === 'aborted' && e.written === false,
  );
  assert.equal(calls.length, 0);
});

test('network errors: pre-connection failures are written false, a reset is written true', async () => {
  const clock = new FakeClock({ auto: false });
  const failWith = (code: string | undefined) => {
    const cause = Object.assign(new Error('boom'), code ? { code } : {});
    const { calls, fetchFake } = recorder(() => {
      throw new TypeError('fetch failed', { cause });
    });
    return { calls, http: createHttpClient({ fetch: fetchFake, clock, userAgent: UA }) };
  };
  for (const [code, written] of [
    ['ENOTFOUND', false],
    ['ECONNREFUSED', false],
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', false],
    ['ECONNRESET', true],
    ['UND_ERR_SOCKET', true],
    ['EPIPE', true],
    [undefined, true],
  ] as const) {
    const { calls, http } = failWith(code);
    await assert.rejects(
      http.request('https://example.invalid/x'),
      (e: unknown) => e instanceof HttpFailure && e.kind === 'network' && e.written === written,
      String(code),
    );
    assert.equal(calls.length, 1);
  }
});

test('a body that fails mid-read counts as written, and failures carry no url or header', async () => {
  const clock = new FakeClock({ auto: false });
  const stream = new ReadableStream({
    start(c) {
      c.error(Object.assign(new Error('x'), { code: 'ECONNRESET' }));
    },
  });
  const { fetchFake } = recorder(() => new Response(stream, { status: 200 }));
  const secretUrl = 'https://example.invalid/secret-path?token=abc';
  await assert.rejects(
    createHttpClient({ fetch: fetchFake, clock, userAgent: UA }).request(secretUrl, {
      headers: { Authorization: 'Bearer secret' },
    }),
    (e: unknown) => {
      assert.ok(e instanceof HttpFailure && e.kind === 'network' && e.written === true);
      assert.ok(!/secret|token/.test(e.message));
      return true;
    },
  );
});
