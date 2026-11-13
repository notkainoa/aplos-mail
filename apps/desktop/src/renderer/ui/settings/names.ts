/** Fixed copy for Settings → AI (DESIGN 7.10, AGENTS.md): provider and feature names, and what each feature does. */
import type { AiFeature, KeySource, ProviderId } from '../props';

export const PROVIDER_NAMES: Record<ProviderId, string> = {
  groq: 'Groq',
  openai: 'OpenAI',
  anthropic: 'Claude',
  gemini: 'Gemini',
  openrouter: 'OpenRouter',
  'opencode-go': 'OpenCode Go',
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

/**
 * Where a key comes from, in words. Key characters are never shown, so none are ever passed in. The variable name is
 * technical: the screen passes it only when Developer details is on, and an empty name leaves it out.
 */
export function keySourceText(source: KeySource): string {
  switch (source.kind) {
    case 'environment':
      return source.variable ? `Key set on this Mac · ${source.variable}` : 'Key set on this Mac';
    case 'keychain':
      return 'Saved in Keychain';
    case 'none':
      return source.variable ? `No key yet · reads ${source.variable}` : 'No key yet';
    case 'local':
      return 'On this Mac · no key needed';
  }
}

/** Why a key set outside Aplos cannot be removed here; the variable is named only when the screen passes it. */
export function envKeyReason(variable: string): string {
  return variable
    ? `This key comes from ${variable} in your environment. Remove it there.`
    : 'This key is set outside Aplos, so it can only be removed where it was set.';
}
