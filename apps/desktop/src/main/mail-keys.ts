import { isMailDocumentUrl } from '../host/protocol/relay';

/**
 * The key relay for the sealed mail frame (lane eng-host, html-5; PROTOCOL.md "Keys"). A keydown inside an
 * out-of-process `aplos-mail:` frame never reaches the app's page, and the reporter relays no keys, so main reads the
 * window's `before-input-event` (measured to fire with focus inside the frame: relay.e2e.ts) and hands the app a short
 * list: J, K (either case) and Escape, unmodified, never repeated or composing, keydown only. Everything else stays in
 * the frame: R, E, Space and every other letter (so a key in a letter can never start an app command or the hold-R
 * dictation), and the arrows, Page Up/Down, Home and End, which keep scrolling the letter. A relayed key is cancelled in
 * the frame and sent once as `aplos:event` `{type: 'mail-frame-key', payload: {key, shift, alt}}`. Real engine path
 * only (engine-real.ts installs it per app window). Never both this and a reporter key fallback (main-glue.test.ts).
 */

/** The keys main relays from a focused mail frame. */
export const RELAYED_KEYS: ReadonlySet<string> = new Set(['j', 'k', 'J', 'K', 'Escape']);

/** The `aplos:event` type a relayed key arrives as. */
export const MAIL_FRAME_KEY_EVENT = 'mail-frame-key';

/** What the app receives: the key as the frame saw it, and its Shift. Alt is never held (the key would not pass). */
export interface MailFrameKey {
  key: string;
  shift: boolean;
  alt: false;
}

/** The parts of Electron's `Input` the decision reads. */
export interface KeyInput {
  type: string;
  key: string;
  shift: boolean;
  control: boolean;
  alt: boolean;
  meta: boolean;
  isAutoRepeat: boolean;
  isComposing: boolean;
}

/** The focused frame, as `webContents.focusedFrame` gives it: its URL, and its parent (none for the top frame). */
export interface FocusedFrame {
  readonly url: string;
  readonly parent: unknown;
}

/** The parts of a window's `webContents` the relay uses. */
export interface KeyContents {
  on(
    event: 'before-input-event',
    listener: (event: { preventDefault(): void }, input: KeyInput) => void,
  ): unknown;
  readonly focusedFrame: FocusedFrame | null;
  send(channel: string, ...args: unknown[]): void;
}

/** No Control, Command or Option, not held down, not part of an IME composition: anything but `false` refuses. */
function plainPress(input: KeyInput): boolean {
  return (
    input.control === false &&
    input.meta === false &&
    input.alt === false &&
    input.isAutoRepeat === false &&
    input.isComposing === false
  );
}

/** The key to relay for this input with focus in the frame at `frameUrl`, or null to leave it to the frame. */
export function relayedKey(input: KeyInput, frameUrl: unknown): MailFrameKey | null {
  if (input.type !== 'keyDown' || !plainPress(input)) return null;
  if (!RELAYED_KEYS.has(input.key)) return null;
  if (!isMailDocumentUrl(frameUrl)) return null;
  return { key: input.key, shift: input.shift === true, alt: false };
}

/**
 * The focused frame's URL when it is a subframe; a top frame (even one showing a mail document) gives none, and so
 * does a frame Electron has already disposed (its getters throw): the key then stays where it was.
 */
export function focusedSubframeUrl(
  contents: Pick<KeyContents, 'focusedFrame'>,
): string | undefined {
  try {
    const frame = contents.focusedFrame;
    if (!frame || !frame.parent) return undefined;
    return frame.url;
  } catch {
    return undefined;
  }
}

/** Relays the short key list from a focused mail frame of this window to the window's own page. */
export function installMailKeys(contents: KeyContents): void {
  contents.on('before-input-event', (event, input) => {
    const key = relayedKey(input, focusedSubframeUrl(contents));
    if (!key) return;
    event.preventDefault();
    contents.send('aplos:event', { type: MAIL_FRAME_KEY_EVENT, payload: key });
  });
}
