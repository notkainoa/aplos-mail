/**
 * A neutral RFC 5322 / MIME writer for the outbox (time-2): TextEncoder and Uint8Array only, its own base64 and
 * quoted-printable, CRLF line ends and lines of at most 76 characters in every body part. Header injection is
 * impossible: every header value has CR and LF stripped, and an address containing them (or anything else outside a
 * plain `local@domain`) is refused, in the headers and in the SMTP envelope alike. Bcc never appears in a sent message's
 * headers (only in the envelope); a draft copy may carry it. Non-ASCII text is RFC 2047 or RFC 2231 encoded; a non-ASCII domain is sent as punycode.
 */

export interface MimeAddress {
  address: string;
  name?: string;
}

export interface MimeAttachment {
  name: string;
  mime: string;
  bytes: Uint8Array;
  inline?: boolean;
  contentId?: string;
}

export interface MimeInput {
  from: MimeAddress;
  to: readonly MimeAddress[];
  cc: readonly MimeAddress[];
  /** A draft copy only: a sent message never carries Bcc (the envelope does). */
  bcc?: readonly MimeAddress[];
  subject: string;
  html: string;
  /** `<id@host>`, generated once per submission. */
  messageId: string;
  /** Epoch ms for the `Date:` header. */
  date: number;
  inReplyTo?: string;
  references?: readonly string[];
  attachments?: readonly MimeAttachment[];
  /** Randomness for part boundaries; Web Crypto by default. */
  randomBytes?: (n: number) => Uint8Array;
}

/** A draft that cannot be written as mail: the message is the sentence the owner sees. */
export class MimeError extends Error {
  override readonly name = 'MimeError';
}

const CRLF = '\r\n';
const LINE = 76;
const encoder = new TextEncoder();
const defaultRandom = (n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n));

function hex(bytes: Uint8Array) {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/** A fresh Message-ID: 128 random bits at the sender's domain (or `aplos.local`), `<hex@domain>`. */
export function newMessageId(
  randomBytes: (n: number) => Uint8Array = defaultRandom,
  domain = 'aplos.local',
): string {
  return `<${hex(randomBytes(16))}@${domain}>`;
}

// ---------------------------------------------------------------- encodings

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Standard base64 with padding, one line. */
export function base64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += B64[n >> 18] + B64[(n >> 12) & 63] + '==';
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + '=';
  }
  return out;
}

/** Base64 body: 76-character lines, CRLF after each. */
function base64Body(bytes: Uint8Array): string {
  const flat = base64(bytes);
  const lines: string[] = [];
  for (let i = 0; i < flat.length; i += LINE) lines.push(flat.slice(i, i + LINE));
  return lines.join(CRLF) + CRLF;
}

const HEX = '0123456789ABCDEF';
const qpByte = (b: number) => `=${HEX[b >> 4]}${HEX[b & 15]}`;

/** One source line as quoted-printable, soft-broken so no output line exceeds 76 characters. */
function qpLine(bytes: Uint8Array): string[] {
  const lines: string[] = [];
  let line = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    const last = i === bytes.length - 1;
    const literal = b >= 33 && b <= 126 && b !== 61;
    const blank = (b === 32 || b === 9) && !last;
    const token = literal || blank ? String.fromCharCode(b) : qpByte(b);
    // Room for the token plus the soft-break `=`, unless this is the line's final token.
    if (line.length + token.length > (last ? LINE : LINE - 1)) {
      lines.push(line + '=');
      line = '';
    }
    line += token;
  }
  lines.push(line);
  return lines;
}

/** Quoted-printable over UTF-8, with the text's line breaks as CRLF. */
export function quotedPrintable(text: string): string {
  const out: string[] = [];
  for (const line of normalizeBreaks(text).split('\n')) out.push(...qpLine(encoder.encode(line)));
  return out.join(CRLF) + CRLF;
}

function normalizeBreaks(text: string) {
  return text.replace(/\r\n?/g, '\n');
}

const isPlainAscii = (s: string) => /^[\x20-\x7e]*$/.test(s);

/** RFC 2047 `B` encoded-words of at most 75 characters, never splitting a UTF-8 sequence. */
export function encodedWords(text: string): string[] {
  const words: string[] = [];
  let chunk: number[] = [];
  const flush = () => {
    if (chunk.length) words.push(`=?UTF-8?B?${base64(Uint8Array.from(chunk))}?=`);
    chunk = [];
  };
  for (const ch of text) {
    const bytes = encoder.encode(ch);
    if (chunk.length + bytes.length > 36) flush();
    chunk.push(...bytes);
  }
  flush();
  return words;
}

// ---------------------------------------------------------------- headers

/**
 * CR, LF and NUL can never reach a header: they would end it and start another. A run of them, spaces and tabs is one
 * space, so a header never holds a long blank run (a folded line of only whitespace is not allowed).
 */
export function headerSafe(value: string): string {
  return value.replace(/[\r\n\0 \t]+/g, ' ');
}

/** Whether `line[from, to)` has anything but spaces; stops at the first character that does. */
function hasText(line: string, from: number, to: number): boolean {
  for (let i = from; i < to; i++) if (line[i] !== ' ') return true;
  return false;
}

/** Folds `Name: value` at spaces into lines of at most 76 characters where it can; unfolding restores it exactly. */
export function foldHeader(line: string): string {
  const parts: string[] = [];
  const end = line.trimEnd().length;
  let start = 0;
  while (line.length - start > LINE) {
    let at = line.lastIndexOf(' ', start + LINE);
    if (at <= start || line[at - 1] === ':' || !hasText(line, start, at))
      at = line.indexOf(' ', start + LINE + 1);
    if (at <= start || at >= end || !hasText(line, start, at)) break;
    parts.push(line.slice(start, at));
    start = at;
  }
  parts.push(line.slice(start));
  return parts.join(CRLF);
}

/** RFC 5322 limit on a line, CRLF excluded. */
const MAX_LINE = 998;

/** `foldHeader`, refusing what it could not fold: a header line past 998 octets is not mail any server accepts. */
function foldedHeader(line: string): string {
  const folded = foldHeader(line);
  if (folded.split(CRLF).some(l => l.length > MAX_LINE))
    throw new MimeError('A header of this message is too long to send.');
  return folded;
}

/** RFC 5322 `atext` and dots: a quoted local part is refused, as are brackets, quotes, spaces and a second `@`. */
const LOCAL_PART = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/;
const DOMAIN = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/;

/**
 * What the URL parser would read as something other than a host name: a path, query, fragment, port, userinfo or
 * escape, and the controls and blanks it silently strips. Refused before the IDNA step, which would drop everything
 * after them (`evil.com/bank.com` would become `evil.com`).
 */
// eslint-disable-next-line no-control-regex -- the controls are exactly what is refused
const NOT_A_HOST = /[/?#\\:@%\s\x00-\x1f\x7f]/;

/** A domain as it goes on the wire: ASCII as is, anything else as punycode (the URL parser's IDNA step). */
function wireDomain(domain: string): string {
  if (isPlainAscii(domain)) return domain;
  if (NOT_A_HOST.test(domain)) return '';
  try {
    return new URL(`http://${domain}`).hostname;
  } catch {
    return domain;
  }
}

/**
 * Refuses anything but a plain `local@domain` and returns the address as it must be written, in the headers and in
 * the SMTP envelope alike: an ASCII local part (no SMTPUTF8) and a domain that is ASCII or becomes punycode.
 */
export function checkAddress(address: string): string {
  const at = address.lastIndexOf('@');
  const local = address.slice(0, at);
  const domain = at < 0 ? '' : wireDomain(address.slice(at + 1));
  const ok = at >= 1 && address.length <= 320 && LOCAL_PART.test(local) && DOMAIN.test(domain);
  if (!ok)
    throw new MimeError(`"${headerSafe(address).slice(0, 100)}" is not a valid email address.`);
  return `${local}@${domain}`;
}

/** A word the header folder cannot break (it only breaks at spaces): such a value is encoded instead. */
const hasLongWord = (s: string) => s.split(' ').some(w => w.length > LINE - 12);

/** Plain text a reader may still take for something else: `=?` starts an encoded word, which a reader decodes. */
const needsEncoding = (s: string) => !isPlainAscii(s) || hasLongWord(s) || s.includes('=?');

function displayName(name: string): string {
  const clean = headerSafe(name).trim();
  if (!clean) return '';
  if (needsEncoding(clean)) return encodedWords(clean).join(' ');
  if (/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~ -]+$/.test(clean) && !/^ | $/.test(clean)) return clean;
  return `"${clean.replace(/[\\"]/g, m => `\\${m}`)}"`;
}

export function formatAddress(a: MimeAddress): string {
  const address = checkAddress(a.address);
  const name = a.name ? displayName(a.name) : '';
  return name ? `${name} <${address}>` : address;
}

function unstructured(value: string): string {
  const clean = headerSafe(value);
  return needsEncoding(clean) ? encodedWords(clean).join(' ') : clean;
}

/** Printable ASCII (`!` to `~`) except `<`, `>`, `"` and `\`: no control, NUL, space or 8-bit byte can get in. */
const MSG_ID = /^<[\x21\x23-\x3b\x3d\x3f-\x5b\x5d-\x7e]{1,900}>$/;
/** A Message-ID from the store (another mail's): kept only when it is a well-formed `<...>`. */
function msgId(value: string | undefined): string | undefined {
  return value !== undefined && MSG_ID.test(value) ? value : undefined;
}

/** Whether `value` is a well-formed `<...>` Message-ID, one that is safe to write into a header. */
export const isMessageId = (value: string) => msgId(value) !== undefined;

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');

/** RFC 5322 date in UTC: `Wed, 28 Oct 2026 09:00:00 +0000`. */
export function rfc5322Date(ms: number): string {
  const d = new Date(ms);
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  return `${DAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${time} +0000`;
}

/**
 * The same message dated `ms`: only the first header line (`Date:` is always first, see `topHeaders`) is replaced, so
 * the Message-ID, the other headers, the body and the attachments stay byte for byte as they were pinned.
 */
export function withDate(mime: Uint8Array, ms: number): Uint8Array {
  const prefix = new TextEncoder().encode('Date: ');
  const eol = mime.indexOf(0x0d);
  const isDated = prefix.every((byte, i) => mime[i] === byte) && mime[eol + 1] === 0x0a;
  if (!isDated) throw new MimeError('This message could not be re-dated.');
  const line = new TextEncoder().encode(`Date: ${rfc5322Date(ms)}`);
  const out = new Uint8Array(line.length + mime.length - eol);
  out.set(line);
  out.set(mime.subarray(eol), line.length);
  return out;
}

function header(name: string, value: string): string {
  return foldedHeader(`${name}: ${value}`);
}

function topHeaders(input: MimeInput): string[] {
  const out = [header('Date', rfc5322Date(input.date)), header('From', formatAddress(input.from))];
  if (input.to.length) out.push(header('To', input.to.map(formatAddress).join(', ')));
  if (input.cc.length) out.push(header('Cc', input.cc.map(formatAddress).join(', ')));
  if (input.bcc?.length) out.push(header('Bcc', input.bcc.map(formatAddress).join(', ')));
  out.push(header('Subject', unstructured(input.subject)));
  const id = msgId(input.messageId);
  if (!id) throw new MimeError('This message has no valid Message-ID.');
  out.push(header('Message-ID', id));
  const replyTo = msgId(input.inReplyTo);
  if (replyTo) out.push(header('In-Reply-To', replyTo));
  const refs = keptReferences((input.references ?? []).map(msgId).filter((r): r is string => !!r));
  if (refs.length) out.push(header('References', refs.join(' ')));
  out.push('MIME-Version: 1.0');
  return checkedBlock(out);
}

/** The root and the most recent ids, as RFC 5322 3.6.4 suggests and mail clients do for long chains. */
const KEEP_RECENT_REFERENCES = 20;
function keptReferences(refs: string[]): string[] {
  return refs.length > KEEP_RECENT_REFERENCES + 1
    ? [refs[0], ...refs.slice(-KEEP_RECENT_REFERENCES)]
    : refs;
}

/** What the header block may take in all: more is not a message any server takes. */
const MAX_HEADER_BLOCK = 10_000;
function checkedBlock(headers: string[]): string[] {
  const octets = headers.reduce((sum, h) => sum + h.length + CRLF.length, 0);
  if (octets > MAX_HEADER_BLOCK)
    throw new MimeError('The headers of this message are too long to send.');
  return headers;
}

// ---------------------------------------------------------------- body

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  // The common named entities of received mail (a draft's own html never needs them; a synced
  // letter's text does): curly quotes, dashes, ellipsis, Latin-1 letters and symbols.
  lsquo: '\u2018',
  rsquo: '\u2019',
  sbquo: '\u201a',
  ldquo: '\u201c',
  rdquo: '\u201d',
  bdquo: '\u201e',
  dagger: '\u2020',
  ddagger: '\u2021',
  permil: '\u2030',
  lsaquo: '\u2039',
  rsaquo: '\u203a',
  euro: '\u20ac',
  bull: '\u2022',
  hellip: '\u2026',
  prime: '\u2032',
  oline: '\u203e',
  frasl: '\u2044',
  weierp: '\u2118',
  image: '\u2111',
  real: '\u211c',
  trade: '\u2122',
  alefsym: '\u2135',
  larr: '\u2190',
  uarr: '\u2191',
  rarr: '\u2192',
  darr: '\u2193',
  harr: '\u2194',
  crarr: '\u21b5',
  ndash: '\u2013',
  mdash: '\u2014',
  minus: '\u2212',
  lowast: '\u2217',
  radic: '\u221a',
  prop: '\u221d',
  infin: '\u221e',
  ang: '\u2220',
  and: '\u2227',
  or: '\u2228',
  cap: '\u2229',
  cup: '\u222a',
  int: '\u222b',
  there4: '\u2234',
  sim: '\u223c',
  cong: '\u2245',
  asymp: '\u2248',
  ne: '\u2260',
  equiv: '\u2261',
  le: '\u2264',
  ge: '\u2265',
  sub: '\u2282',
  sup: '\u2283',
  nsub: '\u2284',
  sube: '\u2286',
  supe: '\u2287',
  oplus: '\u2295',
  otimes: '\u2297',
  perp: '\u22a5',
  sdot: '\u22c5',
  lceil: '\u2308',
  rceil: '\u2309',
  lfloor: '\u230a',
  rfloor: '\u230b',
  lang: '\u27e8',
  rang: '\u27e9',
  loz: '\u25ca',
  spades: '\u2660',
  clubs: '\u2663',
  hearts: '\u2665',
  diams: '\u2666',
  sect: '\u00a7',
  copy: '\u00a9',
  reg: '\u00ae',
  deg: '\u00b0',
  plusmn: '\u00b1',
  para: '\u00b6',
  middot: '\u00b7',
  curren: '\u00a4',
  pound: '\u00a3',
  yen: '\u00a5',
  cent: '\u00a2',
  times: '\u00d7',
  divide: '\u00f7',
  sup1: '\u00b9',
  sup2: '\u00b2',
  sup3: '\u00b3',
  frac12: '\u00bd',
  frac14: '\u00bc',
  frac34: '\u00be',
  iexcl: '\u00a1',
  iquest: '\u00bf',
  laquo: '\u00ab',
  raquo: '\u00bb',
  not: '\u00ac',
  shy: '\u00ad',
  ordm: '\u00ba',
  ordf: '\u00aa',
  micro: '\u00b5',
  cedil: '\u00b8',
  macr: '\u00af',
  acute: '\u00b4',
  uml: '\u00a8',
  aacute: '\u00e1',
  eacute: '\u00e9',
  iacute: '\u00ed',
  oacute: '\u00f3',
  uacute: '\u00fa',
  agrave: '\u00e0',
  egrave: '\u00e8',
  igrave: '\u00ec',
  ograve: '\u00f2',
  ugrave: '\u00f9',
  acirc: '\u00e2',
  ecirc: '\u00ea',
  icirc: '\u00ee',
  ocirc: '\u00f4',
  ucirc: '\u00fb',
  atilde: '\u00e3',
  ntilde: '\u00f1',
  otilde: '\u00f5',
  auml: '\u00e4',
  euml: '\u00eb',
  iuml: '\u00ef',
  ouml: '\u00f6',
  uuml: '\u00fc',
  ccedil: '\u00e7',
  szlig: '\u00df',
  aring: '\u00e5',
  aelig: '\u00e6',
  oslash: '\u00f8',
  eth: '\u00f0',
  thorn: '\u00fe',
  yuml: '\u00ff',
  // Capital Latin-1 names are distinct entities, not case folds of the lowercase ones.
  Aacute: '\u00c1',
  Eacute: '\u00c9',
  Iacute: '\u00cd',
  Oacute: '\u00d3',
  Uacute: '\u00da',
  Yacute: '\u00dd',
  Agrave: '\u00c0',
  Egrave: '\u00c8',
  Igrave: '\u00cc',
  Ograve: '\u00d2',
  Ugrave: '\u00d9',
  Acirc: '\u00c2',
  Ecirc: '\u00ca',
  Icirc: '\u00ce',
  Ocirc: '\u00d4',
  Ucirc: '\u00db',
  Atilde: '\u00c3',
  Ntilde: '\u00d1',
  Otilde: '\u00d5',
  Auml: '\u00c4',
  Euml: '\u00cb',
  Iuml: '\u00cf',
  Ouml: '\u00d6',
  Uuml: '\u00dc',
  Ccedil: '\u00c7',
  Aring: '\u00c5',
  AElig: '\u00c6',
  Oslash: '\u00d8',
  ETH: '\u00d0',
  THORN: '\u00de',
};

function decodeEntities(text: string): string {
  return text.replace(
    /&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z][a-z0-9]{1,7});/gi,
    (whole, body: string) => {
      if (body[0] !== '#') return ENTITIES[body] ?? whole;
      const code =
        body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    },
  );
}

/** Lower-cases ASCII only, so an index in the result is an index in the input (`toLowerCase` can change a length). */
function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, c => String.fromCharCode(c.charCodeAt(0) + 32));
}

/** Block elements whose end leaves a blank line, and those that only end the line. */
const PARAGRAPHS = new Set([
  'p',
  'blockquote',
  'pre',
  'table',
  'ul',
  'ol',
  'section',
  'article',
  'header',
  'footer',
  'figure',
  'figcaption',
  'caption',
  'dl',
]);
const LINES = new Set(['div', 'li', 'tr', 'td', 'th', 'dt', 'dd']);
const HEADING = /^h[1-6]$/;
const TAG = /^(\/?)([a-z][a-z0-9]*)/;
const TAG_START = /[A-Za-z/!?]/;

/**
 * What one tag adds to the text. A block that opens starts a new line unless one just started, `<li>` also writes its
 * bullet, `<br>` ends the line, and a paragraph or heading that closes leaves a blank line.
 */
function tagText(inner: string, atLineStart: boolean): string {
  const m = TAG.exec(asciiLower(inner.trimStart()));
  if (!m) return '';
  const [, closing, name] = m;
  if (name === 'br') return '\n';
  const paragraph = PARAGRAPHS.has(name) || HEADING.test(name);
  if (closing) return paragraph ? '\n\n' : LINES.has(name) ? '\n' : '';
  const lineBreak = atLineStart ? '' : '\n';
  if (name === 'li') return `${lineBreak}- `;
  return paragraph || LINES.has(name) ? lineBreak : '';
}

/** Elements whose content is never part of a text/plain part: code and document metadata, forms, embeds. */
const SKIP_CONTENT =
  /^(script|style|head|title|noscript|textarea|iframe|object|template|select|svg)\b/;

/** Where the text continues after a skipped element that starts at `from`: past its end tag. */
function afterElement(lower: string, name: string, from: number): number {
  const close = lower.indexOf(`</${name}`, from);
  if (close < 0) return lower.length;
  const end = lower.indexOf('>', close);
  return end < 0 ? lower.length : end + 1;
}

/**
 * The text/plain rendering of the draft's HTML: block ends become line breaks, tags go, scripts and styles are
 * dropped with their content, entities decode. One left-to-right pass over indexOf, so no input can make it slow
 * (a million `<` without a `>` is linear, where a `<[^>]*>` regex is quadratic).
 */
export function htmlToText(html: string): string {
  const lower = asciiLower(html);
  let out = '';
  // Whether the output is empty or ends in a line break. Kept here: reading the end of `out` flattens it every time.
  let atLineStart = true;
  const add = (text: string) => {
    if (!text) return;
    out += text;
    atLineStart = text.charCodeAt(text.length - 1) === 10;
  };
  let at = 0;
  while (at < html.length) {
    const open = html.indexOf('<', at);
    if (open < 0) break;
    add(html.slice(at, open));
    if (!TAG_START.test(html[open + 1] ?? '')) {
      // A lone `<` ("a < b") is text, not a tag.
      add('<');
      at = open + 1;
      continue;
    }
    const close = html.indexOf('>', open + 1);
    if (close < 0) {
      add(html.slice(open));
      at = html.length;
      break;
    }
    const name = SKIP_CONTENT.exec(lower.slice(open + 1, open + 10))?.[1];
    // A self-closing skipped tag (`<script src="x"/>`) swallows only itself — a real one swallows
    // to its close tag (or the end when unclosed, matching a browser's raw-text read).
    at = name && html[close - 1] !== '/' ? afterElement(lower, name, close) : close + 1;
    if (!name || html[close - 1] === '/') add(tagText(html.slice(open + 1, close), atLineStart));
  }
  if (at < html.length) add(html.slice(at));
  return trimLineEnds(decodeEntities(normalizeBreaks(out)))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Drops the spaces and tabs at the end of every line, right to left: a `/[ \t]+$/` per line is quadratic. */
function trimLineEnds(text: string): string {
  return text
    .split('\n')
    .map(line => {
      let end = line.length;
      while (end > 0 && (line.charCodeAt(end - 1) === 32 || line.charCodeAt(end - 1) === 9)) end--;
      return end === line.length ? line : line.slice(0, end);
    })
    .join('\n');
}

function boundary(random: (n: number) => Uint8Array) {
  // `=_` can never occur in quoted-printable or base64 output, so no part's content can end the part.
  return `=_aplos_${hex(random(12))}`;
}

function textPart(type: 'plain' | 'html', text: string): string {
  return [
    `Content-Type: text/${type}; charset=UTF-8`,
    'Content-Transfer-Encoding: quoted-printable',
    '',
    quotedPrintable(text),
  ].join(CRLF);
}

function multipart(type: string, b: string, parts: string[]): string {
  const body = parts.map(p => `--${b}${CRLF}${p}`).join(CRLF);
  const head = foldedHeader(`Content-Type: multipart/${type}; boundary="${b}"`);
  return `${head}${CRLF}${CRLF}${body}${CRLF}--${b}--${CRLF}`;
}

const MIME_TYPE = /^[a-z0-9!#$&^_.+-]{1,100}\/[a-z0-9!#$&^_.+-]{1,100}$/i;

/** A parameter value longer than this goes in RFC 2231 sections, so the folder can break between them. */
const PARAM_SHORT = 60;
/** Characters of one RFC 2231 section. */
const SECTION = 50;

/** One percent-encoded token per character, never splitting a UTF-8 sequence or a `%XX`. */
function percentTokens(text: string): string[] {
  return Array.from(text, ch =>
    Array.from(encoder.encode(ch), b =>
      /[A-Za-z0-9._-]/.test(String.fromCharCode(b))
        ? String.fromCharCode(b)
        : `%${HEX[b >> 4]}${HEX[b & 15]}`,
    ).join(''),
  );
}

/** Groups tokens into runs of at most `SECTION` characters (a token is never split). */
function sections(tokens: string[]): string[] {
  const out: string[] = [];
  let run = '';
  for (const token of tokens) {
    if (run && run.length + token.length > SECTION) {
      out.push(run);
      run = '';
    }
    run += token;
  }
  if (run) out.push(run);
  return out;
}

/**
 * `name="..."` for short ASCII, plus RFC 2231 `name*=UTF-8''...` when the name is not ASCII. A long name is written as
 * numbered sections (`name*0="..."; name*1="..."`, or `name*0*=UTF-8''...` percent-encoded) joined by `; `, so every
 * header line can fold and none passes 998 octets.
 */
function fileParam(param: string, name: string): string {
  const clean = headerSafe(name).replace(/["\\]/g, '_').trim() || 'attachment';
  const ascii = isPlainAscii(clean);
  if (ascii && clean.length <= PARAM_SHORT) return `${param}="${clean}"`;
  const tokens = percentTokens(clean);
  const fallback = clean.replace(/[^\x20-\x7e]/g, '_');
  if (!ascii && tokens.join('').length <= PARAM_SHORT * 1.5)
    return `${param}="${fallback}"; ${param}*=UTF-8''${tokens.join('')}`;
  if (ascii) {
    const parts = clean.match(new RegExp(`.{1,${SECTION}}`, 'gs')) ?? [];
    return parts.map((part, i) => `${param}*${i}="${part}"`).join('; ');
  }
  const parts = sections(tokens).map((part, i) =>
    i === 0 ? `${param}*0*=UTF-8''${part}` : `${param}*${i}*=${part}`,
  );
  return [`${param}="${fallback.slice(0, 40)}"`, ...parts].join('; ');
}

/** A Content-ID is a short token; an absurdly long one is not written, and the part is an ordinary attachment. */
const MAX_CID = 255;
const cidOf = (a: MimeAttachment) => {
  const cid = a.contentId?.replace(/[^A-Za-z0-9._@$-]/g, '');
  return cid && cid.length <= MAX_CID ? cid : undefined;
};

function attachmentPart(a: MimeAttachment): string {
  const type = MIME_TYPE.test(a.mime) ? a.mime.toLowerCase() : 'application/octet-stream';
  const cid = cidOf(a);
  const lines = [
    foldedHeader(`Content-Type: ${type}; ${fileParam('name', a.name)}`),
    foldedHeader(
      `Content-Disposition: ${a.inline ? 'inline' : 'attachment'}; ${fileParam('filename', a.name)}`,
    ),
    'Content-Transfer-Encoding: base64',
  ];
  if (cid) lines.push(`Content-ID: <${cid}>`);
  return [...lines, '', base64Body(a.bytes)].join(CRLF);
}

const isRelated = (a: MimeAttachment) => a.inline === true && !!cidOf(a);

/** The HTML part; with inline images it is multipart/related so `cid:` references resolve. */
function htmlBody(
  html: string,
  inline: readonly MimeAttachment[],
  random: (n: number) => Uint8Array,
) {
  const part = textPart('html', html);
  if (!inline.length) return part;
  return multipart('related', boundary(random), [part, ...inline.map(attachmentPart)]);
}

/**
 * The submission's exact bytes: headers, then multipart/alternative (text/plain from the HTML, and the HTML with its
 * inline images), wrapped in multipart/mixed when there are other attachments. Throws `MimeError` for an address it
 * cannot write safely.
 */
export function buildMime(input: MimeInput): Uint8Array {
  const random = input.randomBytes ?? defaultRandom;
  const attachments = input.attachments ?? [];
  const inline = attachments.filter(isRelated);
  const alternative = multipart('alternative', boundary(random), [
    textPart('plain', htmlToText(input.html)),
    htmlBody(input.html, inline, random),
  ]);
  const regular = attachments.filter(a => !isRelated(a));
  const body = regular.length
    ? multipart('mixed', boundary(random), [alternative, ...regular.map(attachmentPart)])
    : alternative;
  return encoder.encode(topHeaders(input).join(CRLF) + CRLF + body);
}

/**
 * The SMTP envelope: the sender and every To, Cc and Bcc recipient once, each checked and written exactly like the
 * headers. A Bcc address is never in the MIME, so this is where it is validated too.
 */
export function buildEnvelope(
  from: MimeAddress,
  fields: { to: readonly MimeAddress[]; cc: readonly MimeAddress[]; bcc: readonly MimeAddress[] },
): { from: string; rcpt: string[] } {
  const seen = new Set<string>();
  const rcpt: string[] = [];
  for (const a of [...fields.to, ...fields.cc, ...fields.bcc]) {
    const address = checkAddress(a.address);
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    rcpt.push(address);
  }
  return { from: checkAddress(from.address), rcpt };
}
