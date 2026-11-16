/**
 * What the composer edits, and the one mapping between it and the engine's `DraftFields` (DESIGN 7.6). The body is
 * plain text in the composer and simple HTML on the engine: one `<p>` per line, so a draft read back after a reload is
 * exactly the text that was typed (the fuzz checks this round trip).
 */
import type { Address, Draft, DraftFields } from '../../../data';
import type { Recipient } from '../../../ui/props';
import { containsAt } from './recipients';

/** The four recipient-free fields and the three recipient rows the composer shows. */
export interface ComposeFields {
  readonly to: readonly Recipient[];
  readonly cc: readonly Recipient[];
  readonly bcc: readonly Recipient[];
  readonly subject: string;
  readonly body: string;
}

/** Where the draft belongs: the account, and the thread and message a reply answers. */
export interface ComposeContext {
  readonly accountId: string;
  readonly mode: DraftFields['mode'];
  readonly threadId?: string;
  readonly replyToMessageId?: string;
}

export const EMPTY_FIELDS: ComposeFields = { to: [], cc: [], bcc: [], subject: '', body: '' };

const ESCAPES: readonly (readonly [RegExp, string])[] = [
  [/&/g, '&amp;'],
  [/</g, '&lt;'],
  [/>/g, '&gt;'],
];

// `&amp;` goes last, so an escaped "&lt;" typed by the owner comes back as "&lt;", not "<".
const UNESCAPES: readonly (readonly [RegExp, string])[] = [
  [/&lt;/g, '<'],
  [/&gt;/g, '>'],
  [/&quot;/g, '"'],
  [/&#39;/g, "'"],
  [/&nbsp;/g, ' '],
  [/&amp;/g, '&'],
];

function escapeText(text: string): string {
  return ESCAPES.reduce((out, [pattern, entity]) => out.replace(pattern, entity), text);
}

function unescapeText(html: string): string {
  return UNESCAPES.reduce((out, [pattern, text]) => out.replace(pattern, text), html);
}

/** Plain text to the engine's HTML: one paragraph per line, an empty line as `<p><br></p>`. */
export function textToHtml(text: string): string {
  if (text === '') return '';
  return text
    .split('\n')
    .map(line => (line === '' ? '<p><br></p>' : `<p>${escapeText(line)}</p>`))
    .join('');
}

/** The engine's HTML back to plain text: paragraphs and `<br>` become lines, other tags drop, entities decode. */
export function htmlToText(html: string): string {
  if (html === '') return '';
  const lines = html
    // Layout newlines are not text: a draft another client wrote (or a provider re-serialised) is pretty-printed, and the
    // newlines around the document and its html/head/body tags would open the body on blank lines. Only newline runs
    // are removed, and only at the ends and beside those structural tags: the spaces and the breaks between the
    // words and lines of the text itself stay exactly as they are, and our own HTML (`textToHtml`) has none of this.
    .replace(/^\s*\n\s*|\s*\n\s*$/g, '')
    .replace(/(<\/?(?:html|head|body)\b[^>]*>)\s*\n\s*(?=<)/gi, '$1')
    .replace(/>\s*\n\s*(?=<\/?(?:html|head|body)\b)/gi, '>')
    // A draft read back from its MIME copy has the writer's CRLF after every paragraph (`<p>a</p>\r\n<p>b</p>\r\n`):
    // between one paragraph and the next it is layout, not a line, so only that break goes.
    .replace(/<\/p>\s*\n\s*(?=<p\b)/gi, '</p>')
    .replace(/<p>\s*<br\s*\/?>\s*<\/p>/gi, '<p></p>')
    .replace(/<br\s*\/?>/gi, '\n')
    .split(/<\/p>/i)
    .map(part => part.replace(/<[^>]*>/g, ''));
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return unescapeText(lines.join('\n'));
}

/** A contract address as a recipient chip. */
export function recipientOf(address: Address): Recipient {
  const id = address.address.toLowerCase();
  return address.name
    ? { id, name: address.name, address: address.address }
    : { id, address: address.address };
}

/** A recipient chip as a contract address. A name that contains "@" is dropped, so the draft names the real address. */
export function addressOf(recipient: Recipient): Address {
  const name = recipient.name?.trim();
  const safe = name && !containsAt(name) ? name : undefined;
  return safe ? { address: recipient.address, name: safe } : { address: recipient.address };
}

/** The composer's fields from a draft row (a reopened draft, or a draft after a reload). */
export function fieldsFromDraft(draft: Draft): ComposeFields {
  return {
    to: draft.to.map(recipientOf),
    cc: draft.cc.map(recipientOf),
    bcc: draft.bcc.map(recipientOf),
    subject: draft.subject,
    body: htmlToText(draft.html),
  };
}

const MODES: readonly DraftFields['mode'][] = ['new', 'reply', 'replyAll', 'forward'];

/** The context a draft row carries. */
export function contextFromDraft(draft: Draft): ComposeContext {
  const mode = MODES.find(known => known === draft.mode) ?? 'new';
  return {
    accountId: draft.accountId,
    mode,
    ...(draft.threadId ? { threadId: draft.threadId } : {}),
    ...(draft.replyToMessageId ? { replyToMessageId: draft.replyToMessageId } : {}),
  };
}

/** What `Draft/set` writes. Attachments and the signature are a later slice's; they stay empty and off. */
export function draftFieldsOf(fields: ComposeFields, context: ComposeContext): DraftFields {
  return {
    accountId: context.accountId,
    mode: context.mode,
    ...(context.threadId ? { threadId: context.threadId } : {}),
    ...(context.replyToMessageId ? { replyToMessageId: context.replyToMessageId } : {}),
    to: fields.to.map(addressOf),
    cc: fields.cc.map(addressOf),
    bcc: fields.bcc.map(addressOf),
    subject: fields.subject,
    html: textToHtml(fields.body),
    attachments: [],
    signature: false,
  };
}

/** True when nothing worth keeping has been written: no draft is created for an untouched composer. */
export function isBlank(fields: ComposeFields): boolean {
  return (
    fields.body.trim() === '' &&
    fields.subject.trim() === '' &&
    fields.to.length + fields.cc.length + fields.bcc.length === 0
  );
}
