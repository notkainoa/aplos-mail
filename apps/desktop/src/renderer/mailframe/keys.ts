// The key relay for the scriptless srcdoc frame. A keydown inside the frame's document never reaches the host's
// document (events do not cross frames), so the host listens on the frame document and relays each key exactly once.
// Only the short list goes out (`FALLBACK_KEYS`: J/K, arrows, Page Up/Down, Home, End, Esc), unmodified: never R, E,
// Space or a letter, so a key typed or tapped in the letter cannot run an app command or start a hold (hold R
// dictates). Keyups are never relayed, and none is needed: no listed key is a hold key. Ctrl and Cmd belong to the
// frame (copy, select all through the Edit menu), and keys typed during IME composition belong to the composer.
// Nothing in the frame is editable (forms are removed). The sealed frame's reporter relays no keys at all (PROTOCOL.md
// "Keys"): its keys arrive from main's `before-input-event` relay (host/protocol/frame-keys.ts), filtered to this same
// list. The two never meet: this one listens inside a same-origin srcdoc frame (development only), and main's fires
// only while the focused frame is an `aplos-mail://m/<token>/` document.

import { MAIL_KEYS } from '../../shared/mail-keys';
import type { MailFrameKey } from './types';

/**
 * The only keys a frame may hand to the shell: non-destructive and never a hold key (research section 7: never E,
 * Space or R). The list is `shared/mail-keys.ts`'s, which main's `before-input-event` relay reads too.
 */
export const FALLBACK_KEYS: ReadonlySet<string> = new Set<string>(MAIL_KEYS);

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
