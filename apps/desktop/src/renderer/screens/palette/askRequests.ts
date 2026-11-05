/**
 * The palette's "Ask about “x”" row hands its question to the Ask dock through here (DESIGN §7.9). The dock is the
 * other half of this lane (`screens/ask`); while nobody subscribes, `PaletteHost` falls back to `askStore.ask`,
 * which carries the same question and bumps the dock's open tick, so the row is never dead.
 */
const listeners = new Set<(question: string) => void>();

/** The Ask row's handoff: every subscriber hears the question (the dock asks it). Returns whether anyone listened. */
export function requestAsk(question: string): boolean {
  for (const listener of listeners) listener(question);
  return listeners.size > 0;
}

/** The Ask dock's subscription; returns the unsubscribe. */
export function onAskRequest(listener: (question: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
