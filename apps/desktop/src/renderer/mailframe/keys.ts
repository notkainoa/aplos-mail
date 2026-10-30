// The key relay for the scriptless srcdoc frame. A keydown inside the frame's document never reaches the host's
// document (events do not cross frames), so the host listens on the frame document and relays each key exactly once.
// Only unmodified keys go out: Ctrl and Cmd belong to the frame (copy, select all through the Edit menu), and keys
// typed during IME composition belong to the composer. Nothing in the frame is editable (forms are removed).

import type { MailFrameKey } from './types';

/** Keys that are not keys on their own: modifiers, locks, dead keys and IME placeholders. */
const NOT_A_KEY = new Set([
  'Shift',
  'Control',
  'Alt',
  'AltGraph',
  'Meta',
  'OS',
  'Super',
  'Hyper',
  'Fn',
  'FnLock',
  'CapsLock',
  'NumLock',
  'ScrollLock',
  'Dead',
  'Process',
  'Unidentified',
]);

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
  if (!event.key || NOT_A_KEY.has(event.key)) return null;
  return { key: event.key, shift: event.shiftKey, alt: event.altKey };
}

/**
 * Relay one keydown to the shell. A handled key is cancelled in the frame (Space must not scroll the frame) and marked
 * handled with `preventDefault`, so a second listener on the same event cannot relay it again.
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
