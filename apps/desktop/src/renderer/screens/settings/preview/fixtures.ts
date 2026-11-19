/**
 * Fixtures for the Settings gallery and tests: contract-typed values written by hand from original demo data
 * (invented people on example domains, no real mail, addresses, keys or tokens). Times are relative to the harness
 * clock (2026-10-29 10:00 in Los Angeles), so every state reads the same on every machine.
 */
import type { Account, AiProvider, Calendar, Consent, Session, Settings } from '../../../data';
import { HARNESS_NOW_MS } from '../../../data';
import { CALENDAR_EVENTS_SCOPE } from '../../calendar/accountCalendarState';
import type {
  AiModelInfo,
  AiUsageInfo,
  BundleInfo,
  ClientEntry,
  QueueEntry,
} from '../settings.model';

export const NOW = HARNESS_NOW_MS;
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** A stand-in for a secret: the tests plant it where a key could leak and require it never reaches the DOM. */
export const CANARY = 'gsk_CANARY_0123456789abcdefSECRET';

export function baseSettings(): Settings {
  const groq = (model: string) => ({ provider: 'groq', model });
  return {
    ui: {
      theme: 'system',
      density: 'default',
      keyHints: 'tooltip',
      singleKeys: true,
      holdMs: 250,
      dock: { open: false, tab: 'ask' },
      keymap: {},
      sidebarMinimised: false,
      swipe: true,
      swipeDirection: 'doneRight',
      zen: false,
      sendSound: true,
      devDetails: false,
      lastAccount: 'all',
      palette: { recents: [] },
      calendar: {},
    },
    mail: {
      undoSendSeconds: 8,
      followUpDays: 3,
      remoteImages: 'block',
      imageAllowList: ['newsletter@example.org', '@example.net'],
      doneAction: 'archive',
      laterAction: 'read',
      lowAction: 'archive',
      defaultReply: 'reply',
      signature: '',
      signatureMode: 'new',
      footer: false,
      autoPolish: false,
    },
    notifications: { enabled: true, perAccount: {}, reminders: true, reconnectReminder: false },
    host: { menuBar: true, openAtLogin: true, microphone: 'default' },
    retention: { bodyDays: 90, maxBodyBytes: 2 * 1024 ** 3 },
    calendar: { autoAddPlans: false, providerEventsFromMail: true },
    ai: {
      features: {
        ask: groq('openai/gpt-oss-120b'),
        summaries: groq('openai/gpt-oss-20b'),
        drafts: groq('openai/gpt-oss-120b'),
        plans: groq('openai/gpt-oss-120b'),
        voice: groq('whisper-large-v3-turbo'),
      },
      providers: {},
      background: true,
      dailyCap: { enabled: true, tokens: 150_000 },
    },
  };
}

const capabilities = {
  labels: true,
  folders: false,
  drafts: true,
  serverSearch: true,
  calendar: true,
  filters: true,
  push: true,
  sendAs: true,
  unsubscribeHeaders: true,
};

export function account(over: Partial<Account> & { id: string; address: string }): Account {
  return {
    rev: 1,
    provider: 'google',
    name: over.address,
    colorTag: 'sky',
    demo: false,
    health: { status: { state: 'ok' }, lastSyncAt: NOW - 2 * MIN },
    capabilities,
    grantedScopes: [],
    aiAllowed: true,
    notifications: true,
    lease: { role: 'primary', holderDeviceName: 'MacBook Pro' },
    identities: [],
    pendingChanges: 0,
    baselineDoneAt: NOW - DAY,
    calendarListedAt: NOW - DAY,
    createdAt: NOW - 30 * DAY,
    ...over,
  };
}

export const ALEX = account({ id: 'acct-alex', address: 'alex.moreno@example.com' });
export const JORDAN = account({
  id: 'acct-jordan',
  address: 'jordan.lee@example.com',
  colorTag: 'hill',
  aiAllowed: false,
});
export const DEMO = account({
  id: 'acct-demo',
  address: 'demo@example.com',
  name: 'Demo mail',
  provider: 'demo',
  demo: true,
  colorTag: 'sand',
  lease: undefined,
});

export function needsReauth(a: Account): Account {
  return {
    ...a,
    health: {
      status: { state: 'needsReauth', reason: 'invalid_grant' },
      reasonCode: 'auth.expired',
      lastSyncAt: NOW - 3 * HOUR,
    },
  };
}
export function reconnectIn(a: Account, ms: number): Account {
  return { ...a, health: { ...a.health, reconnectBy: NOW + ms } };
}

/** The grant that lets the account change events: the events scope sits in `grantedScopes`. */
export function editingOn(a: Account): Account {
  return { ...a, grantedScopes: [...a.grantedScopes, CALENDAR_EVENTS_SCOPE] };
}

/** A write was refused for lack of the events scope: the account carries the calendarWrite row. */
export function writeRefused(a: Account): Account {
  return {
    ...a,
    missingPermissions: [{ capability: 'calendarWrite', reasonCode: 'permission.calendarWrite' }],
  };
}

/** A non-Google account: no calendar claim at all. */
export const IMAP = account({
  id: 'acct-river',
  address: 'river.pale@example.net',
  provider: 'imap',
  colorTag: 'dusk',
  capabilities: { ...capabilities, calendar: false },
  lease: undefined,
  calendarListedAt: undefined,
});

/** One calendar, for the calendar-access states `calendarAccessOf` reads (`Calendar/get`). */
export function calendar(
  over: Partial<Calendar> & { id: string; accountId: string; name: string },
): Calendar {
  return {
    primary: false,
    readOnly: false,
    shown: true,
    providerHidden: false,
    ...over,
  };
}

/** Two calendars on Alex, one on Jordan: "Calendar on · 2 calendars" and the singular "1 calendar". */
export const ALEX_CALENDARS: readonly Calendar[] = [
  calendar({
    id: 'cal-alex-work',
    accountId: ALEX.id,
    name: 'Work',
    colorTag: 'hill',
    primary: true,
  }),
  calendar({ id: 'cal-alex-personal', accountId: ALEX.id, name: 'Personal' }),
];
export const JORDAN_CALENDARS: readonly Calendar[] = [
  calendar({ id: 'cal-jordan', accountId: JORDAN.id, name: 'Jordan', colorTag: 'hill' }),
];
export function calendars(): readonly Calendar[] {
  return [...ALEX_CALENDARS, ...JORDAN_CALENDARS];
}

export function session(over: Partial<Session> = {}): Session {
  return {
    apiVersion: 1,
    appVersion: '0.3.0',
    schemaVersion: 1,
    dbEpoch: 'epoch-1',
    state: { dbEpoch: 'epoch-1', seq: 1 },
    engine: { state: 'ready', resident: false },
    capabilities: {
      desktop: true,
      listener: true,
      clients: true,
      diagnostics: true,
      queueInspector: true,
      calendar: true,
      calendarWrite: true,
      notifications: true,
      loginItem: true,
      menuBar: true,
      workflowSync: true,
      microphone: true,
      transcribe: true,
    },
    providers: [{ kind: 'google', available: true }],
    hasAccounts: true,
    setup: { completedAt: NOW - 30 * DAY },
    now: NOW,
    device: { id: 'device-pro', name: 'MacBook Pro' },
    ...over,
  };
}

export function consent(over: Partial<Consent> = {}): Consent {
  return {
    scope: 'background',
    granted: true,
    version: 1,
    currentVersion: 1,
    needsReconsent: false,
    provider: 'groq',
    model: 'openai/gpt-oss-20b',
    grantedAt: NOW - 20 * DAY,
    ...over,
  };
}

const row = (
  id: string,
  label: string,
  group: 'hosted' | 'local',
  envVar: string,
  over: Partial<AiProvider> = {},
): AiProvider => ({
  id,
  label,
  group,
  status: 'missingKey',
  keySource: 'none',
  envVar,
  keyOptional: group === 'local',
  trainsOnInputs: false,
  sttCapable: false,
  local: false,
  ...over,
});

/** Groq from the environment, OpenAI and OpenRouter in the Keychain, the rest unset; Ollama running, LM Studio not. */
export function providers(): AiProvider[] {
  return [
    row('groq', 'Groq', 'hosted', 'GROQ_API_KEY', {
      status: 'ready',
      keySource: 'env',
      sttCapable: true,
    }),
    row('openai', 'ChatGPT (OpenAI)', 'hosted', 'OPENAI_API_KEY', {
      status: 'ready',
      keySource: 'keychain',
      sttCapable: true,
    }),
    row('anthropic', 'Claude (Anthropic)', 'hosted', 'ANTHROPIC_API_KEY'),
    row('gemini', 'Gemini', 'hosted', 'GEMINI_API_KEY', {
      trainsOnInputs: true,
      paidMarked: false,
    }),
    row('openrouter', 'OpenRouter', 'hosted', 'OPENROUTER_API_KEY', {
      status: 'ready',
      keySource: 'keychain',
    }),
    row('opencode-go', 'OpenCode Go', 'hosted', 'OPENCODE_API_KEY'),
    row('ollama', 'Ollama', 'local', 'OLLAMA_API_KEY', {
      status: 'ready',
      address: 'http://localhost:11434/v1',
      defaultAddress: 'http://localhost:11434/v1',
      running: true,
      local: true,
    }),
    row('lmstudio', 'LM Studio', 'local', 'LM_STUDIO_API_KEY', {
      status: 'unreachable',
      address: 'http://localhost:1234/v1',
      defaultAddress: 'http://localhost:1234/v1',
      running: false,
      local: true,
    }),
    row('custom', 'Custom server', 'local', 'CUSTOM_AI_API_KEY', { status: 'notConfigured' }),
  ];
}

export function models(): Record<string, AiModelInfo[]> {
  return {
    groq: [
      { id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B', tools: true },
      { id: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B', tools: true },
      { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B', tools: true },
      { id: 'whisper-large-v3-turbo', label: 'Whisper Large v3 Turbo', stt: true },
      { id: 'whisper-large-v3', label: 'Whisper Large v3', stt: true },
    ],
    openai: [
      { id: 'gpt-5-mini', label: 'GPT-5 mini', tools: true },
      { id: 'gpt-5', label: 'GPT-5', tools: true },
      { id: 'gpt-4o-transcribe', label: 'GPT-4o Transcribe', stt: true },
      { id: 'whisper-1', label: 'Whisper', stt: true },
    ],
    openrouter: [{ id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B', tools: true }],
    ollama: [
      { id: 'llama3.2:3b', label: 'Llama 3.2 3B', tools: true },
      { id: 'qwen3:8b', label: 'Qwen 3 8B', tools: true },
    ],
  };
}

export function usage(over: Partial<AiUsageInfo> = {}): AiUsageInfo {
  return { day: '2026-10-29', backgroundTokens: 12_400, cap: 150_000, byModel: [], ...over };
}

export function clients(): ClientEntry[] {
  return [
    {
      id: 'client-cli',
      name: 'Terminal assistant',
      kind: 'cli',
      scopes: ['read', 'draft'],
      createdAt: NOW - 9 * DAY,
      lastSeenAt: NOW - 14 * MIN,
    },
    {
      id: 'client-mcp',
      name: 'Notes helper',
      kind: 'mcp',
      scopes: ['read'],
      createdAt: NOW - 2 * DAY,
    },
  ];
}

export function queue(): QueueEntry[] {
  return [
    {
      id: 'q-op',
      kind: 'op',
      label: 'Archive 3 threads',
      accountId: ALEX.id,
      state: 'failed',
      attempts: 3,
      createdAt: NOW - 40 * MIN,
      problem: {
        reasonCode: 'rate.minute',
        message: 'PROVIDER SAYS: userRateLimitExceeded for alex.moreno@example.com',
      },
      canRetry: true,
      canDiscard: true,
      scope: 'triage',
    },
    {
      id: 'q-job',
      kind: 'job',
      label: 'Summary',
      accountId: ALEX.id,
      state: 'dead',
      attempts: 5,
      createdAt: NOW - 3 * HOUR,
      problem: { reasonCode: 'ai.missingKey' },
      canRetry: true,
      canDiscard: true,
      scope: 'ai',
    },
    {
      id: 'q-send',
      kind: 'submission',
      label: 'Message to 1 person',
      accountId: ALEX.id,
      state: 'failed',
      attempts: 1,
      createdAt: NOW - 25 * MIN,
      problem: { reasonCode: 'net.offline' },
      canRetry: true,
      canDiscard: true,
      scope: 'send',
    },
  ];
}

export function bundle(): BundleInfo {
  return {
    generatedAt: NOW,
    versions: { app: '0.3.0', api: 1, schema: 1, os: 'macOS 15.1' },
    engine: { state: 'ready', uptimeMs: 5 * HOUR },
    accounts: [
      {
        accountHash: 'a1b2c3d4e5f60718',
        provider: 'google',
        state: 'ok',
        lastSyncAt: NOW - 2 * MIN,
        budgets: [],
      },
    ],
    queues: { ops: 1, jobs: 2, submissions: 0, failed: 2 },
    errors: [],
    storage: {
      dbBytes: 412 * 1024 ** 2,
      walBytes: 8 * 1024 ** 2,
      ftsBacklog: 0,
      bodyBytes: 640 * 1024 ** 2,
      attachmentBytes: 120 * 1024 ** 2,
    },
    crashes: { count: 0 },
  };
}
