import type { ModelRef } from '@aplos/contract';

/**
 * The provider call surface the host injects (`apps/desktop/src/host/ai`, eng-ai). Types only — no fetch, no Node,
 * no Headers/Response: a transport is plain data in and out, aborted by `signal`, and never returns a key. One
 * attempt per call — retry, backoff and the daily budget are the engine's single AI retry layer (ARCH 8.4).
 */

/** One chat turn's message, as the OpenAI-compatible shape every provider here speaks. */
export type AiChatMessage =
  | { role: 'system' | 'user'; content: string }
  | {
      role: 'assistant';
      content: string | null;
      toolCalls?: { id: string; name: string; arguments: string }[];
    }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

/** A tool the model may call (`parameters` is the JSON Schema object the provider expects). */
export interface AiToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface AiChatRequest {
  model: ModelRef;
  messages: AiChatMessage[];
  tools?: AiToolSpec[];
  toolChoice?: 'auto' | 'none';
  /** Ask for a single JSON object where the provider has a JSON mode. */
  json?: boolean;
  maxTokens?: number;
  /** Stable id per conversation for providers that route or cache by it. */
  session?: string;
  signal?: AbortSignal;
  /** Answer text as it streams; tool calls arrive complete at the end. */
  onText?: (delta: string) => void;
}

export interface AiToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface AiChatTurn {
  content: string;
  toolCalls: AiToolCall[];
  finishReason?: string;
  usage?: { prompt: number; completion: number };
}

export interface AiTranscribeRequest {
  model: ModelRef;
  /** The audio blob's bytes and MIME type (`Blob/put` supplies them). */
  audio: Uint8Array;
  mimeType: string;
  language?: string;
  signal?: AbortSignal;
}

export type AiKeySource = 'env' | 'keychain' | 'none';

/** The host's AI key store and provider plumbing. Keys are write-only: nothing here returns key characters. */
export interface AiTransport {
  /** One streamed tool-capable chat call. Rejects with `AiCallError`, already classified. */
  chat(req: AiChatRequest): Promise<AiChatTurn>;
  /** Speech to text on the Voice provider's model (Groq or OpenAI). */
  transcribe(req: AiTranscribeRequest): Promise<{ text: string }>;
  /** A provider's live model list (local servers answer their own; hosted may fall back to curated). */
  models(provider: ModelRef['provider']): Promise<{ list: string[]; live: boolean }>;
  /** One cheap authenticated request (usually the model list); no mail is sent. */
  check(provider: ModelRef['provider']): Promise<void>;
  /** Save a key into the sealed store; resolves with where keys now come from. */
  setKey(provider: ModelRef['provider'], key: string): Promise<AiKeySource>;
  /** Remove a saved key; an env-sourced key cannot be removed (answer 'env'). */
  removeKey(provider: ModelRef['provider']): Promise<AiKeySource>;
  /** Where the provider's key now comes from. */
  keySource(provider: ModelRef['provider']): AiKeySource;
}
