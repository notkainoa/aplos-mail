/**
 * A neutral RFC 5322 / MIME writer for the outbox (time-2): TextEncoder and Uint8Array only, its own base64 and
 * quoted-printable, CRLF line ends and lines of at most 76 characters in every body part. Header injection is
 * impossible: every header value has CR and LF stripped, and an address containing them (or anything else outside a
 * plain `local@domain`) is refused. Bcc never appears in the headers; it is only in the SMTP envelope.
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

/** A fresh Message-ID: 128 random bits, `<hex@aplos.local>`. */
export function newMessageId(randomBytes: (n: number) => Uint8Array = defaultRandom): string {
  return `<${hex(randomBytes(16))}@aplos.local>`;
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
    if (chunk.length + bytes.length > 45) flush();
    chunk.push(...bytes);
  }
  flush();
  return words;
}

// ---------------------------------------------------------------- headers

/** CR, LF and NUL can never reach a header: they would end it and start another. */
export function headerSafe(value: string): string {
  return value.replace(/[\r\n\0]+/g, ' ');
}

/** Folds `Name: value` at spaces into lines of at most 76 characters where it can; unfolding restores it exactly. */
export function foldHeader(line: string): string {
  const parts: string[] = [];
  let rest = line;
  while (rest.length > LINE) {
    let at = rest.lastIndexOf(' ', LINE);
    if (at <= 0 || !rest.slice(0, at).trim() || rest.slice(0, at).endsWith(':'))
      at = rest.indexOf(' ', LINE + 1);
    if (at <= 0 || !rest.slice(at).trim()) break;
    parts.push(rest.slice(0, at));
    rest = rest.slice(at);
  }
  parts.push(rest);
  return parts.join(CRLF);
}

const ADDRESS = /^[^\s<>()[\]\\,;:"@\0-\x1f\x7f]+@[^\s<>()[\]\\,;:"@\0-\x1f\x7f]+$/;

/** Refuses anything but a plain `local@domain`: no CR/LF, spaces, brackets, quotes or a second `@`. */
export function checkAddress(address: string): string {
  if (!ADDRESS.test(address) || address.length > 320)
    throw new MimeError(`"${headerSafe(address).slice(0, 100)}" is not a valid email address.`);
  return address;
}

function displayName(name: string): string {
  const clean = headerSafe(name).trim();
  if (!clean) return '';
  if (!isPlainAscii(clean)) return encodedWords(clean).join(' ');
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
  const long = clean.split(' ').some(w => w.length > LINE - 12);
  return isPlainAscii(clean) && !long ? clean : encodedWords(clean).join(' ');
}

const MSG_ID = /^<[^<>\s"\\]{1,900}>$/;
/** A Message-ID from the store (another mail's): kept only when it is a well-formed `<...>`. */
function msgId(value: string | undefined): string | undefined {
  return value !== undefined && MSG_ID.test(value) ? value : undefined;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');

/** RFC 5322 date in UTC: `Wed, 28 Oct 2026 09:00:00 +0000`. */
export function rfc5322Date(ms: number): string {
  const d = new Date(ms);
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  return `${DAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${time} +0000`;
}

function header(name: string, value: string): string {
  return foldHeader(`${name}: ${value}`);
}

function topHeaders(input: MimeInput): string[] {
  const out = [header('Date', rfc5322Date(input.date)), header('From', formatAddress(input.from))];
  if (input.to.length) out.push(header('To', input.to.map(formatAddress).join(', ')));
  if (input.cc.length) out.push(header('Cc', input.cc.map(formatAddress).join(', ')));
  out.push(header('Subject', unstructured(input.subject)));
  const id = msgId(input.messageId);
  if (!id) throw new MimeError('This message has no valid Message-ID.');
  out.push(header('Message-ID', id));
  const replyTo = msgId(input.inReplyTo);
  if (replyTo) out.push(header('In-Reply-To', replyTo));
  const refs = (input.references ?? []).map(msgId).filter((r): r is string => !!r);
  if (refs.length) out.push(header('References', refs.join(' ')));
  out.push('MIME-Version: 1.0');
  return out;
}

// ---------------------------------------------------------------- body

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,6});/gi, (whole, body: string) => {
    if (body[0] !== '#') return ENTITIES[body.toLowerCase()] ?? whole;
    const code =
      body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : Number(body.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

/** Drops `<script>` and `<style>` elements with their content, scanning with indexOf (no backtracking). */
function dropElements(html: string, tag: string): string {
  const lower = html.toLowerCase();
  let out = '';
  let from = 0;
  for (;;) {
    const start = lower.indexOf(`<${tag}`, from);
    if (start < 0) break;
    const close = lower.indexOf(`</${tag}`, start);
    const end = close < 0 ? html.length : lower.indexOf('>', close) + 1 || html.length;
    out += html.slice(from, start);
    from = end;
  }
  return out + html.slice(from);
}

/** The text/plain rendering of the draft's HTML: block ends become line breaks, tags go, entities decode. */
export function htmlToText(html: string): string {
  const body = dropElements(dropElements(html, 'script'), 'style')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[\s>][^>]*>|<li>/gi, '\n- ')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|pre|table|ul|ol)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '');
  return decodeEntities(normalizeBreaks(body))
    .split('\n')
    .map(line => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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
  const head = foldHeader(`Content-Type: multipart/${type}; boundary="${b}"`);
  return `${head}${CRLF}${CRLF}${body}${CRLF}--${b}--${CRLF}`;
}

const MIME_TYPE = /^[a-z0-9!#$&^_.+-]{1,100}\/[a-z0-9!#$&^_.+-]{1,100}$/i;

/** `name="..."` for ASCII, plus RFC 2231 `name*=UTF-8''...` when the name is not. */
function fileParam(param: string, name: string): string {
  const clean = headerSafe(name).replace(/["\\]/g, '_').trim() || 'attachment';
  if (isPlainAscii(clean)) return `${param}="${clean}"`;
  const pct = Array.from(encoder.encode(clean), b =>
    /[A-Za-z0-9._-]/.test(String.fromCharCode(b))
      ? String.fromCharCode(b)
      : `%${HEX[b >> 4]}${HEX[b & 15]}`,
  ).join('');
  const fallback = clean.replace(/[^\x20-\x7e]/g, '_');
  return `${param}="${fallback}"; ${param}*=UTF-8''${pct}`;
}

function attachmentPart(a: MimeAttachment): string {
  const type = MIME_TYPE.test(a.mime) ? a.mime.toLowerCase() : 'application/octet-stream';
  const cid = a.contentId?.replace(/[^A-Za-z0-9._@$-]/g, '');
  const lines = [
    foldHeader(`Content-Type: ${type}; ${fileParam('name', a.name)}`),
    foldHeader(
      `Content-Disposition: ${a.inline ? 'inline' : 'attachment'}; ${fileParam('filename', a.name)}`,
    ),
    'Content-Transfer-Encoding: base64',
  ];
  if (cid) lines.push(`Content-ID: <${cid}>`);
  return [...lines, '', base64Body(a.bytes)].join(CRLF);
}

/**
 * The submission's exact bytes: headers, then multipart/alternative (text/plain from the HTML, and the HTML), wrapped
 * in multipart/mixed when there are attachments. Throws `MimeError` for an address it cannot write safely.
 */
export function buildMime(input: MimeInput): Uint8Array {
  const random = input.randomBytes ?? defaultRandom;
  const alternative = multipart('alternative', boundary(random), [
    textPart('plain', htmlToText(input.html)),
    textPart('html', input.html),
  ]);
  const attachments = input.attachments ?? [];
  const body = attachments.length
    ? multipart('mixed', boundary(random), [alternative, ...attachments.map(attachmentPart)])
    : alternative;
  return encoder.encode(topHeaders(input).join(CRLF) + CRLF + body);
}
