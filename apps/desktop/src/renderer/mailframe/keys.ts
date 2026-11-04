// The key relay for the scriptless srcdoc frame. A keydown inside the frame's document never reaches the host's
// document (events do not cross frames), so the host listens on the frame document and relays each key exactly once.
// Only the sealed frame's short list goes out (protocol.ts `FALLBACK_KEYS`: J/K, arrows, Page Up/Down, Home, End,
// Esc), unmodified: never R, E, Space or a letter, so a key typed or tapped in the letter cannot run an app command or
// start a hold (hold R dictates). Keyups are never relayed, and none is needed: no listed key is a hold key. Ctrl and
// Cmd belong to the frame (copy, select all through the Edit menu), and keys typed during IME composition belong to
// the composer. Nothing in the frame is editable (forms are removed).

import { FALLBACK_KEYS } from './protocol';
import type { MailFrameKey } from './types';

/** The parts of a KeyboardEvent the relay reads and may cancel. Duck-typed: the event comes from the frame realm. */
export interface RelayableKeyEvent {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  isComposing: boolean;
  defaultPrevented: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

/** The relayed key, or null for a key that stays in the frame. */
export function relayableKey(event: RelayableKeyEvent): MailFrameKey | null {
  if (event.ctrlKey || event.metaKey || event.isComposing || event.defaultPrevented) return null;
  if (!FALLBACK_KEYS.has(event.key)) return null;
  return { key: event.key, shift: event.shiftKey, alt: event.altKey };
}

/**
 * Relay one keydown to the shell. A handled key is cancelled in the frame and marked handled with `preventDefault`,
 * so a second listener on the same event cannot relay it again.
 */
export function relayKey(
  event: RelayableKeyEvent,
  onKey: (key: MailFrameKey) => boolean | void,
): boolean {
  const key = relayableKey(event);
  if (!key) return false;
  const handled = onKey(key) === true;
  if (handled) {
    event.preventDefault();
    event.stopPropagation();
  }
  return handled;
}
