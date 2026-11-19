import test from 'node:test';
import assert from 'node:assert/strict';
import { bodyJson, headers, sse, stubFetch, testHost } from './rig';

/**
 * The Claude adapter: `AiChatMessage[]` maps onto the Messages API (system → `system`, tool calls →
 * `tool_use`, results → `tool_result` on a user turn), auth is `x-api-key` + `anthropic-version`, and the
 * SSE events decode into content, tool calls and usage.
 */

const EVENTS = [
  JSON.stringify({
    type: 'message_start',
    message: { id: 'msg_1', usage: { input_tokens: 21, output_tokens: 1 } },
  }),
  JSON.stringify({
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  }),
  JSON.stringify({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'Found ' },
  }),
  JSON.stringify({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'it.' },
  }),
  JSON.stringify({ type: 'content_block_stop', index: 0 }),
  JSON.stringify({
    type: 'content_block_start',
    index: 1,
    content_block: { type: 'tool_use', id: 'toolu_1', name: 'mail.search', input: {} },
  }),
  JSON.stringify({
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'input_json_delta', partial_json: '{"q":"inv' },
  }),
  JSON.stringify({
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'input_json_delta', partial_json: 'oice"}' },
  }),
  JSON.stringify({ type: 'content_block_stop', index: 1 }),
  JSON.stringify({
    type: 'message_delta',
    delta: { stop_reason: 'tool_use' },
    usage: { output_tokens: 18 },
  }),
  JSON.stringify({ type: 'message_stop' }),
];

test('anthropic maps messages onto the Messages API shape', async () => {
  const { fetch, calls } = stubFetch(() => sse(EVENTS));
  const host = testHost(fetch, { ANTHROPIC_API_KEY: 'sk_ant_1' });
  const deltas: string[] = [];
  const turn = await host.chat({
    model: { provider: 'anthropic', model: 'claude-haiku-5-5' },
    messages: [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Find my invoice.' },
      {
        role: 'assistant',
        content: null,
        toolCalls: [{ id: 'toolu_0', name: 'mail.search', arguments: '{"q":"a"}' }],
      },
      { role: 'tool', toolCallId: 'toolu_0', name: 'mail.search', content: '[]' },
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

  assert.deepEqual(deltas, ['Found ', 'it.']);
  assert.equal(turn.content, 'Found it.');
  assert.deepEqual(turn.toolCalls, [
    { id: 'toolu_1', name: 'mail.search', arguments: '{"q":"invoice"}' },
  ]);
  assert.deepEqual(turn.usage, { prompt: 21, completion: 18 });
  assert.equal(turn.finishReason, 'tool_use');

  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(headers(call)['x-api-key'], 'sk_ant_1');
  assert.equal(headers(call)['anthropic-version'], '2023-06-01');
  assert.equal(headers(call)['Authorization'], undefined);

  const body = bodyJson(call);
  assert.equal(body.model, 'claude-haiku-5-5');
  assert.equal(body.max_tokens, 1024);
  assert.equal(body.stream, true);
  assert.equal(body.system, 'You are helpful.');
  assert.deepEqual(body.messages, [
    { role: 'user', content: [{ type: 'text', text: 'Find my invoice.' }] },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_0', name: 'mail.search', input: { q: 'a' } }],
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_0', content: '[]' }] },
  ]);
  assert.deepEqual(body.tools, [
    {
      name: 'mail.search',
      description: 'Search mail.',
      input_schema: { type: 'object', properties: { q: { type: 'string' } } },
    },
  ]);
  assert.deepEqual(body.tool_choice, { type: 'auto' });
  // json mode has no Messages-API equivalent, so it is simply not sent.
  assert.equal('response_format' in body, false);
});

test('anthropic merges a late system note into the user turn and honours none', async () => {
  const { fetch, calls } = stubFetch(() => sse([JSON.stringify({ type: 'message_stop' })]));
  const host = testHost(fetch, { ANTHROPIC_API_KEY: 'sk_ant_1' });
  await host.chat({
    model: { provider: 'anthropic', model: 'claude-sonnet-5-5' },
    messages: [
      { role: 'system', content: 'Prompt.' },
      { role: 'user', content: 'Question?' },
      { role: 'system', content: 'Answer now.' },
    ],
    tools: [{ name: 'mail.search', description: 'Search mail.', parameters: { type: 'object' } }],
    toolChoice: 'none',
    maxTokens: 256,
  });
  const body = bodyJson(calls[0]);
  assert.equal(body.max_tokens, 256);
  assert.equal(body.system, 'Prompt.');
  assert.deepEqual(body.messages, [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Question?' },
        { type: 'text', text: '(Note from Aplos: Answer now.)' },
      ],
    },
  ]);
  assert.deepEqual(body.tool_choice, { type: 'none' });
});
