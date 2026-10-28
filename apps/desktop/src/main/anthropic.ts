import Anthropic from '@anthropic-ai/sdk';
import type { ChatMessage, ChatRequest, ChatTurn } from '@aplos/engine/legacy/agent';
import type { ChatProvider } from '@aplos/engine/legacy/ports';
import { askProvider, type AskModelInfo } from '@aplos/contract/legacy/ask';
import { missingKey, readKey, redact, rejected, type ApiKey } from './llm';

/**
 * Claude through the official SDK and the Messages API. Ask's loop speaks OpenAI-style messages, so this
 * maps them: tool calls become `tool_use` blocks, tool results one `tool_result` user turn, and each assistant
 * turn Claude wrote is replayed with its own content blocks (thinking included) as the API expects.
 */
/** `apiKey` is a key or a resolver read per request; without one ANTHROPIC_API_KEY is used. */
export interface AnthropicOptions {
  apiKey?: ApiKey;
  fetch?: typeof fetch;
}

type Blocks = Anthropic.ContentBlockParam[];
function toClaude(messages: ChatMessage[]) {
  const system: string[] = [],
    out: Anthropic.MessageParam[] = [];
  const push = (role: 'user' | 'assistant', content: Blocks) => {
    const last = out.at(-1);
    if (last && last.role === role && Array.isArray(last.content))
      (last.content as Blocks).push(...content);
    else out.push({ role, content });
  };
  for (const m of messages) {
    if (m.role === 'system') {
      // The first system message is the prompt; later loop notes ("answer now") ride along as user text.
      if (!out.length) system.push(m.content);
      else push('user', [{ type: 'text', text: `(Note from Aplos: ${m.content})` }]);
    } else if (m.role === 'user') push('user', [{ type: 'text', text: m.content || ' ' }]);
    else if (m.role === 'assistant') {
      if (Array.isArray(m.raw)) {
        push('assistant', m.raw as Blocks);
        continue;
      }
      const blocks: Blocks = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const call of m.tool_calls ?? []) {
        let input: unknown = {};
        try {
          input = JSON.parse(call.function.arguments || '{}');
        } catch {
          /* Sent back as-is in the error result. */
        }
        blocks.push({
          type: 'tool_use',
          id: call.id,
          name: call.function.name,
          input: input as Record<string, unknown>,
        });
      }
      if (blocks.length) push('assistant', blocks);
    } else if (m.role === 'tool')
      push('user', [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content }]);
  }
  return { system: system.join('\n\n'), messages: out };
}

/** The SDK's typed errors mapped to the same messages and codes the other providers use. */
function failure(error: unknown, signal?: AbortSignal): Error {
  if (signal?.aborted || error instanceof Anthropic.APIUserAbortError)
    return new Error('AI request cancelled.');
  if (
    error instanceof Anthropic.AuthenticationError ||
    error instanceof Anthropic.PermissionDeniedError
  )
    return new Error(rejected('Claude'));
  if (error instanceof Anthropic.RateLimitError) {
    const seconds = Number(error.headers?.get?.('retry-after'));
    return Object.assign(
      new Error(
        Number.isFinite(seconds) && seconds > 90
          ? `Claude’s usage limit is reached. Try again in about ${Math.ceil(seconds / 60)} minutes, or choose another model in Settings → AI.`
          : 'Claude rate limit reached. Please try again shortly.',
      ),
      {
        code: 'rate_limited',
        ...(Number.isFinite(seconds) ? { retryAfterMs: seconds * 1000 } : {}),
      },
    );
  }
  if (error instanceof Anthropic.NotFoundError)
    return new Error(
      'This Claude model is not available right now. Choose another model in Settings → AI.',
    );
  if (error instanceof Anthropic.APIConnectionError)
    return new Error('Claude could not complete the request. Check your connection and try again.');
  if (error instanceof Anthropic.APIError)
    return new Error(
      error.status === 529
        ? 'Claude is overloaded right now. Please try again shortly.'
        : `Claude request failed (${error.status ?? 'error'}). Please try again.`,
    );
  return new Error('Claude stopped while answering. Please try again.');
}

export function createClaude(options: AnthropicOptions = {}): ChatProvider {
  // One client per key, made again when the key saved in Settings changes.
  let made: { key: string; client: Anthropic } | undefined;
  const current = () => {
    const apiKey = readKey(options.apiKey, 'ANTHROPIC_API_KEY');
    if (!apiKey) {
      made = undefined;
      return undefined;
    }
    // Ask runs its own wait-and-retry for rate limits, so the SDK retries only once.
    if (made?.key !== apiKey)
      made = {
        key: apiKey,
        client: new Anthropic({
          apiKey,
          maxRetries: 1,
          timeout: 90_000,
          ...(options.fetch ? { fetch: options.fetch } : {}),
        }),
      };
    return made.client;
  };
  return {
    get available() {
      return !!current();
    },
    /** One page of the model list, so a refused key shows Anthropic's own reason. */
    async check(signal) {
      const client = current();
      if (!client) throw new Error(missingKey('Claude'));
      try {
        await client.models.list({ limit: 1 }, { signal, maxRetries: 0, timeout: 20_000 });
      } catch (error) {
        if (signal?.aborted) throw new Error('AI request cancelled.');
        if (error instanceof Anthropic.APIConnectionError)
          throw new Error('Couldn’t reach Claude. Check your connection and try again.');
        if (error instanceof Anthropic.APIError) {
          const said = (error.error as { error?: { message?: unknown } } | undefined)?.error
            ?.message;
          const head =
            error.status === 401 || error.status === 403
              ? 'Claude didn’t accept this key'
              : `Claude answered ${error.status ?? 'with an error'}`;
          throw new Error(
            `${head}${typeof said === 'string' && said ? `: ${redact(said.slice(0, 240), made?.key)}` : '.'}`,
          );
        }
        throw new Error('Claude could not check the key. Please try again.');
      }
    },
    async chat(request: ChatRequest, { signal, onText } = {}): Promise<ChatTurn> {
      const client = current();
      if (!client) throw new Error(missingKey('Claude'));
      const { system, messages } = toClaude(request.messages);
      try {
        const stream = client.messages.stream(
          {
            model: request.model,
            max_tokens: request.maxTokens ?? 8192,
            // Mail questions are quick lookups; low effort keeps answers fast and tool calls consolidated.
            output_config: { effort: 'low' },
            ...(system ? { system } : {}),
            messages,
            ...(request.tools?.length
              ? {
                  tools: request.tools.map(t => ({
                    name: t.name,
                    description: t.description,
                    input_schema: t.parameters as Anthropic.Tool.InputSchema,
                  })),
                  tool_choice: {
                    type: request.toolChoice === 'none' ? ('none' as const) : ('auto' as const),
                  },
                }
              : {}),
          },
          { signal },
        );
        for await (const event of stream)
          if (
            event.type === 'content_block_delta' &&
            event.delta.type === 'text_delta' &&
            event.delta.text
          )
            onText?.(event.delta.text);
        const message = await stream.finalMessage();
        if (message.stop_reason === 'refusal')
          throw Object.assign(
            new Error(
              'Claude declined to answer this. Try rephrasing, or choose another model in Settings → AI.',
            ),
            { code: 'refusal' },
          );
        // A tool call cut off by the output limit may be incomplete, so it is not run.
        const truncated = message.stop_reason === 'max_tokens';
        return {
          content: message.content
            .filter((b): b is Anthropic.TextBlock => b.type === 'text')
            .map(b => b.text)
            .join(''),
          toolCalls: truncated
            ? []
            : message.content
                .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
                .map(b => ({ id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) })),
          finishReason: message.stop_reason ?? undefined,
          usage: { prompt: message.usage.input_tokens, completion: message.usage.output_tokens },
          raw: message.content,
        };
      } catch (error) {
        if ((error as { code?: unknown }).code === 'refusal') throw error;
        throw failure(error, signal);
      }
    },
    async models(): Promise<AskModelInfo[]> {
      const curated = askProvider('anthropic').models,
        client = current();
      if (!client) return [...curated];
      const live: string[] = [];
      for await (const model of client.models.list()) live.push(model.id);
      return [
        ...curated.filter(m => live.includes(m.id)),
        ...live.filter(id => !curated.some(m => m.id === id)).map(id => ({ id, label: id })),
      ];
    },
  };
}
