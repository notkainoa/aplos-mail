import type { AiProvider, Output, Settings } from '@aplos/contract';

type AiModel = Output<'Ai/models'>['list'][number];

/** First-run settings: today's defaults carried into the v1 sections. Groq is the default for every AI feature. */
export function defaultSettings(): Settings {
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
      imageAllowList: [],
      doneAction: 'archive',
      laterAction: 'read',
      lowAction: 'archive',
      defaultReply: 'reply',
      signature: 'Warmly,\nAlex',
      signatureMode: 'new',
      footer: false,
      autoPolish: false,
    },
    notifications: { enabled: true, perAccount: {}, reminders: true, reconnectReminder: false },
    host: { menuBar: true, openAtLogin: false, microphone: 'default' },
    retention: { bodyDays: 90, maxBodyBytes: 2 * 1024 ** 3 },
    calendar: { autoAddPlans: false, providerEventsFromMail: true },
    ai: {
      features: {
        ask: groq('openai/gpt-oss-120b'),
        summaries: groq('openai/gpt-oss-120b'),
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

/** Settings → AI's provider table. Status only: the fixture never sees a key, and reports Groq as configured from the environment. */
const providerRows: Omit<AiProvider, 'status' | 'keySource'>[] = [
  {
    id: 'groq',
    label: 'Groq',
    group: 'hosted',
    envVar: 'GROQ_API_KEY',
    keyOptional: false,
    trainsOnInputs: false,
    sttCapable: true,
    local: false,
  },
  {
    id: 'openai',
    label: 'ChatGPT (OpenAI)',
    group: 'hosted',
    envVar: 'OPENAI_API_KEY',
    keyOptional: false,
    trainsOnInputs: false,
    sttCapable: true,
    local: false,
  },
  {
    id: 'anthropic',
    label: 'Claude (Anthropic)',
    group: 'hosted',
    envVar: 'ANTHROPIC_API_KEY',
    keyOptional: false,
    trainsOnInputs: false,
    sttCapable: false,
    local: false,
  },
  {
    id: 'gemini',
    label: 'Gemini',
    group: 'hosted',
    envVar: 'GEMINI_API_KEY',
    keyOptional: false,
    trainsOnInputs: true,
    paidMarked: false,
    sttCapable: false,
    local: false,
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    group: 'hosted',
    envVar: 'OPENROUTER_API_KEY',
    keyOptional: false,
    trainsOnInputs: false,
    sttCapable: false,
    local: false,
  },
  {
    id: 'opencode-go',
    label: 'OpenCode Go',
    group: 'hosted',
    envVar: 'OPENCODE_API_KEY',
    keyOptional: false,
    trainsOnInputs: false,
    sttCapable: false,
    local: false,
  },
  {
    id: 'ollama',
    label: 'Ollama',
    group: 'local',
    envVar: 'OLLAMA_API_KEY',
    keyOptional: true,
    address: 'http://localhost:11434/v1',
    defaultAddress: 'http://localhost:11434/v1',
    running: false,
    trainsOnInputs: false,
    sttCapable: false,
    local: true,
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    group: 'local',
    envVar: 'LM_STUDIO_API_KEY',
    keyOptional: true,
    address: 'http://localhost:1234/v1',
    defaultAddress: 'http://localhost:1234/v1',
    running: false,
    trainsOnInputs: false,
    sttCapable: false,
    local: true,
  },
  {
    id: 'custom',
    label: 'Custom server',
    group: 'local',
    envVar: 'CUSTOM_AI_API_KEY',
    keyOptional: true,
    trainsOnInputs: false,
    sttCapable: false,
    local: false,
  },
];

export function aiProviders(
  keys: Record<string, { keySource: 'env' | 'keychain' | 'none' }>,
): AiProvider[] {
  return providerRows.map(row => {
    const key = keys[row.id] ?? { keySource: 'none' as const };
    const status =
      row.group === 'local'
        ? row.id === 'custom'
          ? 'notConfigured'
          : 'unreachable'
        : key.keySource === 'none'
          ? 'missingKey'
          : 'ready';
    return { ...row, status, keySource: key.keySource };
  });
}

export const curatedModels: Record<string, AiModel[]> = {
  groq: [
    { id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B', tools: true },
    { id: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B', tools: true },
    { id: 'whisper-large-v3-turbo', label: 'Whisper Large v3 Turbo', stt: true },
  ],
  openai: [
    { id: 'gpt-5-mini', label: 'GPT-5 mini', tools: true },
    { id: 'gpt-4o-mini-transcribe', label: 'GPT-4o mini Transcribe', stt: true },
  ],
  anthropic: [
    { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', tools: true },
    { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', tools: true },
  ],
  gemini: [{ id: 'gemini-flash', label: 'Gemini Flash', tools: true }],
  openrouter: [{ id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B', tools: true }],
  'opencode-go': [{ id: 'kimi-k3', label: 'Kimi K3', tools: true }],
  ollama: [],
  lmstudio: [],
  custom: [],
};

/** `Session/get.capabilities`: what this stand-in serves. An absent key means unavailable (plan 30 section 8.1 item 9). */
export const capabilities: Record<string, boolean> = {
  desktop: false,
  mailFrame: true,
  listener: true,
  clients: true,
  mcp: false,
  diagnostics: true,
  queueInspector: true,
  calendar: true,
  calendarWrite: true,
  remoteSearch: true,
  transcribe: true,
  microphone: false,
  notifications: false,
  loginItem: false,
  menuBar: false,
  workflowSync: false,
  unsubscribeOneClick: true,
  eventFollowingScope: false,
};
