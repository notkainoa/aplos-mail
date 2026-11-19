import test from 'node:test';
import assert from 'node:assert/strict';
import { bodyJson, headers, sse, stubFetch, testHost } from './rig';

/**
 * The OpenAI-compatible chat transport against a recorded Groq-shaped stream: text deltas, a tool call whose
 * arguments arrive in fragments, and a final usage chunk. The request side is checked too — URL, auth, the
 * message mapping and tool wiring.
 */

const CHUNKS = [
  JSON.stringify({
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'openai/gpt-oss-120b',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'Hel' }, finish_reason: null }],
  }),
  JSON.stringify({
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { content: 'lo' }, finish_reason: null }],
  }),
  JSON.stringify({
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              id: 'call_9',
              type: 'function',
              function: { name: 'mail.search', arguments: '{"q":"' },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  }),
  JSON.stringify({
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [{ index: 0, function: { arguments: 'invoice"}' } }],
        },
        finish_reason: null,
      },
    ],
  }),
  JSON.stringify({
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
  }),
  JSON.stringify({
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    choices: [],
    usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
  }),
  '[DONE]',
];

test('chat streams Groq-shaped SSE into content, tool calls and usage', async () => {
  const { fetch, calls } = stubFetch(() => sse(CHUNKS));
  const host = testHost(fetch, { GROQ_API_KEY: 'gsk_test_1' });
  const deltas: string[] = [];
  const turn = await host.chat({
    model: { provider: 'groq', model: 'openai/gpt-oss-120b' },
    messages: [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Find my invoice.' },
      {
        role: 'assistant',
        content: null,
        toolCalls: [{ id: 'call_1', name: 'mail.search', arguments: '{"q":"a"}' }],
      },
      { role: 'tool', toolCallId: 'call_1', name: 'mail.search', content: '[]' },
    ],
    tools: [
      {
        name: 'mail.search',
        description: 'Search mail.',
        parameters: { type: 'object', properties: { q: { type: 'string' } } },
      },
    ],
    onText: delta => deltas.push(delta),
  });
  assert.deepEqual(deltas, ['Hel', 'lo']);
  assert.equal(turn.content, 'Hello');
  assert.deepEqual(turn.toolCalls, [
    { id: 'call_9', name: 'mail.search', arguments: '{"q":"invoice"}' },
  ]);
  assert.deepEqual(turn.usage, { prompt: 12, completion: 7 });
  assert.equal(turn.finishReason, 'tool_calls');

  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(call.init.method, 'POST');
  assert.equal(headers(call)['Authorization'], 'Bearer gsk_test_1');
  const body = bodyJson(call);
  assert.equal(body.model, 'openai/gpt-oss-120b');
  assert.equal(body.stream, true);
  assert.equal(body.max_completion_tokens, 2048);
  // The gpt-oss row adds a low reasoning effort.
  assert.equal(body.reasoning_effort, 'low');
  assert.deepEqual(body.messages[0], { role: 'system', content: 'You are helpful.' });
  assert.deepEqual(body.messages[2], {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'mail.search', arguments: '{"q":"a"}' },
      },
    ],
  });
  assert.deepEqual(body.messages[3], { role: 'tool', tool_call_id: 'call_1', content: '[]' });
  assert.deepEqual(body.tools, [
    {
      type: 'function',
      function: {
        name: 'mail.search',
        description: 'Search mail.',
        parameters: { type: 'object', properties: { q: { type: 'string' } } },
      },
    },
  ]);
  assert.equal(body.tool_choice, 'auto');
});

test('chat maps toolChoice none and json mode onto the wire', async () => {
  const { fetch, calls } = stubFetch(() => sse(['[DONE]']));
  const host = testHost(fetch, { OPENAI_API_KEY: 'sk_test_1' });
  await host.chat({
    model: { provider: 'openai', model: 'gpt-5-mini' },
    messages: [{ role: 'user', content: 'Answer as JSON.' }],
    tools: [{ name: 'mail.search', description: 'Search mail.', parameters: { type: 'object' } }],
    toolChoice: 'none',
    json: true,
    maxTokens: 64,
  });
  const body = bodyJson(calls[0]);
  assert.equal(body.tool_choice, 'none');
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(body.max_completion_tokens, 64);
});

test('chat sends OpenCode Go its User-Agent and session headers', async () => {
  const { fetch, calls } = stubFetch(() => sse(['[DONE]']));
  const host = testHost(fetch, { OPENCODE_API_KEY: 'oc_test_1' });
  await host.chat({
    model: { provider: 'opencode-go', model: 'kimi-k3' },
    messages: [{ role: 'user', content: 'Hi' }],
    session: 'conv-1',
  });
  assert.equal(calls[0].url, 'https://opencode.ai/inference/go/openai/v1/chat/completions');
  assert.match(headers(calls[0])['User-Agent'] ?? '', /^aplos-mail\//);
  assert.equal(headers(calls[0])['x-opencode-session'], 'conv-1');
  assert.equal(bodyJson(calls[0]).max_completion_tokens, 4096);
});

test('models answers the live list, filtered for chat providers', async () => {
  const { fetch } = stubFetch(
    () =>
      new Response(
        JSON.stringify({
          data: [
            { id: 'gpt-5-mini' },
            { id: 'gpt-4o-mini-transcribe' },
            { id: 'text-embedding-3-small' },
          ],
        }),
        { status: 200 },
      ),
  );
  const host = testHost(fetch, { OPENAI_API_KEY: 'sk_test_1' });
  const result = await host.models('openai');
  assert.equal(result.live, true);
  // The transcribe and embedding models are kept out of the chat list.
  assert.deepEqual(result.list, ['gpt-5-mini']);
});

test('models resolves not-live when the list cannot be answered', async () => {
  const { fetch } = stubFetch(() => {
    throw new TypeError('fetch failed');
  });
  const host = testHost(fetch, { OLLAMA_API_KEY: '' });
  assert.deepEqual(await host.models('ollama'), { list: [], live: false });
});

test('check resolves on a 200 and reports a local server without a key', async () => {
  const { fetch, calls } = stubFetch(() => new Response('{"data":[]}', { status: 200 }));
  const host = testHost(fetch, {});
  await host.check('ollama');
  assert.equal(calls[0].url, 'http://localhost:11434/v1/models');
  assert.equal(headers(calls[0])['Authorization'], undefined);
});
