import {
  AiCallError,
  type AiChatRequest,
  type AiChatTurn,
  type AiChatMessage,
} from '@aplos/engine';
import { asList, asObj, callProvider, cancelled, readSse, type AiDeps } from './request';
import type { AiKeys } from './keys';
import type { ProviderRow } from './providers';

/**
 * The OpenAI-compatible `chat/completions` transport (Groq, OpenAI, Gemini, OpenRouter, OpenCode Go, and any
 * local or custom server). One streamed POST: text deltas go to `onText`, tool calls are assembled by index as
 * their argument fragments arrive, and `usage` is captured when the provider sends it (Groq's `x_groq.usage`
 * too). The Claude wire lives in `anthropic.ts`.
 */

type WireToolCall = { id?: string; name: string; arguments: string };

/** `AiChatMessage` to the wire shape: tool calls become `function` entries, results carry `tool_call_id`. */
function toWire(message: AiChatMessage): Record<string, unknown> {
  if (message.role === 'assistant')
    return {
      role: 'assistant',
      content: message.content,
      ...(message.toolCalls?.length
        ? {
            tool_calls: message.toolCalls.map(call => ({
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: call.arguments },
            })),
          }
        : {}),
    };
  if (message.role === 'tool')
    return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
  return { role: message.role, content: message.content };
}

/** One streamed `chat/completions` call. Rejects with `AiCallError`, already classified. */
export async function openAiChat(
  deps: AiDeps,
  keys: AiKeys,
  row: ProviderRow,
  req: AiChatRequest,
): Promise<AiChatTurn> {
  const body = {
    model: req.model.model,
    messages: req.messages.map(toWire),
    stream: true,
    // OpenAI-family streams carry `usage` only when asked — without it metering (and the daily cap) is blind.
    stream_options: { include_usage: true },
    [row.tokensParam ?? 'max_completion_tokens']: req.maxTokens ?? row.maxTokens ?? 2048,
    ...(req.json ? { response_format: { type: 'json_object' } } : {}),
    ...row.bodyExtras?.(req.model.model),
    ...(req.tools?.length
      ? {
          tools: req.tools.map(tool => ({
            type: 'function',
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            },
          })),
          tool_choice: req.toolChoice ?? 'auto',
        }
      : {}),
  };
  const response = await callProvider(deps, keys, row, 'chat/completions', {
    body: JSON.stringify(body),
    headers: row.requestHeaders?.(req),
    signal: req.signal,
  });
  if (!response.body)
    throw new AiCallError('invalid', `${row.label} returned an invalid response.`);
  return readChatStream(response.body, row, req);
}

/** Reads the OpenAI-style SSE completion into a `AiChatTurn`; `finish_reason` may be absent (Groq omits it). */
async function readChatStream(
  body: ReadableStream<Uint8Array>,
  row: ProviderRow,
  req: AiChatRequest,
): Promise<AiChatTurn> {
  let content = '';
  let finishReason: string | undefined;
  let usage: AiChatTurn['usage'];
  const calls: WireToolCall[] = [];
  const onData = (chunk: Record<string, unknown>) => {
    if (chunk.error ?? asObj(chunk.x_groq)?.error)
      throw new AiCallError('unreachable', `${row.label} stopped while answering.`);
    const counted = asObj(chunk.usage) ?? asObj(asObj(chunk.x_groq)?.usage);
    if (counted && typeof counted.prompt_tokens === 'number')
      usage = {
        prompt: counted.prompt_tokens,
        completion: Number(counted.completion_tokens) || 0,
      };
    const choice = asObj(asList(chunk.choices)[0]);
    if (!choice) return;
    const delta = asObj(choice.delta) ?? {};
    if (typeof delta.content === 'string' && delta.content) {
      content += delta.content;
      req.onText?.(delta.content);
    }
    for (const part of asList(delta.tool_calls)) {
      const piece = asObj(part);
      if (!piece) continue;
      const index = Number.isInteger(piece.index) ? (piece.index as number) : calls.length;
      const call = (calls[index] ??= { name: '', arguments: '' });
      if (typeof piece.id === 'string') call.id = piece.id;
      const fn = asObj(piece.function);
      if (typeof fn?.name === 'string') call.name += fn.name;
      if (typeof fn?.arguments === 'string') call.arguments += fn.arguments;
    }
    if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason;
  };
  try {
    await readSse(body, onData, req.signal);
  } catch (error) {
    if (req.signal?.aborted) throw cancelled();
    if (error instanceof AiCallError) throw error;
    throw new AiCallError('unreachable', `${row.label} stopped while answering.`);
  }
  return {
    content,
    toolCalls: calls
      .filter(call => call && call.name)
      .map((call, i) => ({
        id: call.id ?? `call_${i}`,
        name: call.name,
        arguments: call.arguments,
      })),
    ...(finishReason ? { finishReason } : {}),
    ...(usage ? { usage } : {}),
  };
}
