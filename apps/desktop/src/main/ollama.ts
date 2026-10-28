import type { ChatMessage, ChatRequest, ChatTurn } from '@aplos/engine/legacy/agent';
import type { ChatProvider } from '@aplos/engine/legacy/ports';
import type { AskModelInfo } from '@aplos/contract/legacy/ask';
import { readKey, type ApiKey } from './llm';

/**
 * Ollama through its native /api/chat, so Ask can raise the context window (Ollama's default can be 4K tokens,
 * which would cut Ask's prompt short) and turn thinking off for quick answers. Streams NDJSON; tool calls carry
 * object arguments and no IDs, so IDs are assigned here and tool results are matched back by tool name.
 */
/** `apiKey` is a key or a resolver read per request; without one OLLAMA_API_KEY is used. */
export interface OllamaOptions {
  apiKey?: ApiKey;
  fetch?: typeof fetch;
  contextTokens?: number;
}
type Wire = {
  role: string;
  content: string;
  tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[];
  tool_name?: string;
};

const host = (baseUrl: string) => baseUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '');
function toOllama(messages: ChatMessage[]): Wire[] {
  return messages.map((m): Wire => {
    if (m.role === 'assistant')
      return {
        role: 'assistant',
        content: m.content ?? '',
        ...(m.tool_calls?.length
          ? {
              tool_calls: m.tool_calls.map(c => {
                let args: Record<string, unknown> = {};
                try {
                  args = JSON.parse(c.function.arguments || '{}');
                } catch {
                  /* An unreadable call is replayed with no arguments. */
                }
                return { function: { name: c.function.name, arguments: args } };
              }),
            }
          : {}),
      };
    if (m.role === 'tool') return { role: 'tool', tool_name: m.name, content: m.content };
    return { role: m.role, content: m.content };
  });
}

export function createOllama(baseUrl: string, options: OllamaOptions = {}): ChatProvider {
  const root = baseUrl.replace(/\/+$/, '').replace(/\/v1$/, ''),
    request = options.fetch ?? fetch,
    key = () => readKey(options.apiKey, 'OLLAMA_API_KEY');
  const offline = `Ollama isn’t running at ${host(root)}. Open Ollama, or change its address in Settings → AI.`;
  async function call(
    path: string,
    init: { method?: string; body?: unknown } = {},
    signal?: AbortSignal,
    timeoutMs = 120_000,
  ): Promise<Response> {
    let response: Response;
    const apiKey = key();
    try {
      response = await request(`${root}/${path}`, {
        method: init.method ?? (init.body ? 'POST' : 'GET'),
        headers: {
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        ...(init.body ? { body: JSON.stringify(init.body) } : {}),
        signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
      });
    } catch {
      if (signal?.aborted) throw new Error('AI request cancelled.');
      throw new Error(offline);
    }
    if (response.ok) return response;
    if (response.status === 404)
      throw new Error(
        'Ollama doesn’t have this model. Pull it first (ollama pull <model>) or choose another in Settings → AI.',
      );
    if (response.status === 401 || response.status === 403)
      throw new Error('Ollama rejected the request. Check its key in Settings → AI.');
    if (response.status === 429)
      throw Object.assign(new Error('Ollama is busy. Please try again shortly.'), {
        code: 'rate_limited',
      });
    throw new Error(`Ollama request failed (${response.status}). Please try again.`);
  }
  /**
   * Context for prompt and reply together. Ask keeps the fixed size; a JSON request (summary, draft, polish, plan) grows
   * it only when it needs more, such as a long email to polish, since Ollama reloads the model whenever the size changes.
   */
  const base = options.contextTokens ?? 16384;
  const context = (chat: ChatRequest) =>
    chat.json
      ? Math.min(
          32768,
          Math.max(
            base,
            Math.ceil(JSON.stringify(chat.messages).length / 3) + (chat.maxTokens ?? 2048),
          ),
        )
      : base;
  return {
    available: true,
    // The version endpoint is open, so the model list (which a protected server guards) checks the key.
    check: async signal => {
      await call('api/tags', {}, signal, 10_000);
    },
    async status(signal) {
      try {
        const response = await call('api/version', {}, signal, 3_000);
        const value = (await response.json()) as { version?: unknown };
        return {
          running: true,
          ...(typeof value.version === 'string' ? { version: value.version } : {}),
        };
      } catch {
        return { running: false };
      }
    },
    async chat(chat: ChatRequest, { signal, onText } = {}): Promise<ChatTurn> {
      // Ollama has no tool_choice; the final no-tools step simply sends no tools.
      const tools = chat.toolChoice === 'none' ? [] : (chat.tools ?? []);
      const response = await call(
        'api/chat',
        {
          body: {
            model: chat.model,
            messages: toOllama(chat.messages),
            stream: true,
            think: false,
            keep_alive: '10m',
            options: {
              num_ctx: context(chat),
              temperature: 0.3,
              ...(chat.json && chat.maxTokens ? { num_predict: chat.maxTokens } : {}),
            },
            ...(chat.json ? { format: 'json' } : {}),
            ...(tools.length ? { tools: tools.map(t => ({ type: 'function', function: t })) } : {}),
          },
        },
        signal,
      );
      if (!response.body) throw new Error('Ollama returned an invalid response. Please try again.');
      const reader = response.body.getReader(),
        decoder = new TextDecoder();
      let buffer = '',
        content = '',
        usage: ChatTurn['usage'];
      const calls: ChatTurn['toolCalls'] = [];
      const line = (raw: string) => {
        if (!raw.trim()) return;
        let chunk: Record<string, any>;
        try {
          chunk = JSON.parse(raw);
        } catch {
          return;
        }
        if (chunk.error) throw new Error('Ollama stopped while answering. Please try again.');
        const message = chunk.message ?? {};
        if (typeof message.content === 'string' && message.content) {
          content += message.content;
          onText?.(message.content);
        }
        for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
          const fn = call?.function;
          if (typeof fn?.name === 'string')
            calls.push({
              id: `call_${calls.length}`,
              name: fn.name,
              arguments:
                typeof fn.arguments === 'string'
                  ? fn.arguments
                  : JSON.stringify(fn.arguments ?? {}),
            });
        }
        if (chunk.done && typeof chunk.prompt_eval_count === 'number')
          usage = { prompt: chunk.prompt_eval_count, completion: Number(chunk.eval_count) || 0 };
      };
      try {
        for (;;) {
          if (signal?.aborted) throw new Error('AI request cancelled.');
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
            line(buffer.slice(0, at));
            buffer = buffer.slice(at + 1);
          }
        }
        line(buffer + decoder.decode());
      } catch (error) {
        if (signal?.aborted) throw new Error('AI request cancelled.');
        throw error instanceof Error && error.message.startsWith('Ollama')
          ? error
          : new Error('Ollama stopped while answering. Please try again.');
      } finally {
        void reader.cancel().catch(() => {});
      }
      return { content, toolCalls: calls, ...(usage ? { usage } : {}) };
    },
    // Installed models whose capabilities include tools; older Ollama versions without capabilities list everything.
    async models(signal) {
      const tags = (await (await call('api/tags', {}, signal, 5_000)).json()) as {
        models?: Array<{
          name?: string;
          details?: { parameter_size?: string; quantization_level?: string; family?: string };
        }>;
      };
      const list = await Promise.all(
        (tags.models ?? [])
          .filter(m => typeof m.name === 'string')
          .map(async (m): Promise<AskModelInfo | undefined> => {
            const show = await call('api/show', { body: { model: m.name } }, signal, 5_000)
              .then(r => r.json() as Promise<{ capabilities?: unknown }>)
              .catch(() => ({}) as { capabilities?: unknown });
            if (Array.isArray(show.capabilities) && !show.capabilities.includes('tools')) return;
            const detail = [m.details?.parameter_size, m.details?.quantization_level]
              .filter(Boolean)
              .join(' · ');
            return {
              id: m.name!,
              label: m.name!.replace(/:latest$/, ''),
              ...(detail ? { description: detail } : {}),
            };
          }),
      );
      return list
        .filter((m): m is AskModelInfo => !!m)
        .sort((a, b) => a.label.localeCompare(b.label));
    },
  };
}
