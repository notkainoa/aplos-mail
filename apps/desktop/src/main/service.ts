import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { createStore } from './store';
import { createGroq } from './groq';
import {
  createCustom,
  createGemini,
  createLmStudio,
  createOpenAI,
  createOpenCodeGo,
  createOpenRouter,
} from './providers';
import { createOllama } from './ollama';
import { createClaude } from './anthropic';
import { createAiKeys, type AiKeys } from './ai-keys';
import type { ChatProvider } from '@aplos/engine/legacy/ports';
import type { AskProviderId, AskServerId } from '@aplos/contract/legacy/ask';
import { createGoogle, type GoogleAdapter } from './google';
import { symbolRenderer } from './symbols';
import { createStagedMemory } from './memory-stage';
import type {
  MailProvider,
  ProviderEnvironment,
  ProviderKind,
} from '@aplos/engine/legacy/provider';
import { createMicrosoft } from './microsoft';
import { createImap } from './imap';
import { createJmap } from './jmap';
import { createCalDav } from './caldav';
import { createWorkflowSync } from './workflow-sync';
import { createEngineService } from '@aplos/engine/legacy/service';
import { appVersion } from '../shared/version';

type Groq = ReturnType<typeof createGroq>;
export interface ServiceOptions {
  dataDir: string;
  desktop?: boolean;
  encrypt?: (text: string) => Buffer;
  decrypt?: (cipher: Buffer) => string;
  openExternal?: (url: string) => Promise<unknown>;
  groq?: Groq;
  google?: GoogleAdapter;
  now?: () => Date;
  symbolTool?: string;
  /** Ask's OpenRouter and OpenCode Go transports; tests pass fakes. */
  chats?: Partial<Record<AskProviderId, ChatProvider>>;
  serverChat?: (id: AskServerId, baseUrl: string) => ChatProvider;
  /** Mail hosts by kind, or factories given the service's provider environment; missing kinds use the built-in adapters. */
  providers?: Partial<
    Record<
      ProviderKind,
      MailProvider | ((env: ProviderEnvironment<Buffer>) => MailProvider | Promise<MailProvider>)
    >
  >;
  /** Network access for discovery and DNS checks; tests pass a fake. */
  fetch?: typeof fetch;
  /** Background sync interval for connected accounts; 0 turns it off. */
  autoSyncMs?: number;
  /** Where AI keys fall back to when none is saved in Settings; the process environment by default. */
  env?: Record<string, string | undefined>;
}

/** One transport per server and address, so a model list cache survives between questions. Keys are read per request. */
function servers(keys: AiKeys) {
  const made = new Map<string, ChatProvider>(),
    build = { ollama: createOllama, lmstudio: createLmStudio, custom: createCustom };
  return (id: AskServerId, url: string) => {
    const key = `${id} ${url}`;
    let provider = made.get(key);
    if (!provider) {
      provider = build[id](url, { apiKey: () => keys.resolve(id) });
      made.set(key, provider);
    }
    return provider;
  };
}

/** Desktop composition root. The service itself depends only on the engine's typed ports. */
export async function createService(options: ServiceOptions) {
  const now = options.now || (() => new Date());
  const store = createStore(options.dataDir);
  const staged = createStagedMemory(store.memory);
  const env: ProviderEnvironment<Buffer> = {
    dataDir: options.dataDir,
    encrypt: options.encrypt,
    decrypt: options.decrypt,
    openExternal: options.openExternal,
    fetch: options.fetch,
    memory: staged.memory,
  };
  const providers: Partial<Record<ProviderKind, MailProvider>> = {};
  for (const [kind, given] of Object.entries(options.providers ?? {}) as Array<
    [
      ProviderKind,
      MailProvider | ((env: ProviderEnvironment<Buffer>) => MailProvider | Promise<MailProvider>),
    ]
  >)
    providers[kind] = typeof given === 'function' ? await given(env) : given;
  providers.google ??=
    options.google ||
    (await createGoogle({
      dataDir: options.dataDir,
      encrypt: options.encrypt,
      decrypt: options.decrypt,
      openExternal: options.openExternal,
    }));
  /** Why a built-in adapter failed to start; one unreadable credential file must not stop the app or the other hosts. */
  const brokenProviders = new Map<ProviderKind, string>();
  const builtIn: Array<[ProviderKind, () => Promise<MailProvider>]> = [
    ['microsoft', () => createMicrosoft(env)],
    ['imap', () => createImap({ ...env, calendar: createCalDav({ fetch: options.fetch }) })],
    ['jmap', () => createJmap(env)],
  ];
  await Promise.all(
    builtIn
      .filter(([kind]) => !providers[kind])
      .map(async ([kind, make]) => {
        try {
          providers[kind] = await make();
        } catch (error) {
          brokenProviders.set(
            kind,
            error instanceof Error ? error.message : 'This account type could not start.',
          );
        }
      }),
  );
  let workflow: Awaited<ReturnType<typeof createWorkflowSync>> | undefined,
    workflowError: string | undefined;
  try {
    workflow = await createWorkflowSync({
      dataDir: options.dataDir,
      encrypt: options.encrypt,
      decrypt: options.decrypt,
      memory: staged.memory,
      now,
    });
  } catch (error) {
    workflowError = error instanceof Error ? error.message : 'Device sync could not start.';
  }
  const keys = await createAiKeys({
    dataDir: options.dataDir,
    encrypt: options.encrypt,
    decrypt: options.decrypt,
    env: options.env,
  });
  const key = (id: AskProviderId) => ({ apiKey: () => keys.resolve(id) });
  return createEngineService({
    appVersion,
    store,
    staged,
    providers,
    brokenProviders,
    workflow,
    workflowError,
    now,
    keys,
    groq: options.groq || createGroq(key('groq')),
    groqModel: options.groq ? undefined : process.env.GROQ_MODEL,
    randomUUID,
    chats: {
      openai: createOpenAI(key('openai')),
      anthropic: createClaude(key('anthropic')),
      gemini: createGemini(key('gemini')),
      openrouter: createOpenRouter(key('openrouter')),
      'opencode-go': createOpenCodeGo(key('opencode-go')),
      ...options.chats,
    },
    serverChat: options.serverChat ?? servers(keys),
    symbols: symbolRenderer(options.symbolTool),
    desktop: options.desktop,
    secure: !!options.encrypt,
    fetch: options.fetch,
    lookup: options.fetch
      ? undefined
      : async host => (await lookup(host, { all: true })).map(a => a.address),
    autoSyncMs: options.autoSyncMs,
  });
}
