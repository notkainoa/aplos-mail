import { Buffer } from 'node:buffer';

/**
 * Who would an RFC 822 message be delivered to? This is the check behind "send to self only", so it
 * is strict on purpose: anything it cannot parse unambiguously throws, and the guard then refuses
 * the send. It never decodes display names or encoded words, because delivery uses the
 * `<addr-spec>` and nothing else.
 */
export class UnparseableMessage extends Error {
  constructor(why: string) {
    super(why);
    this.name = 'UnparseableMessage';
  }
}

/** Headers whose addresses decide where a message goes (plus envelope-style ones some tools add). */
const RECIPIENT_HEADERS = new Set(['to', 'cc', 'bcc', 'reply-to', 'envelope-to', 'x-envelope-to', 'delivered-to', 'x-original-to']);
/** The Resent-* headers that hold dates and ids, not addresses. */
const RESENT_NON_ADDRESS = new Set(['resent-date', 'resent-message-id']);

/** Plain dot-atom mailboxes only: no quoted local parts, no domain literals, no encoded words. */
const ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;

export function isPlainAddress(value: string): boolean {
  return ADDRESS.test(value) && !value.includes('=?');
}

/** Strict base64 or base64url, as the `raw` field of the Gmail API carries a message. */
export function decodeRaw(raw: unknown): Buffer {
  if (typeof raw !== 'string' || !raw) throw new UnparseableMessage('raw is missing');
  if (!/^[A-Za-z0-9_+/-]+={0,2}$/.test(raw)) throw new UnparseableMessage('raw is not base64');
  return Buffer.from(raw, 'base64');
}

/** The header lines of the outer message, unfolded. Everything after the first blank line is body. */
function outerHeaders(message: Buffer): { name: string; value: string }[] {
  // latin1 keeps bytes one-to-one; non-ASCII only ever shows up in display names, which we ignore.
  const lines = message.toString('latin1').split('\n');
  const headers: { name: string; value: string }[] = [];
  for (const rawLine of lines) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '') break;
    // A bare CR, a NUL or a whitespace-only line are read differently by different parsers.
    if (line.includes('\r') || line.includes('\0')) throw new UnparseableMessage('ambiguous line ending');
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

type Token = { kind: 'atom'; text: string } | { kind: 'quoted' } | { kind: '<' | '>' | ',' | ';' | ':' };

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
    if (c === '(') {
      // Comments nest and may hold anything, including things that look like addresses.
      flush();
      let depth = 0;
      for (; i < text.length; i++) {
        const d = text[i]!;
        if (d === '\\') i++;
        else if (d === '(') depth++;
        else if (d === ')' && --depth === 0) break;
      }
      if (depth !== 0) throw new UnparseableMessage('unterminated comment');
      i++;
    } else if (c === '"') {
      flush();
      i++;
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
      if (i >= text.length) throw new UnparseableMessage('unterminated quoted string');
      i++;
      tokens.push({ kind: 'quoted' });
    } else if (c === '<' || c === '>' || c === ',' || c === ';' || c === ':') {
      flush();
      tokens.push({ kind: c });
      i++;
    } else if (c === ' ' || c === '\t') {
      flush();
      i++;
    } else if (c === '[' || c === ']' || c === ')' || c === '\\' || c < ' ') {
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

/** RFC 5322 address-list: mailboxes, `Name <addr>`, and groups `Name: a, b;`. Returns lowercase addresses. */
export function parseAddressList(text: string): string[] {
  const tokens = tokenize(text);
  const found: string[] = [];
  let inGroup = false;
  let i = 0;

  const bare = (phrase: Token[]): void => {
    if (!phrase.length) return;
    const only = phrase[0]!;
    // A bare address is exactly one atom with an @. "self@x other@y" is not a mailbox.
    if (phrase.length !== 1 || only.kind !== 'atom' || !only.text.includes('@')) throw new UnparseableMessage('not a mailbox');
    found.push(checked(only.text));
  };

  // RFC 5322 does not allow "@" in an unquoted display name. A lenient reader may take it as a
  // second address, so the strict reading and the lenient one must not differ: refuse it.
  const noAddressInName = (phrase: Token[]): void => {
    if (phrase.some(token => token.kind === 'atom' && token.text.includes('@'))) throw new UnparseableMessage('address in display name');
  };

  while (i < tokens.length) {
    const phrase: Token[] = [];
    while (i < tokens.length && (tokens[i]!.kind === 'atom' || tokens[i]!.kind === 'quoted')) phrase.push(tokens[i++]!);
    const next = tokens[i];
    if (!next) {
      bare(phrase);
      break;
    }
    i++;
    if (next.kind === '<') {
      noAddressInName(phrase);
      const inner = tokens[i];
      if (!inner || inner.kind !== 'atom' || tokens[i + 1]?.kind !== '>') throw new UnparseableMessage('bad angle address');
      found.push(checked(inner.text));
      i += 2;
      const after = tokens[i];
      if (after && after.kind !== ',' && after.kind !== ';') throw new UnparseableMessage('text after angle address');
    } else if (next.kind === ',') {
      bare(phrase);
    } else if (next.kind === ';') {
      if (!inGroup) throw new UnparseableMessage('stray semicolon');
      bare(phrase);
      inGroup = false;
    } else if (next.kind === ':') {
      if (inGroup || !phrase.length) throw new UnparseableMessage('bad group');
      noAddressInName(phrase);
      inGroup = true;
    } else {
      throw new UnparseableMessage('stray angle bracket');
    }
  }
  if (inGroup) throw new UnparseableMessage('unterminated group');
  return found;
}

/**
 * Every address in the headers that decide delivery (To, Cc, Bcc, Reply-To, Resent-*, envelope
 * style headers), over all occurrences of each header. Body parts, including attached
 * message/rfc822 parts, are not looked at.
 */
export function recipientAddresses(message: Buffer): string[] {
  const addresses: string[] = [];
  for (const header of outerHeaders(message)) {
    const relevant = RECIPIENT_HEADERS.has(header.name) || (header.name.startsWith('resent-') && !RESENT_NON_ADDRESS.has(header.name));
    if (relevant) addresses.push(...parseAddressList(header.value));
  }
  return addresses;
}
