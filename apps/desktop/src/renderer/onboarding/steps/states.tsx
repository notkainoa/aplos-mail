/**
 * Preview fixtures for the onboarding steps: every state the harness captures (DESIGN 7.11; plan 30 U8 acceptance 6),
 * drawn by the presentational step components from hand-written contract values. Original demo data only: invented
 * people on example domains, no real mail, addresses, keys or tokens.
 *
 * The gallery (`../preview/`) and the capture script (`../preview/shoot.mjs`) read this table. `height` overrides the
 * window's 600 px for states that check the 640 × 520 minimum (F13).
 */
import type { JSX } from 'react';
import type { AiProvider, Consent } from '../../data';
import { WINDOW_COPY } from '../copy';
import type { StepChrome } from '../flow';
import type { AccountsMode, ChooseNotice } from '../connect';
import { AccountsStep, type AccountRowData } from './Accounts';
import { AiStep } from './Ai';
import {
  aiView,
  initialAi,
  type AiInputs,
  type AiModelInfo,
  type AiState,
  type AiFeatures,
} from './ai.model';
import { PermissionsStep, type PermissionState } from './Permissions';
import { Welcome } from './Welcome';

const noop = () => {};

/** From the AI step on, an account is connected (the fixtures' Add-your-mail step says so with `connected`). */
const chromeAt = (
  step: number,
  demo = false,
  notice?: string,
  connected = step >= 3,
): StepChrome => ({
  dashes: { step, of: 4 },
  connected,
  onBack: noop,
  ...(demo ? { onTryDemo: noop } : {}),
  ...(notice ? { notice: { text: notice, onRetry: noop }, status: notice } : {}),
});

/* ---------- Accounts ---------- */

const JORDAN = 'jordan.lee@example.com';

function accounts(
  mode: AccountsMode,
  over: {
    address?: string;
    notice?: ChooseNotice;
    failure?: string;
    list?: readonly AccountRowData[];
    windowNotice?: string;
  } = {},
): JSX.Element {
  return (
    <AccountsStep
      chrome={chromeAt(2, true, over.windowNotice, (over.list ?? []).length > 0)}
      mode={mode}
      address={over.address ?? ''}
      notice={over.notice ?? null}
      failure={over.failure ?? null}
      accounts={over.list ?? []}
      onEdit={noop}
      onSubmit={noop}
      onConnect={noop}
      onChooseGoogle={noop}
      onCancel={noop}
      onClear={noop}
      onContinue={noop}
      onAddAnother={noop}
    />
  );
}

/* ---------- AI ---------- */

type Row = Omit<AiProvider, 'status' | 'keySource'> &
  Partial<Pick<AiProvider, 'status' | 'keySource'>>;

const hosted = (row: Row): AiProvider => ({
  status: row.keySource && row.keySource !== 'none' ? 'ready' : 'missingKey',
  keySource: 'none',
  ...row,
});

function providerTable(
  over: { groqKey?: AiProvider['keySource']; ollamaRunning?: boolean } = {},
): AiProvider[] {
  const base = {
    keyOptional: false,
    trainsOnInputs: false,
    sttCapable: false,
    local: false,
  } as const;
  return [
    hosted({
      ...base,
      id: 'groq',
      label: 'Groq',
      group: 'hosted',
      envVar: 'GROQ_API_KEY',
      sttCapable: true,
      keySource: over.groqKey ?? 'env',
    }),
    hosted({
      ...base,
      id: 'openai',
      label: 'ChatGPT (OpenAI)',
      group: 'hosted',
      envVar: 'OPENAI_API_KEY',
      sttCapable: true,
    }),
    hosted({
      ...base,
      id: 'anthropic',
      label: 'Claude (Anthropic)',
      group: 'hosted',
      envVar: 'ANTHROPIC_API_KEY',
      keySource: 'keychain',
    }),
    // Free-tier Gemini may learn from what it is sent: the step never offers it for mail.
    hosted({
      ...base,
      id: 'gemini',
      label: 'Gemini',
      group: 'hosted',
      envVar: 'GEMINI_API_KEY',
      trainsOnInputs: true,
    }),
    hosted({
      ...base,
      id: 'openrouter',
      label: 'OpenRouter',
      group: 'hosted',
      envVar: 'OPENROUTER_API_KEY',
    }),
    hosted({
      ...base,
      id: 'opencode-go',
      label: 'OpenCode Go',
      group: 'hosted',
      envVar: 'OPENCODE_API_KEY',
    }),
    {
      ...base,
      id: 'ollama',
      label: 'Ollama',
      group: 'local',
      envVar: 'OLLAMA_API_KEY',
      keyOptional: true,
      keySource: 'none',
      local: true,
      address: 'http://localhost:11434/v1',
      defaultAddress: 'http://localhost:11434/v1',
      running: over.ollamaRunning ?? true,
      status: over.ollamaRunning === false ? 'unreachable' : 'ready',
    },
    {
      ...base,
      id: 'lmstudio',
      label: 'LM Studio',
      group: 'local',
      envVar: 'LM_STUDIO_API_KEY',
      keyOptional: true,
      keySource: 'none',
      local: true,
      address: 'http://localhost:1234/v1',
      defaultAddress: 'http://localhost:1234/v1',
      running: false,
      status: 'unreachable',
    },
    {
      ...base,
      id: 'custom',
      label: 'Custom server',
      group: 'local',
      envVar: 'CUSTOM_AI_API_KEY',
      keyOptional: true,
      keySource: 'none',
      status: 'notConfigured',
    },
  ];
}

const MODELS: Record<string, readonly AiModelInfo[]> = {
  groq: [
    { id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B', tools: true },
    { id: 'whisper-large-v3-turbo', label: 'Whisper Large v3 Turbo', stt: true },
  ],
  anthropic: [{ id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', tools: true }],
  ollama: [
    { id: 'llama3.2:3b', label: 'llama3.2:3b' },
    { id: 'qwen3:8b', label: 'qwen3:8b' },
  ],
};

const FEATURES: AiFeatures = {
  ask: { provider: 'groq', model: 'openai/gpt-oss-120b' },
  summaries: { provider: 'groq', model: 'openai/gpt-oss-120b' },
  drafts: { provider: 'groq', model: 'openai/gpt-oss-120b' },
  plans: { provider: 'groq', model: 'openai/gpt-oss-120b' },
  voice: { provider: 'groq', model: 'whisper-large-v3-turbo' },
};

const NO_CONSENT: Consent = {
  scope: 'background',
  granted: false,
  version: 0,
  currentVersion: 1,
  needsReconsent: false,
};

function ai(state: AiState, providers: AiProvider[] = providerTable()): JSX.Element {
  const inputs: AiInputs = { providers, models: MODELS, features: FEATURES, consent: NO_CONSENT };
  return (
    <AiStep
      chrome={chromeAt(3)}
      vm={aiView(state, inputs)}
      moreOpen={state.moreOpen}
      onToggleMore={noop}
      onOpenHosted={noop}
      onOpenLocal={noop}
      onChoose={noop}
      onCheck={noop}
      onPickModel={noop}
      onEditKey={noop}
      onSaveKey={noop}
      onEditAddress={noop}
      onSaveAddress={noop}
      onContinue={noop}
      onSkip={noop}
      onAllow={noop}
      onNotNow={noop}
    />
  );
}

const aiState = (over: Partial<AiState>): AiState => ({ ...initialAi(), ...over });

/* ---------- Permissions ---------- */

function permissions(
  microphone: PermissionState,
  notifications: PermissionState,
  openAtLogin: boolean,
  notice?: string,
): JSX.Element {
  return (
    <PermissionsStep
      chrome={chromeAt(4, false, notice)}
      microphone={microphone}
      notifications={notifications}
      openAtLogin={openAtLogin}
      voiceProvider="Groq"
      onAllow={noop}
      onOpenSettings={noop}
      onOpenAtLogin={noop}
      onFinish={noop}
    />
  );
}

/* ---------- The table ---------- */

export const stepStates: Record<
  string,
  { title: string; render: () => JSX.Element; height?: number }
> = {
  welcome: {
    title: 'Welcome',
    render: () => <Welcome chrome={chromeAt(1, true)} onAddAccount={noop} onSkip={noop} />,
  },
  'welcome-handoff-failed': {
    title: 'Welcome · Skip setup, the mail window did not open (Try again; review1)',
    render: () => (
      <Welcome
        chrome={chromeAt(1, false, WINDOW_COPY.handoffFailed)}
        onAddAccount={noop}
        onSkip={noop}
      />
    ),
  },
  'accounts-choose': { title: 'Accounts · choose', render: () => accounts('choose') },
  'accounts-demo-failed': {
    title: 'Accounts · demo mail did not load (Try again; review1)',
    render: () => accounts('choose', { windowNotice: WINDOW_COPY.demoFailed }),
  },
  'accounts-failed-no-code': {
    title: 'Accounts · sign-in refused without a reason (review1)',
    render: () => accounts('failed', { address: JORDAN }),
  },
  'accounts-typed': {
    title: 'Accounts · typed (Google found)',
    render: () => accounts('typed', { address: JORDAN }),
  },
  'accounts-waiting': { title: 'Accounts · waiting for Google', render: () => accounts('waiting') },
  'accounts-connected': {
    title: 'Accounts · connected',
    render: () =>
      accounts('connected', {
        list: [{ id: 'acct-1', address: JORDAN, demo: false, color: 'sky' }],
      }),
  },
  'accounts-failed': {
    title: 'Accounts · sign-in declined',
    render: () => accounts('failed', { address: JORDAN, failure: 'auth.denied' }),
  },
  'accounts-unsupported': {
    title: 'Accounts · not a Google address',
    render: () => accounts('choose', { address: 'jordan.lee@example.org', notice: 'unsupported' }),
  },
  'ai-groq-env': {
    title: 'AI · Groq key from the environment',
    render: () => ai(aiState({ tests: { groq: { kind: 'works', ms: 412 } } })),
  },
  'ai-groq-key-field': {
    title: 'AI · Groq without a key',
    render: () => ai(initialAi(), providerTable({ groqKey: 'none' })),
  },
  'ai-more-options': {
    title: 'AI · More options open',
    render: () => ai(aiState({ moreOpen: true })),
  },
  'ai-hosted': {
    title: 'AI · another provider (no key yet)',
    render: () => ai(aiState({ view: 'hosted', chosen: 'openai' })),
  },
  'ai-local': {
    title: 'AI · a model on this Mac',
    render: () => ai(aiState({ view: 'local', chosen: 'ollama' })),
  },
  'ai-consent': {
    title: 'AI · consent card',
    render: () => ai(aiState({ view: 'consent', consentFrom: 'pick' })),
  },
  'permissions-default': {
    title: 'Voice and permissions',
    render: () => permissions('notDetermined', 'notDetermined', false),
  },
  'permissions-granted': {
    title: 'Voice and permissions · allowed',
    render: () => permissions('granted', 'granted', true),
  },
  'permissions-handoff-failed': {
    title:
      'Voice and permissions · Finish setup, the mail window did not open (Try again; review1)',
    render: () => permissions('notDetermined', 'notDetermined', false, WINDOW_COPY.handoffFailed),
  },
  'ai-key-save-failed': {
    title: 'AI · the key could not be saved on this Mac (review1)',
    render: () => ai(aiState({ keyFailure: 'unknown' }), providerTable({ groqKey: 'none' })),
  },
  'permissions-denied': {
    title:
      'Voice and permissions · microphone blocked by macOS (where to turn it on, Open System Settings)',
    render: () => permissions('denied', 'notDetermined', false),
  },
  'window-long-content': {
    title: 'Long step at the 640 × 520 minimum (F13)',
    height: 520,
    render: () => ai(aiState({ view: 'local', chosen: 'ollama', moreOpen: true })),
  },
};
