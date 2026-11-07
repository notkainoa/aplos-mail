import type { ModelRef } from '@aplos/contract';

/**
 * The provider catalog (AGENTS.md): ids, labels, env vars and the two privacy facts every gate needs —
 * `trainsOnInputs` (background mail content never goes there; free-tier Gemini counts true until `paid` is marked)
 * and `keyOptional` (local servers). The host's transports mirror this table; keep them in step.
 */
export interface ProviderRow {
  id: ModelRef['provider'];
  label: string;
  group: 'hosted' | 'local';
  envVar: string;
  keyOptional: boolean;
  /** Base of `trainsOnInputs` before the paid-key mark; resolved by `trainsOnInputs`. */
  trains: boolean;
  stt: boolean;
  defaultAddress?: string;
}

export const PROVIDER_ROWS: readonly ProviderRow[] = [
  {
    id: 'groq',
    label: 'Groq',
    group: 'hosted',
    envVar: 'GROQ_API_KEY',
    keyOptional: false,
    trains: false,
    stt: true,
  },
  {
    id: 'openai',
    label: 'OpenAI',
    group: 'hosted',
    envVar: 'OPENAI_API_KEY',
    keyOptional: false,
    trains: false,
    stt: true,
  },
  {
    id: 'anthropic',
    label: 'Claude',
    group: 'hosted',
    envVar: 'ANTHROPIC_API_KEY',
    keyOptional: false,
    trains: false,
    stt: false,
  },
  {
    id: 'gemini',
    label: 'Gemini',
    group: 'hosted',
    envVar: 'GEMINI_API_KEY',
    keyOptional: false,
    trains: true,
    stt: false,
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    group: 'hosted',
    envVar: 'OPENROUTER_API_KEY',
    keyOptional: false,
    trains: false,
    stt: false,
  },
  {
    id: 'opencode-go',
    label: 'OpenCode Go',
    group: 'hosted',
    envVar: 'OPENCODE_API_KEY',
    keyOptional: false,
    trains: false,
    stt: false,
  },
  {
    id: 'ollama',
    label: 'Ollama',
    group: 'local',
    envVar: 'OLLAMA_API_KEY',
    keyOptional: true,
    trains: false,
    stt: false,
    defaultAddress: 'http://localhost:11434',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    group: 'local',
    envVar: 'LM_STUDIO_API_KEY',
    keyOptional: true,
    trains: false,
    stt: false,
    defaultAddress: 'http://localhost:1234',
  },
  {
    id: 'custom',
    label: 'Custom server',
    group: 'local',
    envVar: 'CUSTOM_AI_API_KEY',
    keyOptional: true,
    trains: false,
    stt: false,
  },
];

export const providerRow = (id: string): ProviderRow | undefined =>
  PROVIDER_ROWS.find(r => r.id === id);

/**
 * Mail content never goes to a provider marked `trainsOnInputs` (ARCH 8.3). Gemini's free tier trains until the
 * owner marks the key paid (`settings.ai.providers.gemini.paid`).
 */
export function trainsOnInputs(id: string, paid?: boolean): boolean {
  const row = providerRow(id);
  if (!row) return false;
  return row.trains && !(id === 'gemini' && paid === true);
}

/** The provider's configured or default address (local servers). */
export function providerAddress(
  id: string,
  configured: { address?: string } | undefined,
): string | undefined {
  return configured?.address || providerRow(id)?.defaultAddress;
}

/** True when the address is loopback — mail never leaves this Mac there (freeze FR-5). */
export function isLoopback(address: string): boolean {
  try {
    const host = new URL(address).hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host);
  } catch {
    return false;
  }
}

/** `YYYY-MM-DD` in local time, the `ai_usage.day` stamp. */
export function localDay(now: number): string {
  const at = new Date(now);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}
