/**
 * The small rounded square before the sender's name in the card header (owner sketch 2026-11-10): the sender's
 * monogram in the app's calm colours until photos exist. Drawn from a data attribute by CSS, so the header's text is
 * only the name and the time; no remote avatar is ever loaded by the renderer.
 */
import type { Message } from '../../data';
import { personOf } from './readerPeople';

/** Props for `SenderMark`. */
export interface SenderMarkProps {
  readonly message: Message;
  readonly me: ReadonlySet<string>;
}

/** One uppercase character for the message's sender; "?" when the header names no one. */
export function SenderMark({ message, me }: SenderMarkProps) {
  const initial = message.from ? personOf(message.from, me).initial : '?';
  return <span className="aplos-sender-mark" aria-hidden="true" data-mark={initial} />;
}
