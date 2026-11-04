// The short key list a sealed mail frame may hand to the shell, and the one narrow message that carries it (html-5).
// One source of truth for three readers: the renderer's srcdoc relay (`renderer/mailframe/keys.ts`), main's
// `before-input-event` relay (`host/protocol/frame-keys.ts`) and preload's delivery (`main/preload.ts`). It lives in
// `shared/` because main may not import the renderer and the renderer may not import main. No import, no Electron.

/**
 * The only keys a mail frame may hand to the shell: non-destructive and never a hold key. Never E, R, Space, Enter,
 * Delete, Backspace or a letter that runs a command (research section 7).
 */
export const MAIL_KEYS = [
  'j',
  'k',
  'J',
  'K',
  'ArrowUp',
  'ArrowDown',
  'PageUp',
  'PageDown',
  'Home',
  'End',
  'Escape',
] as const;

export type MailKey = (typeof MAIL_KEYS)[number];

/** The IPC channel main sends on and preload listens on. */
export const MAIL_KEY_CHANNEL = 'aplos:mail-key';

/** The event type preload hands to `window.aplos.subscribe` listeners. */
export const MAIL_KEY_EVENT = 'mail-key';

/** The one message that crosses: a key from the list and nothing else. */
export interface MailKeyMessage {
  key: MailKey;
}

const KEYS: ReadonlySet<string> = new Set(MAIL_KEYS);

export function isMailKey(value: unknown): value is MailKey {
  return typeof value === 'string' && KEYS.has(value);
}

/** The parts of Electron's `Input` the relay reads (duck-typed so this file stays free of Electron). */
export interface RelayableInput {
  type: string;
  key: string;
  shift: boolean;
  control: boolean;
  alt: boolean;
  meta: boolean;
  isComposing: boolean;
  isAutoRepeat: boolean;
}

/**
 * The relayed key for one `before-input-event` input, or null for everything that stays in the frame: key-ups, auto
 * repeats (neither `keys.ts` nor PROTOCOL.md relays a held key), composition, and any Ctrl, Cmd or Alt combination.
 * Shift is allowed only where it makes the capital J or K.
 */
export function mailKeyOfInput(input: RelayableInput): MailKey | null {
  if (input.type !== 'keyDown' || input.isAutoRepeat || input.isComposing) return null;
  if (input.control || input.alt || input.meta) return null;
  if (!isMailKey(input.key)) return null;
  if (input.shift && input.key !== 'J' && input.key !== 'K') return null;
  return input.key;
}

/**
 * A received message as a `MailKeyMessage`, or null: a plain object whose only own key is a data property `key` with
 * a listed value. Main checks before it sends and preload before it delivers, so a forged message is dropped at both.
 */
export function parseMailKeyMessage(value: unknown): MailKeyMessage | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return null;
  const names = Reflect.ownKeys(value);
  if (names.length !== 1 || names[0] !== 'key') return null;
  const descriptor = Object.getOwnPropertyDescriptor(value, 'key');
  if (!descriptor || !('value' in descriptor)) return null;
  return isMailKey(descriptor.value) ? { key: descriptor.value } : null;
}

/** The event preload delivers for a received message, or null when the message is not exactly a `MailKeyMessage`. */
export function mailKeyEvent(
  value: unknown,
): { type: typeof MAIL_KEY_EVENT; payload: MailKeyMessage } | null {
  const message = parseMailKeyMessage(value);
  return message ? { type: MAIL_KEY_EVENT, payload: message } : null;
}
