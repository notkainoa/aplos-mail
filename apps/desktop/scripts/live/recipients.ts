import { Buffer } from 'node:buffer';

/**
 * Who would an RFC 822 message be delivered to? This is the check behind "send to self only", so it
 * is strict on purpose: anything it cannot parse unambiguously throws, and the guard then refuses
 * the send. Only `addr` and `Name <addr>` with a plain-word name are accepted: comments, groups,
 * escapes, encoded words and non-ASCII are refused, because Gmail's parser may read them
 * differently from this one.
 */
export class UnparseableMessage extends Error {
  constructor(why: string) {
    super(why);
    this.name = 'UnparseableMessage';
  }
}

/** Headers whose addresses decide where a message goes (plus envelope-style ones some tools add). */
const RECIPIENT_HEADERS = new Set([
  'to',
  'cc',
  'bcc',
  'reply-to',
  'envelope-to',
  'x-envelope-to',
  'delivered-to',
  'x-original-to',
]);
/** The Resent-* headers that hold dates and ids, not addresses. */
const RESENT_NON_ADDRESS = new Set(['resent-date', 'resent-message-id']);

/** Plain dot-atom mailboxes only: no quoted local parts, no domain literals, no encoded words. */
const ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;

export function isPlainAddress(value: string): boolean {
  return ADDRESS.test(value) && !value.includes('=?');
}

/**
 * Strict base64url, as the Gmail API documents the `raw` field: the URL-safe alphabet only (no "+"
 * or "/"), optional padding to a whole quantum, and a canonical spelling, so no other decoder can
 * read different bytes out of the same text.
 */
export function decodeRaw(raw: unknown): Buffer {
  if (typeof raw !== 'string' || !raw) throw new UnparseableMessage('raw is missing');
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(raw)) throw new UnparseableMessage('raw is not base64url');
  const unpadded = raw.replace(/=+$/, '');
  if (unpadded !== raw && raw.length % 4 !== 0) throw new UnparseableMessage('bad base64 padding');
  const bytes = Buffer.from(unpadded, 'base64url');
  if (bytes.toString('base64url') !== unpadded)
    throw new UnparseableMessage('raw is not canonical base64url');
  return bytes;
}

/**
 * The lines of the header block up to the first blank line, without their line endings. Every
 * line ending in the block (the blank line's too) must be the same, all CRLF or all bare LF: a
 * CRLF-only parser reads a bare LF as part of a line, so a mixed block could hide a header from
 * one parser that the other delivers to. A CR is only taken off a line that an LF ends, so a
 * trailing bare CR stays in the line and is refused by the caller.
 */
function headerLines(message: Buffer): string[] {
  // latin1 keeps bytes one-to-one; a non-ASCII byte in a recipient header is refused when parsed.
  const pieces = message.toString('latin1').split('\n');
  const lines: string[] = [];
  let crlf: boolean | undefined;
  for (const [index, piece] of pieces.entries()) {
    const terminated = index < pieces.length - 1;
    const line = terminated && piece.endsWith('\r') ? piece.slice(0, -1) : piece;
    if (terminated) {
      const thisCrlf = line !== piece;
      if (crlf !== undefined && crlf !== thisCrlf)
        throw new UnparseableMessage('headers mix CRLF and bare LF line endings');
      crlf = thisCrlf;
    }
    if (line === '') break;
    lines.push(line);
  }
  return lines;
}

/** The header lines of the outer message, unfolded. Everything after the first blank line is body. */
function outerHeaders(message: Buffer): { name: string; value: string }[] {
  const headers: { name: string; value: string }[] = [];
  for (const line of headerLines(message)) {
    // A bare CR, a NUL or a whitespace-only line are read differently by different parsers.
    if (line.includes('\r') || line.includes('\0'))
      throw new UnparseableMessage('ambiguous line ending');
    if (/^[ \t]+$/.test(line)) throw new UnparseableMessage('whitespace-only line in headers');
    if (/^[ \t]/.test(line)) {
      const last = headers[headers.length - 1];
      if (!last) throw new UnparseableMessage('header starts with a fold');
      last.value += line;
      continue;
    }
    const colon = line.indexOf(':');
    if (colon < 1) throw new UnparseableMessage('header line without a name');
    const name = line.slice(0, colon).replace(/[ \t]+$/, '');
    if (!/^[\x21-\x39\x3b-\x7e]+$/.test(name)) throw new UnparseableMessage('bad header name');
    headers.push({ name: name.toLowerCase(), value: line.slice(colon + 1) });
  }
  return headers;
}

type Token = { kind: 'atom'; text: string } | { kind: 'quoted' } | { kind: '<' | '>' | ',' };

/**
 * Display names are plain words only: letters, digits and spaces. Gmail's parser may read a
 * comment, an escape, an encoded word or an "@" in a name differently from this one, so a name that
 * holds anything else is refused rather than interpreted.
 */
const NAME_WORD = /^[A-Za-z0-9]+$/;
const QUOTED_NAME = /^[A-Za-z0-9 ]*$/;

/**
 * Reads a quoted display name and returns the index just past its closing quote. Only plain words
 * may be inside: no backslash, "@", "<" or comma (or any other mark) that a parser could take apart.
 */
function readQuoted(text: string, start: number): number {
  const end = text.indexOf('"', start + 1);
  if (end < 0) throw new UnparseableMessage('unterminated quoted string');
  if (!QUOTED_NAME.test(text.slice(start + 1, end)))
    throw new UnparseableMessage('unsupported character in quoted display name');
  return end + 1;
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let atom = '';
  const flush = (): void => {
    if (atom) tokens.push({ kind: 'atom', text: atom });
    atom = '';
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"') {
      flush();
      i = readQuoted(text, i);
      tokens.push({ kind: 'quoted' });
    } else if (c === '<' || c === '>' || c === ',') {
      flush();
      tokens.push({ kind: c });
      i++;
    } else if (c === ' ' || c === '\t') {
      flush();
      i++;
    } else if ('()[]\\:;'.includes(c) || c < ' ' || c > '~') {
      // Comments, domain literals, escapes, groups and non-ASCII: none is needed to write to self.
      throw new UnparseableMessage('unsupported character in address');
    } else {
      atom += c;
      i++;
    }
  }
  flush();
  return tokens;
}

function checked(address: string): string {
  if (!isPlainAddress(address)) throw new UnparseableMessage('address is not a plain mailbox');
  return address.toLowerCase();
}

/** The comma-separated parts of an address list; an empty part (",," or a trailing comma) is refused. */
function mailboxParts(tokens: Token[]): Token[][] {
  const parts: Token[][] = [[]];
  for (const token of tokens) {
    if (token.kind === ',') parts.push([]);
    else parts[parts.length - 1]!.push(token);
  }
  if (parts.some(part => part.length === 0)) throw new UnparseableMessage('empty mailbox');
  return parts;
}

/** `addr`, or `Name <addr>` where the name is plain words (bare or quoted). Nothing else. */
function mailbox(part: Token[]): string {
  const only = part[0]!;
  if (part.length === 1 && only.kind === 'atom') return checked(only.text);
  const nameLength = part.length - 3;
  const [open, inner, close] = part.slice(nameLength);
  if (nameLength < 0 || open?.kind !== '<' || inner?.kind !== 'atom' || close?.kind !== '>')
    throw new UnparseableMessage('not a mailbox');
  const name = part.slice(0, nameLength);
  if (
    !name.every(
      token => token.kind === 'quoted' || (token.kind === 'atom' && NAME_WORD.test(token.text)),
    )
  )
    throw new UnparseableMessage('unsupported display name');
  return checked(inner.text);
}

/**
 * A strict subset of the RFC 5322 address-list: mailboxes `addr` and `Name <addr>` separated by
 * commas. Comments, groups, escapes and encoded words are refused. Returns lowercase addresses.
 */
export function parseAddressList(text: string): string[] {
  const tokens = tokenize(text);
  return tokens.length ? mailboxParts(tokens).map(mailbox) : [];
}

/**
 * Every address in the headers that decide delivery (To, Cc, Bcc, Reply-To, Resent-*, envelope
 * style headers), over all occurrences of each header. Body parts, including attached
 * message/rfc822 parts, are not looked at.
 */
export function recipientAddresses(message: Buffer): string[] {
  const addresses: string[] = [];
  for (const header of outerHeaders(message)) {
    const relevant =
      RECIPIENT_HEADERS.has(header.name) ||
      (header.name.startsWith('resent-') && !RESENT_NON_ADDRESS.has(header.name));
    if (relevant) addresses.push(...parseAddressList(header.value));
  }
  return addresses;
}
