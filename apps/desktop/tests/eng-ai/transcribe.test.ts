import test from 'node:test';
import assert from 'node:assert/strict';
import { stubFetch, testHost } from './rig';

/** Speech-to-text: a multipart POST to `audio/transcriptions`, only on the providers marked `stt`. */

test('transcribe posts the audio as multipart form', async () => {
  const { fetch, calls } = stubFetch(() => new Response('{"text":"hello there"}', { status: 200 }));
  const host = testHost(fetch, { GROQ_API_KEY: 'gsk_test_1' });
  const result = await host.transcribe({
    model: { provider: 'groq', model: 'whisper-large-v3-turbo' },
    audio: new Uint8Array([1, 2, 3]),
    mimeType: 'audio/webm;codecs=opus',
    language: 'en',
  });
  assert.deepEqual(result, { text: 'hello there' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.groq.com/openai/v1/audio/transcriptions');
  assert.equal(calls[0].init.method, 'POST');
  const form = calls[0].init.body;
  assert.ok(form instanceof FormData);
  assert.equal(form.get('model'), 'whisper-large-v3-turbo');
  assert.equal(form.get('language'), 'en');
  const file = form.get('file');
  assert.ok(file instanceof File);
  assert.equal(file.name, 'dictation.webm');
});

test('transcribe is unavailable on providers without speech-to-text', async () => {
  const { fetch, calls } = stubFetch(() => new Response('{}', { status: 200 }));
  const host = testHost(fetch, { GEMINI_API_KEY: 'gm_test_1' });
  await assert.rejects(
    host.transcribe({
      model: { provider: 'gemini', model: 'gemini-flash' },
      audio: new Uint8Array([1]),
      mimeType: 'audio/webm',
    }),
    (e: unknown) => {
      assert.equal((e as { code?: string }).code, 'unavailable');
      return true;
    },
  );
  assert.equal(calls.length, 0);
});

test('transcribe rejects an unsupported audio format', async () => {
  const { fetch, calls } = stubFetch(() => new Response('{}', { status: 200 }));
  const host = testHost(fetch, { OPENAI_API_KEY: 'sk_test_1' });
  await assert.rejects(
    host.transcribe({
      model: { provider: 'openai', model: 'gpt-4o-mini-transcribe' },
      audio: new Uint8Array([1]),
      mimeType: 'audio/aac',
    }),
    (e: unknown) => {
      assert.equal((e as { code?: string }).code, 'invalid');
      return true;
    },
  );
  assert.equal(calls.length, 0);
});
