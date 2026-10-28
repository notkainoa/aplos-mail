/** Fixed copy for Settings → AI (DESIGN 7.10, AGENTS.md): provider and feature names, and what each feature does. */
import type { AiFeature, KeySource, ProviderId } from '../props';

export const PROVIDER_NAMES: Record<ProviderId, string> = {
  groq: 'Groq',
  openai: 'OpenAI',
  anthropic: 'Claude',
  gemini: 'Gemini',
  openrouter: 'OpenRouter',
  opencode: 'OpenCode Go',
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  custom: 'Custom server',
};

export const FEATURE_COPY: Record<AiFeature, { label: string; description: string }> = {
  ask: { label: 'Ask', description: 'Answers about your mail and calendar.' },
  summaries: { label: 'Summaries', description: 'One-line digests on Home and in the reader.' },
  drafts: { label: 'Drafts', description: 'First drafts of replies, for you to edit.' },
  plans: { label: 'Plans', description: 'Finds plans in mail and proposes events.' },
  voice: { label: 'Voice', description: 'Turns speech into text for dictation.' },
};

/** Where a key comes from, in words. Key characters are never shown, so none are ever passed in. */
export function keySourceText(source: KeySource): string {
  switch (source.kind) {
    case 'environment':
      return `From environment: ${source.variable}`;
    case 'keychain':
      return 'Saved in Keychain';
    case 'none':
      return `Not set · reads ${source.variable}`;
    case 'local':
      return 'On this Mac · no key needed';
  }
}
