import type { Account, AppState, CalendarEvent, Draft, Thread } from '@aplos/contract/legacy/types';
import type { Chat } from './agent';
import type { AskModelInfo, AskProviderId, AskServerId } from '@aplos/contract/legacy/ask';
import type { MailProvider, ProviderKind, ProviderMemory } from './provider';
import type { MailStore, MemoryWrite, OpChanges, SaveExtras, StoreDiff } from './store';
import type { WorkflowPatch } from './workflow';

/** Storage and host services the platform-free orchestration receives from its host. */
export interface ServiceStore extends Omit<MailStore, 'load' | 'save'> {
  read(): AppState | undefined;
  write(state: AppState, ops?: OpChanges, extras?: SaveExtras): StoreDiff;
}

/** Async context belongs to the host; a mobile host must preserve it across overlapping requests. */
export interface MemoryStage {
  run<T>(fn: () => T): T;
  /** Undefined means a concurrent writer changed a key; discard and repeat the operation. */
  writes(): MemoryWrite[] | undefined;
  committed(): void;
  discard(): void;
}
export interface StagedMemory {
  memory: ProviderMemory;
  stage(): MemoryStage;
}

/**
 * Groq, the default provider for every AI feature. `model` is the feature's Groq model from Settings → AI; the other
 * providers run summaries, drafts and plans through `writer.ts` over their `chat`. Configuration and secrets belong to the host.
 */
export interface Intelligence {
  readonly available: boolean;
  summarize(thread: Thread, signal?: AbortSignal, model?: string): Promise<Partial<Thread>>;
  polish(
    html: string,
    instruction?: string,
    signal?: AbortSignal,
    model?: string,
  ): Promise<{ html: string }>;
  draft(
    instruction: string,
    thread?: Thread,
    draft?: Partial<Draft>,
    signal?: AbortSignal,
    model?: string,
  ): Promise<Partial<Draft>>;
  /** One streamed, tool-capable chat call; Ask's agent loop (`agent.ts`) drives it. */
  chat: Chat;
  /** `timeZone` resolves relative days ("this Saturday at 10 am") in the user's zone. */
  extractEvents(
    thread: Thread,
    signal?: AbortSignal,
    context?: { timeZone?: string; model?: string },
  ): Promise<Partial<CalendarEvent>[]>;
  transcribe(
    audio: string,
    mimeType: string,
    signal?: AbortSignal,
    model?: string,
  ): Promise<{ text: string }>;
  /** One cheap request with the current key; rejects with the provider's reason. */
  check?(signal?: AbortSignal): Promise<void>;
}

/** A provider an AI feature can run on. `models` lists the chat models it currently offers for tool use. */
export interface ChatProvider {
  readonly available: boolean;
  chat: Chat;
  models?(signal?: AbortSignal): Promise<AskModelInfo[]>;
  /** One cheap request (usually the model list) with the current key; rejects with the provider's reason. */
  check?(signal?: AbortSignal): Promise<void>;
  /** Local servers: whether the app is running and answering, and its version when it says. */
  status?(signal?: AbortSignal): Promise<{ running: boolean; version?: string }>;
  /** Speech to text, for providers with a transcription API; `voiceModels` lists what it offers now. */
  transcribe?(
    audio: string,
    mimeType: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{ text: string }>;
  voiceModels?(signal?: AbortSignal): Promise<AskModelInfo[]>;
}

/**
 * API keys typed in Settings → AI. The host keeps them encrypted; the engine and renderer only ever see where the
 * active key comes from and its last four characters. A saved key wins over the environment variable.
 */
export type AiKeySource = 'saved' | 'environment';
export interface AiKeyInfo {
  source?: AiKeySource;
  last4?: string;
}
export interface AiKeyStore {
  /** Whether keys can be saved here (the desktop app's encrypted store; not the browser preview). */
  readonly secure: boolean;
  /** Why saved keys couldn't be read, when they couldn't. */
  readonly error?: string;
  info(provider: AskProviderId): AiKeyInfo;
  set(provider: AskProviderId, key: string): Promise<void>;
  delete(provider: AskProviderId): Promise<void>;
}

/** The encrypted workflow transport is injected together with its platform vault and crypto. */
export interface WorkflowSync {
  readonly enabled: boolean;
  enable(code?: string): Promise<string>;
  code(): string | undefined;
  hasEdits(accountId: string): boolean;
  disable(accountIds: string[]): Promise<void>;
  noteEdits(threads: Thread[]): void;
  round(
    account: Account,
    provider: MailProvider,
    threads: () => Thread[],
  ): Promise<WorkflowPatch[]>;
}

export interface EngineOptions {
  /** The app's version, which only the host knows (the engine package has no app manifest). Optional so tests that build
   * the engine directly need not invent one; `capabilities.get` then reports an empty version. Every host passes it. */
  appVersion?: string;
  store: ServiceStore;
  staged: StagedMemory;
  providers: Partial<Record<ProviderKind, MailProvider>>;
  brokenProviders?: Map<ProviderKind, string>;
  groq: Intelligence;
  /** A Groq model an older setup chose with GROQ_MODEL; it seeds Summaries, Drafts and Plans the first time those settings exist. */
  groqModel?: string;
  /** The other AI providers; Groq's comes from `groq`. */
  chats?: Partial<Record<AskProviderId, ChatProvider>>;
  /** A transport for Ollama, LM Studio or a custom OpenAI-compatible server at the address in Settings. */
  serverChat?: (id: AskServerId, baseUrl: string) => ChatProvider;
  workflow?: WorkflowSync;
  workflowError?: string;
  /** Keys saved in Settings → AI; without one, keys come only from the environment. */
  keys?: AiKeyStore;
  /** Whether the injected workflow vault has secure credential storage. */
  secure: boolean;
  randomUUID: () => string;
  symbols?: (items: unknown, scale: unknown) => Promise<Record<string, string>>;
  now?: () => Date;
  desktop?: boolean;
  fetch?: typeof fetch;
  lookup?: (host: string) => Promise<string[]>;
  autoSyncMs?: number;
}
