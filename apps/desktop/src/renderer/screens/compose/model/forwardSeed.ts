/**
 * A fresh forward's starting fields (DESIGN 7.6): To stays empty (nothing is guessed), the subject gains one "Fwd: ",
 * and the body opens on an empty note above the original, quoted under a plain header (From, Date, Subject, To). The
 * draft keeps the forwarded message as `replyToMessageId` but no thread: a forward starts a conversation of its own.
 */
import type { Address, Message } from '../../../data';
import type { ComposeContext, ComposeFields } from './fields';

/** "Fwd: Launch plan", never "Fwd: Fwd: Launch plan". */
export function forwardSubject(subject: string): string {
  const trimmed = subject.trim();
  return /^(fwd?):/i.test(trimmed) ? trimmed : `Fwd: ${trimmed}`.trimEnd();
}

function nameOf(address: Address): string {
  return address.name ? `${address.name} <${address.address}>` : address.address;
}

function listOf(addresses: readonly Address[]): string {
  return addresses.map(nameOf).join(', ');
}

/** The header's time in the owner's zone and the app's date style: "Mon, Nov 16, 2026, 5:42 PM". */
function dateOf(date: number): string {
  const when = new Date(date);
  const day = when.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  const time = when.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `${day}, ${time}`.replace(/[\u202f\u00a0]/g, ' ');
}

/** The line that opens the quoted original; the composer shows what follows it as its own quiet region. */
export const FORWARD_MARK = '---------- Forwarded message ----------';

/**
 * A forward's body as two parts: what the owner adds above, and the quoted original from the mark on. A body with no
 * mark is all note. One blank line separates them in the stored text, so an Enter typed at the end of the note is kept.
 */
export function splitForward(body: string): { readonly note: string; readonly quote: string } {
  const at = body.indexOf(FORWARD_MARK);
  if (at < 0) return { note: body, quote: '' };
  const before = body.slice(0, at);
  return {
    note: before.endsWith('\n\n') ? before.slice(0, -2) : before,
    quote: body.slice(at),
  };
}

/** The two parts back into the stored body; `splitForward` undoes it. */
export function joinForward(note: string, quote: string): string {
  if (quote === '') return note;
  return note === '' ? quote : `${note}\n\n${quote}`;
}

/** The header block above the quoted text; a line with nothing to say is left out. */
export function forwardHeader(message: Message): string {
  const lines: readonly (readonly [string, string])[] = [
    ['From', message.from ? nameOf(message.from) : ''],
    ['Date', dateOf(message.date)],
    ['Subject', message.subject],
    ['To', listOf(message.to)],
    ['Cc', listOf(message.cc)],
  ];
  const shown = lines.filter(([, value]) => value !== '').map(([key, value]) => `${key}: ${value}`);
  return [FORWARD_MARK, ...shown].join('\n');
}

/** The body: an empty note, then the header, a blank line and the original text (the composer draws it as a quote). */
export function forwardBody(message: Message, text: string): string {
  return joinForward('', `${forwardHeader(message)}\n\n${text.trim()}`);
}

/** The context and fields of a forward of `message`, whose readable text is `text` (its snippet when no body came). */
export function forwardSeed(
  message: Message,
  text: string,
): { readonly context: ComposeContext; readonly fields: ComposeFields } {
  return {
    context: { accountId: message.accountId, mode: 'forward', replyToMessageId: message.id },
    fields: {
      to: [],
      cc: [],
      bcc: [],
      subject: forwardSubject(message.subject),
      body: forwardBody(message, text),
    },
  };
}
