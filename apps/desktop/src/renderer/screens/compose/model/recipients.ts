/**
 * Recipients with plain rules (DESIGN 7.6 "Blocked send outlines the field and explains in one sentence"): what a typed
 * entry becomes, whether an address is plausible, why a send is blocked, and the short phrase the undo tray names
 * ("Sending to Jordan and Mina in 8 s"). No network lookups; the engine has the last word on `Submission/set`.
 */
import type { BlockedSend, Recipient } from '../../../ui/props';
import type { ComposeContext, ComposeFields } from './fields';

/** The longest address the contract takes. */
const MAX_ADDRESS = 320;

/** One local part, one `@`, a dotted domain, no spaces or angle brackets. Deliberately plain, not RFC 5322. */
const ADDRESS = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;".]{2,}$/;

/** "@" and the look-alikes that pose as it: fullwidth ＠ (U+FF20) and small ﹫ (U+FE6B). */
const AT_SIGNS = /[@\uFF20\uFE6B]/u;

/** True when `text` holds an "@" or anything that normalises (NFKC) or looks like one: such a name could pose as an address. */
export function containsAt(text: string): boolean {
  return AT_SIGNS.test(text) || AT_SIGNS.test(text.normalize('NFKC'));
}

/** True for an address the composer will send to. */
export function isValidAddress(address: string): boolean {
  return address.length <= MAX_ADDRESS && ADDRESS.test(address);
}

/** "Jordan Lee <jordan@example.com>", "<jordan@example.com>" or a bare address, trimmed; null for empty text. */
export function parseRecipient(text: string): Recipient | null {
  const trimmed = text
    .trim()
    .replace(/[,;]+$/, '')
    .trim();
  if (trimmed === '') return null;
  const named = /^(.*?)\s*<([^<>]+)>$/.exec(trimmed);
  const address = (named ? named[2]! : trimmed).trim();
  const name = named ? named[1]!.replace(/^"|"$/g, '').trim() : '';
  const id = address.toLowerCase();
  return name ? { id, name, address } : { id, address };
}

/** Adds typed text as one or more recipients (comma or semicolon separated), skipping ones already there. */
export function addRecipients(current: readonly Recipient[], text: string): readonly Recipient[] {
  const seen = new Set(current.map(r => r.id));
  const added: Recipient[] = [];
  for (const part of text.split(/[,;\n]/)) {
    const recipient = parseRecipient(part);
    if (!recipient || seen.has(recipient.id)) continue;
    seen.add(recipient.id);
    added.push(recipient);
  }
  return added.length === 0 ? current : [...current, ...added];
}

/** Ids of recipients whose address fails the plain rules; the field outlines them. */
export function invalidIds(recipients: readonly Recipient[]): readonly string[] {
  return recipients.filter(r => !isValidAddress(r.address)).map(r => r.id);
}

export const BLOCKED_COPY = {
  noRecipient: 'Add a recipient.',
  badAddress: (address: string) => `Check the address ${address}. It doesn’t look complete.`,
  emptyReply: 'Write something first.',
} as const;

/**
 * Why this draft cannot be sent yet, as one sentence on one field; null when it can. A reply (`mode` 'reply' or
 * 'replyAll') also needs words: an empty one is a slip. A forward is exempt (the quoted original is its content) and so
 * is a new message.
 */
export function blockedSend(
  fields: ComposeFields,
  mode?: ComposeContext['mode'],
): BlockedSend | null {
  const all = [...fields.to, ...fields.cc, ...fields.bcc];
  if (all.length === 0) return { field: 'to', message: BLOCKED_COPY.noRecipient };
  const bad = all.find(r => !isValidAddress(r.address));
  if (bad) return { field: 'to', message: BLOCKED_COPY.badAddress(bad.address) };
  const reply = mode === 'reply' || mode === 'replyAll';
  if (reply && fields.body.trim() === '')
    return { field: 'body', message: BLOCKED_COPY.emptyReply };
  return null;
}

/** Text typed in each recipient row but not yet a chip. */
export interface TypedText {
  readonly to: string;
  readonly cc: string;
  readonly bcc: string;
}

export const NO_TYPED: TypedText = { to: '', cc: '', bcc: '' };

/** The fields as a send would read them: each row's typed text taken as recipients first. */
export function withTyped(fields: ComposeFields, typed: TypedText): ComposeFields {
  return {
    ...fields,
    to: addRecipients(fields.to, typed.to),
    cc: addRecipients(fields.cc, typed.cc),
    bcc: addRecipients(fields.bcc, typed.bcc),
  };
}

function firstName(name: string): string {
  const trimmed = name.trim();
  if (containsAt(trimmed)) return trimmed;
  return trimmed.split(/\s+/)[0] ?? trimmed;
}

/** The recipient phrase for the undo tray and the send-failed line: "Jordan", "Jordan and Mina", "Jordan and 2 others". */
export function recipientPhrase(names: readonly string[]): string {
  const firsts = names.map(firstName).filter(n => n !== '');
  if (firsts.length === 0) return 'No recipient';
  if (firsts.length === 1) return firsts[0]!;
  if (firsts.length === 2) return `${firsts[0]} and ${firsts[1]}`;
  return `${firsts[0]} and ${firsts.length - 1} others`;
}

/**
 * What names a recipient: their display name, or the address when there is no name or the name contains "@" (a name
 * like "boss@company.com" on another address would pass for that address).
 */
export function safeDisplayName(recipient: Recipient): string {
  const name = recipient.name?.trim();
  return name && !containsAt(name) ? name : recipient.address;
}

/** The display names `Submission.toNames` would carry for these fields, for the tray shown before the engine answers. */
export function namesOf(fields: ComposeFields): readonly string[] {
  return [...fields.to, ...fields.cc].map(safeDisplayName);
}
