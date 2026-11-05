/**
 * Main's key relay for the sealed mail frame (lane eng-html, html-5; PROTOCOL.md "Keys"). Pure: no Electron import, so
 * it runs under node:test. `main/windows.ts` hands it every `before-input-event` of an app window.
 *
 * Why main: a keydown inside the out-of-process `aplos-mail://` frame never reaches the host page, and the frame's
 * reporter sends no key (ARCH 10: its six fields "and nothing else"). `before-input-event` does fire for that frame's
 * keys (measured, DECISIONS html-5), with `focusedFrame` naming it.
 *
 * Which path is active when (never both):
 * - sealed frame (`aplos-mail://m/<token>/` focused): this relay only. The reporter has no key fallback.
 * - srcdoc frame (development builds): the renderer's own listener on the frame document (`mailframe/keys.ts`) only;
 *   its focused frame is `about:srcdoc`, which this relay never accepts.
 * - the app page itself, or any other frame: neither; the key is the page's own and is never relayed.
 *
 * The key is not cancelled here: the shell decides whether it handled it, and an unhandled arrow or Page Down still
 * scrolls the letter.
 */
import {
  MAIL_KEY_CHANNEL,
  mailKeyOfInput,
  parseMailKeyMessage,
  type MailKeyMessage,
  type RelayableInput,
} from '../../shared/mail-keys';
import { isShownMailDocumentUrl } from './relay';

/** The part of Electron's `WebFrameMain` the relay reads. */
export interface RelayFrame {
  url: string;
  parent?: unknown;
}

/** The part of an app window's `WebContents` the relay reads and writes. */
export interface RelayContents {
  isDestroyed(): boolean;
  readonly mainFrame: unknown;
  readonly focusedFrame: RelayFrame | null;
  send(channel: string, message: MailKeyMessage): void;
}

/**
 * True when the key belongs to a sealed mail frame embedded directly in this window's page: the focused frame is
 * neither the page itself nor a frame of another kind, it is a child of the main frame, and its URL is exactly an
 * issued mail document.
 */
function sealedFrameFocused(contents: RelayContents): boolean {
  let frame: RelayFrame | null;
  try {
    frame = contents.focusedFrame;
  } catch {
    return false;
  }
  if (!frame || frame === contents.mainFrame || frame.parent !== contents.mainFrame) return false;
  return isShownMailDocumentUrl(frame.url);
}

/**
 * Relays one input of an app window to its renderer when it is a listed, unmodified keydown from the sealed frame.
 * Returns whether a message was sent. The message is parsed again before it is sent, so nothing but a listed key can
 * ever leave main on this channel.
 */
export function relayMailKey(contents: RelayContents, input: RelayableInput): boolean {
  if (contents.isDestroyed()) return false;
  const key = mailKeyOfInput(input);
  if (!key || !sealedFrameFocused(contents)) return false;
  const message = parseMailKeyMessage({ key });
  if (!message) return false;
  contents.send(MAIL_KEY_CHANNEL, message);
  return true;
}
