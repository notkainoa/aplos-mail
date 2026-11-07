import {
  AiCallError,
  type AiChatRequest,
  type AiChatTurn,
  type AiChatMessage,
} from '@aplos/engine';
import { asObj, callProvider, cancelled, readSse, type AiDeps } from './request';
import type { AiKeys } from './keys';
import type { ProviderRow } from './providers';

/**
 * Claude's Messages API — not OpenAI-compatible, so this maps `AiChatMessage[]` onto it: system messages become
 * the top-level `system` parameter, assistant tool calls become `tool_use` blocks, and tool results become
 * `tool_result` blocks on a user turn. Auth is `x-api-key` + `anthropic-version` (set in `callProvider` for the
 * `anthropic` wire); `max_tokens` is required, so an unset budget answers 1024. Requests stream SSE;
 * `input_tokens` arrives on `message_start`, `output_tokens` on `message_delta`. There is no JSON mode —
 * `json: true` is left out rather than approximated.
 */

type Block = Record<string, unknown>;

/**
 * The wire's `{system, messages}`. Claude needs alternating user/assistant turns, so consecutive same-role
 * messages merge their content blocks (tool results especially, which ride as user blocks).
 */
function toClaude(messages: AiChatMessage[]): { system: string; messages: Block[] } {
  const system: string[] = [];
  const out: { role: 'user' | 'assistant'; content: Block[] }[] = [];
  const push = (role: 'user' | 'assistant', content: Block[]) => {
    const last = out.at(-1);
    if (last && last.role === role) last.content.push(...content);
    else out.push({ role, content });
  };
  for (const message of messages) {
    if (message.role === 'system') {
      // The first system message is the prompt; later loop notes ("answer now") ride along as user text.
      if (!out.length) system.push(message.content);
      else push('user', [{ type: 'text', text: `(Note from Aplos: ${message.content})` }]);
    } else if (message.role === 'user') {
      push('user', [{ type: 'text', text: message.content || ' ' }]);
    } else if (message.role === 'assistant') {
      const blocks: Block[] = [];
      if (message.content) blocks.push({ type: 'text', text: message.content });
      for (const call of message.toolCalls ?? []) {
        let input: unknown = {};
        try {
          input = JSON.parse(call.arguments || '{}');
        } catch {
          /* An unreadable call is replayed with no arguments. */
        }
        blocks.push({ type: 'tool_use', id: call.id, name: call.name, input });
      }
      if (blocks.length) push('assistant', blocks);
    } else if (message.role === 'tool') {
      push('user', [
        { type: 'tool_result', tool_use_id: message.toolCallId, content: message.content },
      ]);
    }
  }
  return { system: system.join('\n\n'), messages: out };
}

/** One streamed `messages` call. Rejects with `AiCallError`, already classified. */
export async function anthropicChat(
  deps: AiDeps,
  keys: AiKeys,
  row: ProviderRow,
  req: AiChatRequest,
): Promise<AiChatTurn> {
  const { system, messages } = toClaude(req.messages);
  // Anthropic has no JSON mode: an assistant prefill of `{` forces the object shape; the streamed
  // content continues it, so the caller's parse sees the same JSON OpenAI would have sent.
  const body = {
    model: req.model.model,
    max_tokens: req.maxTokens ?? 1024,
    stream: true,
    ...(system ? { system } : {}),
    messages: req.json ? [...messages, { role: 'assistant' as const, content: '{' }] : messages,
    ...(req.tools?.length
      ? {
          tools: req.tools.map(tool => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.parameters,
          })),
          tool_choice: { type: req.toolChoice === 'none' ? 'none' : 'auto' },
        }
      : {}),
  };
  const response = await callProvider(deps, keys, row, 'messages', {
    body: JSON.stringify(body),
    signal: req.signal,
  });
  if (!response.body)
    throw new AiCallError('invalid', `${row.label} returned an invalid response.`);
  const out = await readMessageStream(response.body, row, req);
  return req.json ? { ...out, content: '{' + out.content } : out;
}

type ContentBlock = { type: 'text' } | { type: 'tool'; id: string; name: string; json: string };

/** Reads Anthropic's SSE events into a `AiChatTurn`; a truncated tool call (`max_tokens`) is not run. */
async function readMessageStream(
  body: ReadableStream<Uint8Array>,
  row: ProviderRow,
  req: AiChatRequest,
): Promise<AiChatTurn> {
  let content = '';
  let finishReason: string | undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  const blocks: ContentBlock[] = [];
  const onStart = (event: Record<string, unknown>, index: number) => {
    const block = asObj(event.content_block);
    blocks[index] =
      block?.type === 'tool_use'
        ? { type: 'tool', id: String(block.id ?? ''), name: String(block.name ?? ''), json: '' }
        : { type: 'text' };
  };
  const onDelta = (event: Record<string, unknown>, index: number) => {
    const delta = asObj(event.delta);
    const block = blocks[index];
    if (delta?.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
      content += delta.text;
      req.onText?.(delta.text);
    } else if (
      delta?.type === 'input_json_delta' &&
      typeof delta.partial_json === 'string' &&
      block?.type === 'tool'
    )
      block.json += delta.partial_json;
  };
  const onData = (event: Record<string, unknown>) => {
    const index = typeof event.index === 'number' ? event.index : blocks.length;
    if (event.type === 'message_start') {
      const counted = asObj(asObj(event.message)?.usage);
      if (typeof counted?.input_tokens === 'number') inputTokens = counted.input_tokens;
      if (typeof counted?.output_tokens === 'number') outputTokens = counted.output_tokens;
    } else if (event.type === 'content_block_start') onStart(event, index);
    else if (event.type === 'content_block_delta') onDelta(event, index);
    else if (event.type === 'message_delta') {
      const delta = asObj(event.delta);
      if (typeof delta?.stop_reason === 'string') finishReason = delta.stop_reason;
      const counted = asObj(event.usage);
      if (typeof counted?.output_tokens === 'number') outputTokens = counted.output_tokens;
    } else if (event.type === 'error')
      throw new AiCallError('unreachable', `${row.label} stopped while answering.`);
  };
  try {
    await readSse(body, onData, req.signal);
  } catch (error) {
    if (req.signal?.aborted) throw cancelled();
    if (error instanceof AiCallError) throw error;
    throw new AiCallError('unreachable', `${row.label} stopped while answering.`);
  }
  // A tool call cut off by the output limit may be incomplete, so it is not run.
  const truncated = finishReason === 'max_tokens';
  return {
    content,
    toolCalls: truncated
      ? []
      : blocks
          .filter(
            (block): block is Extract<ContentBlock, { type: 'tool' }> => block?.type === 'tool',
          )
          .filter(block => block.name)
          .map(block => ({
            id: block.id,
            name: block.name,
            arguments: block.json || '{}',
          })),
    ...(finishReason ? { finishReason } : {}),
    ...(inputTokens || outputTokens
      ? { usage: { prompt: inputTokens, completion: outputTokens } }
      : {}),
  };
}
