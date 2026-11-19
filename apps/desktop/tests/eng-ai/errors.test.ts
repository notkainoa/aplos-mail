import test from 'node:test';
import assert from 'node:assert/strict';
import { AiCallError } from '@aplos/engine';
import type { AiChatRequest } from '@aplos/engine';
import { sse, stubFetch, testHost, type RecordedCall } from './rig';

/** Classification of provider and transport failures into `AiCallError` codes. */

const REQ: AiChatRequest = {
  model: { provider: 'groq', model: 'openai/gpt-oss-120b' },
  messages: [{ role: 'user', content: 'Hi' }],
};

const fails = async (promise: Promise<unknown>, code: string) => {
  const error = await promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (e: unknown) => e,
  );
  assert.ok(error instanceof AiCallError, `expected AiCallError, got ${error}`);
  assert.equal(error.code, code);
  return error;
};

test('a missing key fails before any fetch', async () => {
  const { fetch, calls } = stubFetch(() => sse(['[DONE]']));
  const host = testHost(fetch, {});
  await fails(host.chat(REQ), 'missingKey');
  assert.equal(calls.length, 0);
});

test('401 and 403 reject the key', async () => {
  for (const status of [401, 403]) {
    const { fetch } = stubFetch(() => new Response('denied', { status }));
    const host = testHost(fetch, { GROQ_API_KEY: 'gsk_test_1' });
    await fails(host.chat(REQ), 'rejected');
  }
});

test('429 is rate-limited and parses retry-after seconds', async () => {
  const { fetch } = stubFetch(
    () => new Response('slow down', { status: 429, headers: { 'retry-after': '30' } }),
  );
  const host = testHost(fetch, { GROQ_API_KEY: 'gsk_test_1' });
  const error = await fails(host.chat(REQ), 'rateLimited');
  assert.equal(error.retryAfterMs, 30_000);
});

test('429 parses a retry-after HTTP date', async () => {
  const at = new Date(Date.now() + 45_000).toUTCString();
  const { fetch } = stubFetch(
    () => new Response('slow down', { status: 429, headers: { 'retry-after': at } }),
  );
  const host = testHost(fetch, { GROQ_API_KEY: 'gsk_test_1' });
  const error = await fails(host.chat(REQ), 'rateLimited');
  assert.ok(error.retryAfterMs !== undefined && error.retryAfterMs > 0);
  assert.ok(error.retryAfterMs! <= 45_000);
});

test('400, 404 and 422 are invalid; 5xx is unreachable', async () => {
  for (const [status, code] of [
    [400, 'invalid'],
    [404, 'invalid'],
    [422, 'invalid'],
    [500, 'unreachable'],
    [529, 'unreachable'],
  ] as const) {
    const { fetch } = stubFetch(() => new Response('bad', { status }));
    const host = testHost(fetch, { GROQ_API_KEY: 'gsk_test_1' });
    const error = await fails(host.chat(REQ), code);
    // The provider's body never reaches the message; at most the HTTP status does.
    assert.ok(!error.message.includes('bad'));
  }
});

test('a network failure is unreachable', async () => {
  const { fetch } = stubFetch(() => {
    throw new TypeError('fetch failed');
  });
  const host = testHost(fetch, { GROQ_API_KEY: 'gsk_test_1' });
  await fails(host.chat(REQ), 'unreachable');
});

test('an abort during the call is cancelled', async () => {
  const { fetch } = stubFetch(
    (call: RecordedCall) =>
      new Promise<Response>((_, reject) => {
        call.init.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      }),
  );
  const host = testHost(fetch, { GROQ_API_KEY: 'gsk_test_1' });
  const control = new AbortController();
  const pending = host.chat({ ...REQ, signal: control.signal });
  control.abort();
  await fails(pending, 'cancelled');
});

test('an unknown provider id is noProvider', async () => {
  const { fetch } = stubFetch(() => sse(['[DONE]']));
  const host = testHost(fetch, {});
  const request = {
    ...REQ,
    model: { provider: 'not-a-provider', model: 'x' },
  } as unknown as AiChatRequest;
  await fails(host.chat(request), 'noProvider');
});

test('a custom server with no address is unavailable', async () => {
  const { fetch, calls } = stubFetch(() => sse(['[DONE]']));
  const host = testHost(fetch, { CUSTOM_AI_API_KEY: 'sk_test_1' });
  const request: AiChatRequest = {
    model: { provider: 'custom', model: 'my-model' },
    messages: [{ role: 'user', content: 'Hi' }],
  };
  await fails(host.chat(request), 'unavailable');
  assert.equal(calls.length, 0);
});

test('a custom server uses its configured address', async () => {
  const { fetch, calls } = stubFetch(() => sse(['[DONE]']));
  const host = testHost(fetch, {}, { addresses: { custom: 'https://ai.internal.example' } });
  await host.chat({
    model: { provider: 'custom', model: 'my-model' },
    messages: [{ role: 'user', content: 'Hi' }],
  });
  assert.equal(calls[0].url, 'https://ai.internal.example/v1/chat/completions');
});
