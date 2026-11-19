import type { CalendarEvent, Draft, Thread } from '@aplos/contract/legacy/types';
import {
  checkKey,
  providerRequest,
  readChatStream,
  readKey,
  streamChat,
  transcribeAudio,
  type ApiKey,
  type ProviderTarget,
} from './llm';
export { readChatStream };
import { threadLinks } from '@aplos/contract/legacy/mailbox';
import { localNow, messageWeek } from '@aplos/engine/legacy/proposals';
import { createWriter, jsonObject, jsonSystem } from '@aplos/engine/legacy/writer';
export { suggestedAction } from '@aplos/engine/legacy/writer';
export { threadLinks, localNow, messageWeek };

/** `apiKey` is a key or a resolver read per request; without one GROQ_API_KEY is used. */
export interface GroqOptions {
  fetch?: typeof fetch;
  apiKey?: ApiKey;
  model?: string;
}
/** Groq: the default provider for every AI feature. This module never returns provider response bodies in errors. */
export function createGroq(options: GroqOptions = {}) {
  const key = () => readKey(options.apiKey, 'GROQ_API_KEY');
  const target: ProviderTarget = {
    name: 'Groq',
    env: 'GROQ_API_KEY',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKey: key,
    fetch: options.fetch ?? fetch,
  };
  const send = (path: string, body: BodyInit, signal?: AbortSignal, json = true) =>
    providerRequest(target, path, body, signal, json);
  const sendChat = (
    path: string,
    body: BodyInit,
    signal?: AbortSignal,
    headers?: Record<string, string>,
  ) => providerRequest(target, path, body, signal, true, 'POST', headers);
  async function call(
    path: string,
    body: BodyInit,
    signal?: AbortSignal,
    json = true,
  ): Promise<Record<string, unknown>> {
    const response = await send(path, body, signal, json);
    try {
      return (await response.json()) as Record<string, unknown>;
    } catch {
      if (signal?.aborted) throw new Error('AI request cancelled.');
      throw new Error('Groq could not complete the request. Check your connection and try again.');
    }
  }
  /** One JSON-mode completion. `model` is the feature's choice in Settings → AI; scripts fall back to GROQ_MODEL. */
  async function json(
    instruction: string,
    input: unknown,
    signal?: AbortSignal,
    chosen?: string,
    maxTokens = 4096,
  ) {
    const model = chosen ?? options.model ?? process.env.GROQ_MODEL ?? 'openai/gpt-oss-120b';
    const serialized = JSON.stringify(input);
    if (serialized.length > 100000)
      throw new Error(
        'The selected AI context is too large. Shorten the draft or instruction and try again.',
      );
    const result = await call(
      'chat/completions',
      JSON.stringify({
        model,
        ...(model.startsWith('openai/gpt-oss-') ? { reasoning_effort: 'low' } : {}),
        temperature: 0.2,
        max_completion_tokens: maxTokens,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: jsonSystem + instruction },
          { role: 'user', content: serialized },
        ],
      }),
      signal,
    );
    return jsonObject(
      (result.choices as { message?: { content?: string } }[])?.[0]?.message?.content ?? '',
      'Groq',
    );
  }
  const writer = (model?: string) =>
    createWriter(
      (instruction, input, signal, options) =>
        json(instruction, input, signal, model, options?.maxTokens),
      'Groq',
    );
  return {
    get available() {
      return Boolean(key());
    },
    check: (signal?: AbortSignal) => checkKey(target, 'models', {}, signal),
    /** One streamed chat/completions call with OpenAI-compatible tools; text arrives through `onText`. */
    chat: streamChat(sendChat, {
      name: 'Groq',
      extra: request =>
        request.model.startsWith('openai/gpt-oss-') ? { reasoning_effort: 'low' } : {},
    }),
    summarize: (thread: Thread, signal?: AbortSignal, model?: string) =>
      writer(model).summarize(thread, signal),
    polish: (html: string, instruction?: string, signal?: AbortSignal, model?: string) =>
      writer(model).polish(html, instruction, signal),
    draft: (
      instruction: string,
      thread?: Thread,
      draft?: Partial<Draft>,
      signal?: AbortSignal,
      model?: string,
    ) => writer(model).draft(instruction, thread, draft, signal),
    extractEvents: (
      thread: Thread,
      signal?: AbortSignal,
      extra: { timeZone?: string; now?: Date; model?: string } = {},
    ): Promise<Partial<CalendarEvent>[]> =>
      writer(extra.model).extractEvents(thread, signal, extra),
    transcribe: (
      audio: string,
      mimeType: string,
      signal?: AbortSignal,
      model = 'whisper-large-v3-turbo',
    ) => transcribeAudio(send, audio, mimeType, model, 'Groq', signal),
  };
}
export type GroqAdapter = ReturnType<typeof createGroq>;
