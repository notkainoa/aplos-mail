import type { Chat, ChatRequest, ChatTurn } from '@aplos/engine/legacy/agent';

/**
 * OpenAI-compatible chat transports (Groq, OpenAI, Gemini, OpenRouter, OpenCode Go, local servers). Keys come from the encrypted
 * key store (Settings → AI) or the backend environment and never reach the renderer. Errors never carry provider response bodies,
 * only a known code; the key check (`checkKey`) is the one exception, so a refused key shows the provider's own reason.
 */
/** A key, or where to read it when a request runs, so a key saved in Settings takes effect without a restart. */
export type ApiKey = string | (() => string | undefined);
/** The key to use now: the given one (an empty string means none), else the environment variable. */
export function readKey(key: ApiKey | undefined, env: string): string | undefined {
  return (typeof key === 'function' ? key() : (key ?? process.env[env])) || undefined;
}
export const missingKey = (name: string) => `Add your ${name} key in Settings → AI to use ${name}.`;

/** `keyOptional` servers (a local model server) are called without Authorization when no key is set. */
export interface ProviderTarget {
  name: string;
  env: string;
  baseUrl: string;
  apiKey?: ApiKey;
  keyOptional?: boolean;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
  /** Shown when the server can't be reached at all (a local app that isn't running). */ offline?: string;
}

export async function providerRequest(
  target: ProviderTarget,
  path: string,
  body: BodyInit | undefined,
  signal?: AbortSignal,
  json = true,
  method = 'POST',
  headers: Record<string, string> = {},
): Promise<Response> {
  const { name } = target,
    apiKey = readKey(target.apiKey ?? '', target.env);
  if (!apiKey && !target.keyOptional) throw new Error(missingKey(name));
  let response: Response;
  try {
    response = await (target.fetch ?? fetch)(`${target.baseUrl}/${path}`, {
      method,
      headers: {
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        ...(json ? { 'Content-Type': 'application/json' } : {}),
        ...target.headers,
        ...headers,
      },
      ...(method === 'GET' ? {} : { body }),
      signal: AbortSignal.any([AbortSignal.timeout(90000), ...(signal ? [signal] : [])]),
    });
  } catch {
    if (signal?.aborted) throw new Error('AI request cancelled.');
    throw new Error(
      target.offline ??
        `${name} could not complete the request. Check your connection and try again.`,
    );
  }
  if (response.ok) return response;
  if (response.status === 401 || response.status === 403) throw new Error(rejected(name));
  if (response.status === 413)
    throw new Error(
      `This is too much text for ${name}’s per-minute limit on your plan. Try a shorter email, or choose another model in Settings → AI.`,
    );
  if (response.status === 402)
    throw new Error(
      `${name} has no credits left on this account. Add credits or choose another model in Settings → AI.`,
    );
  if (response.status === 429) {
    // Ask waits out a short limit window; other callers just report it. A long wait means a daily or plan quota.
    const seconds = Number(response.headers.get('retry-after'));
    const message =
      Number.isFinite(seconds) && seconds > 90
        ? `${name}’s usage limit for this model is reached. Try again in about ${Math.ceil(seconds / 60)} minutes, or choose another model in Settings → AI.`
        : `${name} rate limit reached. Please try again shortly.`;
    throw Object.assign(new Error(message), {
      code: 'rate_limited',
      ...(Number.isFinite(seconds) && seconds >= 0 ? { retryAfterMs: seconds * 1000 } : {}),
    });
  }
  const code = await response.json().then(
    value => (value as { error?: { code?: unknown } })?.error?.code,
    () => undefined,
  );
  if (code === 'tool_use_failed')
    throw Object.assign(new Error(`${name} could not read a tool call. Please try again.`), {
      code,
    });
  if (code === 'model_not_found' || code === 'model_decommissioned' || response.status === 404)
    throw new Error(
      `This ${name} model is not available right now. Choose another model in Settings → AI.`,
    );
  throw new Error(`${name} request failed (${response.status}). Please try again.`);
}

export const rejected = (name: string) =>
  `${name} rejected the API key. Check it in Settings → AI.`;

/**
 * One cheap authenticated request (usually the model list) to check a key. On failure the provider's own error message is
 * shown, with the key itself and anything key-shaped removed, since this is what the owner needs to fix it.
 */
export async function checkKey(
  target: ProviderTarget,
  path = 'models',
  init: { method?: string; body?: unknown } = {},
  signal?: AbortSignal,
): Promise<void> {
  const apiKey = readKey(target.apiKey ?? '', target.env);
  if (!apiKey && !target.keyOptional) throw new Error(missingKey(target.name));
  let response: Response;
  try {
    response = await (target.fetch ?? fetch)(`${target.baseUrl}/${path}`, {
      method: init.method ?? 'GET',
      headers: {
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...target.headers,
      },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.any([AbortSignal.timeout(20_000), ...(signal ? [signal] : [])]),
    });
  } catch {
    if (signal?.aborted) throw new Error('AI request cancelled.');
    throw new Error(
      target.offline ?? `Couldn’t reach ${target.name}. Check your connection and try again.`,
    );
  }
  if (response.ok) return;
  const said = await response.json().then(
    value => providerMessage(value),
    () => undefined,
  );
  throw new Error(
    `${response.status === 401 || response.status === 403 ? `${target.name} didn’t accept this key` : `${target.name} answered ${response.status}`}${said ? `: ${redact(said, apiKey)}` : '.'}`,
  );
}
/** The `error.message` (or `error` / `message`) of a provider's JSON error body. */
export function providerMessage(value: unknown): string | undefined {
  const v = value as { error?: unknown; message?: unknown };
  const raw =
    typeof v?.error === 'object' && v.error
      ? (v.error as { message?: unknown }).message
      : (v?.error ?? v?.message);
  return typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, 240) : undefined;
}
/** Removes a key, and anything that looks like one, from text shown to the owner. */
export function redact(text: string, key?: string): string {
  let out = key ? text.split(key).join('••••') : text;
  out = out
    .replace(/\b(sk|gsk|sk-ant|sk-or|AIza)[A-Za-z0-9_\-*.]{6,}/g, '••••')
    .replace(/[A-Za-z0-9_\-]{32,}/g, '••••');
  return out;
}

/** Speech to text through an OpenAI-style audio/transcriptions endpoint (Groq, OpenAI). */
export async function transcribeAudio(
  send: (path: string, body: BodyInit, signal?: AbortSignal, json?: boolean) => Promise<Response>,
  audio: string,
  mimeType: string,
  model: string,
  name: string,
  signal?: AbortSignal,
): Promise<{ text: string }> {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(audio)) throw new Error('Audio must be valid base64.');
  if (audio.length > 35_000_000) throw new Error('Audio must be smaller than 25 MB.');
  const bytes = Buffer.from(audio, 'base64');
  if (!bytes.length || bytes.length > 25 * 1024 * 1024)
    throw new Error('Audio must contain between 1 byte and 25 MB.');
  const formats: Record<string, string> = {
    'audio/webm': 'webm',
    'audio/mp4': 'm4a',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/ogg': 'ogg',
    'video/webm': 'webm',
  };
  const type = mimeType.split(';')[0].trim();
  if (!formats[type]) throw new Error('Unsupported audio format. Use WebM, MP4, MP3, WAV or Ogg.');
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(bytes)], { type }), `dictation.${formats[type]}`);
  form.append('model', model);
  form.append('response_format', 'json');
  const response = await send('audio/transcriptions', form, signal, false);
  const result = (await response.json().catch(() => {
    if (signal?.aborted) throw new Error('AI request cancelled.');
    throw new Error(`${name} could not complete the request. Check your connection and try again.`);
  })) as { text?: unknown };
  if (typeof result?.text !== 'string')
    throw new Error(`${name} returned an invalid transcription.`);
  return { text: result.text };
}

export interface StreamOptions {
  /** Shown in errors, e.g. "Groq". */
  name?: string;
  /** Provider-specific body fields such as reasoning effort. */
  extra?: (request: ChatRequest) => Record<string, unknown>;
  /** Per-request headers, e.g. a session ID. */
  headers?: (request: ChatRequest) => Record<string, string>;
  maxTokens?: number;
  /** Sampling temperature; null leaves it out (OpenAI's reasoning models reject it). */
  temperature?: number | null;
  /** The provider accepts `response_format: json_object`, used when a request asks for JSON. */
  jsonMode?: boolean;
}
type Send = (
  path: string,
  body: BodyInit,
  signal?: AbortSignal,
  headers?: Record<string, string>,
) => Promise<Response>;
/** A streamed tool-capable chat/completions call over `send`. */
export function streamChat(
  send: Send,
  {
    name = 'The AI provider',
    extra = () => ({}),
    headers = () => ({}),
    maxTokens = 2048,
    temperature = 0.3,
    jsonMode = false,
  }: StreamOptions = {},
): Chat {
  return async (chat, { signal, onText } = {}) => {
    const body = {
      model: chat.model,
      messages: chat.messages.map(
        ({ raw: _raw, ...m }: { raw?: unknown } & ChatRequest['messages'][number]) => m,
      ),
      stream: true,
      ...(temperature === null ? {} : { temperature }),
      max_completion_tokens: chat.maxTokens ?? maxTokens,
      ...(chat.json && jsonMode ? { response_format: { type: 'json_object' } } : {}),
      ...extra(chat),
      ...(chat.tools?.length
        ? {
            tools: chat.tools.map(t => ({ type: 'function', function: t })),
            tool_choice: chat.toolChoice ?? 'auto',
          }
        : {}),
    };
    const response = await send('chat/completions', JSON.stringify(body), signal, headers(chat));
    if (!response.body) throw new Error(`${name} returned an invalid response. Please try again.`);
    try {
      return await readChatStream(response.body, onText, signal);
    } catch (error) {
      if (signal?.aborted) throw new Error('AI request cancelled.');
      if ((error as { code?: unknown }).code) throw error;
      throw new Error(`${name} stopped while answering. Please try again.`);
    }
  };
}

/**
 * Reads an OpenAI-style SSE completion: text deltas go to `onText`; tool calls are assembled by index
 * whether they arrive whole or in fragments. `finish_reason` is not required (Groq sometimes omits it).
 */
export async function readChatStream(
  body: ReadableStream<Uint8Array>,
  onText?: (text: string) => void,
  signal?: AbortSignal,
): Promise<ChatTurn> {
  const reader = body.getReader(),
    decoder = new TextDecoder();
  let buffer = '',
    content = '',
    finishReason: string | undefined,
    usage: ChatTurn['usage'];
  const calls: { id?: string; name: string; arguments: string }[] = [];
  const line = (raw: string) => {
    if (!raw.startsWith('data:')) return;
    const data = raw.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let chunk: Record<string, any>;
    try {
      chunk = JSON.parse(data);
    } catch {
      return;
    }
    const error = chunk.error ?? chunk.x_groq?.error;
    if (error)
      throw Object.assign(
        new Error('The AI provider stopped while answering.'),
        typeof error === 'object' && error?.code === 'tool_use_failed'
          ? { code: 'tool_use_failed' }
          : {},
      );
    const counted = chunk.x_groq?.usage ?? chunk.usage;
    if (counted && typeof counted.prompt_tokens === 'number')
      usage = { prompt: counted.prompt_tokens, completion: Number(counted.completion_tokens) || 0 };
    const choice = chunk.choices?.[0];
    if (!choice) return;
    const delta = choice.delta ?? {};
    if (typeof delta.content === 'string' && delta.content) {
      content += delta.content;
      onText?.(delta.content);
    }
    for (const part of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      const index = Number.isInteger(part?.index) ? part.index : calls.length;
      const call = (calls[index] ??= { name: '', arguments: '' });
      if (typeof part.id === 'string') call.id = part.id;
      if (typeof part.function?.name === 'string') call.name += part.function.name;
      if (typeof part.function?.arguments === 'string') call.arguments += part.function.arguments;
    }
    if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason;
  };
  let stop: (() => void) | undefined;
  const aborted = signal
    ? new Promise<never>((_, reject) => {
        stop = () => reject(new Error('AI request cancelled.'));
        if (signal.aborted) stop();
        else signal.addEventListener('abort', stop, { once: true });
      })
    : undefined;
  aborted?.catch(() => {});
  try {
    for (;;) {
      const { done, value } = await (aborted
        ? Promise.race([reader.read(), aborted])
        : reader.read());
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
        line(buffer.slice(0, at).replace(/\r$/, ''));
        buffer = buffer.slice(at + 1);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) line(buffer.trim());
  } finally {
    if (stop) signal?.removeEventListener('abort', stop);
    void reader.cancel().catch(() => {});
  }
  return {
    content,
    toolCalls: calls
      .filter(c => c && c.name)
      .map((c, i) => ({ id: c.id ?? `call_${i}`, name: c.name, arguments: c.arguments })),
    finishReason,
    ...(usage ? { usage } : {}),
  };
}
