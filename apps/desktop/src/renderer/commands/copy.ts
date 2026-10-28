// DESIGN §9 rule 8, §10 and §14: words no label may use. Matched as plain
// substrings, case-insensitive, so plurals and compounds ("Todos") are caught.

export const BANNED_PHRASES: readonly string[] = [
  'todo',
  'hide all',
  'hold to talk',
  'swipe through them',
  'ask me anything',
  'magic',
  'ai-powered',
  'be here now',
  'sent with',
  'smart',
  'copilot',
  'beta',
];

/** Why a label breaks DESIGN §10, or null when it is fine. */
export function copyProblem(text: string): string | null {
  if (text.includes('!')) return `"${text}" has an exclamation mark`;
  const lower = text.toLowerCase();
  const phrase = BANNED_PHRASES.find(p => lower.includes(p));
  return phrase ? `"${text}" contains "${phrase}"` : null;
}
