/**
 * A fresh forward's starting fields (DESIGN 7.6): To stays empty (nothing is guessed), the subject gains one "Fwd: ",
 * and the body opens on a blank line above the original, quoted under a plain header (From, Date, Subject, To). The
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

function dateOf(date: number): string {
  return new Date(date).toUTCString().replace(/ GMT$/, ' UTC');
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
  return ['---------- Forwarded message ----------', ...shown].join('\n');
}

/** The body: a blank line to write on, then the header, a blank line and the original text. */
export function forwardBody(message: Message, text: string): string {
  return `\n\n${forwardHeader(message)}\n\n${text.trim()}`;
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
