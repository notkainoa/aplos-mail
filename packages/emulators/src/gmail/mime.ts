/**
 * Just enough RFC 822 / MIME for the emulator: build a message from parts, parse one back into a
 * tree, and turn that tree into Gmail's `payload` shape. Every message in the mailbox is stored as
 * raw bytes and parsed through this one path, so `raw`, `full` and `metadata` always agree.
 */
export interface MimeHeader {
  name: string;
  value: string;
}

export interface MimeNode {
  headers: MimeHeader[];
  mimeType: string;
  filename: string;
  disposition: string;
  /** Decoded bytes of a leaf part; empty for multiparts. */
  content: Buffer;
  children: MimeNode[];
}

/** Gmail's message part resource. */
export interface GmailPart {
  partId: string;
  mimeType: string;
  filename: string;
  headers: MimeHeader[];
  body: { size: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
}

export function headerValue(headers: readonly MimeHeader[], name: string): string | undefined {
  const lower = name.toLowerCase();
  return headers.find(h => h.name.toLowerCase() === lower)?.value;
}

/** Plain addresses (`a@b.test`) found in a header value, lowercased. */
export function addressesIn(value: string | undefined): string[] {
  return (value?.match(/[^\s<>,;"()]+@[^\s<>,;"()]+/g) ?? []).map(a => a.toLowerCase());
}

// ---------- parsing ----------

function splitHeadBody(text: string): { head: string; body: string } {
  const match = /\r?\n\r?\n/.exec(text);
  if (!match) return { head: text, body: '' };
  return { head: text.slice(0, match.index), body: text.slice(match.index + match[0].length) };
}

function parseHeaders(head: string): MimeHeader[] {
  const headers: MimeHeader[] = [];
  for (const line of head.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && headers.length) {
      headers[headers.length - 1].value += ` ${line.trim()}`; // unfold
      continue;
    }
    const colon = line.indexOf(':');
    if (colon > 0)
      headers.push({ name: line.slice(0, colon).trim(), value: line.slice(colon + 1).trim() });
  }
  return headers;
}

function valueAndParams(raw: string): { value: string; params: Record<string, string> } {
  const [first, ...rest] = raw.split(/;(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  const params: Record<string, string> = {};
  for (const piece of rest) {
    const match = /^\s*([^=\s]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|(.*?))\s*$/.exec(piece);
    if (match)
      params[match[1].toLowerCase()] = (match[2] ?? match[3] ?? '').replace(/\\(.)/g, '$1');
  }
  return { value: first.trim().toLowerCase(), params };
}

function decodeQuotedPrintable(text: string): Buffer {
  const joined = text.replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < joined.length; i++) {
    const hex = joined.slice(i + 1, i + 3);
    if (joined[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else {
      bytes.push(joined.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

function decodeBody(body: string, encoding: string): Buffer {
  switch (encoding.toLowerCase()) {
    case 'base64':
      return Buffer.from(body.replace(/\s+/g, ''), 'base64');
    case 'quoted-printable':
      return decodeQuotedPrintable(body);
    default:
      return Buffer.from(body, 'latin1');
  }
}

function splitMultipart(body: string, boundary: string): string[] {
  const parts: string[] = [];
  let current: string[] | null = null;
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trimEnd();
    if (trimmed === `--${boundary}--`) {
      if (current) parts.push(current.join('\r\n'));
      current = null;
      break;
    }
    if (trimmed === `--${boundary}`) {
      if (current) parts.push(current.join('\r\n'));
      current = [];
    } else if (current) {
      current.push(line);
    }
  }
  if (current) parts.push(current.join('\r\n'));
  return parts;
}

function parseText(text: string): MimeNode {
  const { head, body } = splitHeadBody(text);
  const headers = parseHeaders(head);
  const type = valueAndParams(headerValue(headers, 'content-type') ?? 'text/plain');
  const disposition = valueAndParams(headerValue(headers, 'content-disposition') ?? '');
  const node: MimeNode = {
    headers,
    mimeType: type.value || 'text/plain',
    filename: disposition.params.filename ?? type.params.name ?? '',
    disposition: disposition.value,
    content: Buffer.alloc(0),
    children: [],
  };
  if (node.mimeType.startsWith('multipart/') && type.params.boundary) {
    node.children = splitMultipart(body, type.params.boundary).map(parseText);
  } else {
    node.content = decodeBody(body, headerValue(headers, 'content-transfer-encoding') ?? '7bit');
  }
  return node;
}

export function parseRfc822(raw: Buffer): MimeNode {
  return parseText(raw.toString('latin1'));
}

export function topHeaders(raw: Buffer): MimeHeader[] {
  return parseHeaders(splitHeadBody(raw.toString('latin1')).head);
}

// ---------- payload ----------

export interface PayloadOptions {
  /** Store this part's bytes and return the id Gmail would show for it. */
  storeAttachment(data: Buffer): string;
  /** Hold text/html bodies as attachmentId-only parts, as Gmail sometimes does. */
  htmlAsAttachment: boolean;
}

const isTextBody = (node: MimeNode): boolean =>
  node.mimeType === 'text/plain' || node.mimeType === 'text/html';

export function toPayload(node: MimeNode, options: PayloadOptions, partId = ''): GmailPart {
  const part: GmailPart = {
    partId,
    mimeType: node.mimeType,
    filename: node.filename,
    headers: node.headers.map(h => ({ ...h })),
    body: { size: 0 },
  };
  if (node.children.length) {
    part.parts = node.children.map((child, index) =>
      toPayload(child, options, partId ? `${partId}.${index}` : String(index)),
    );
    return part;
  }
  part.body.size = node.content.length;
  const attachmentLike =
    node.filename !== '' || node.disposition === 'attachment' || !isTextBody(node);
  if (attachmentLike || (options.htmlAsAttachment && node.mimeType === 'text/html')) {
    part.body.attachmentId = options.storeAttachment(node.content);
  } else {
    part.body.data = node.content.toString('base64url');
  }
  return part;
}

export function collectLeaves(node: MimeNode): MimeNode[] {
  return node.children.length ? node.children.flatMap(collectLeaves) : [node];
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Readable text of every text part, plain preferred over html when both exist. */
export function bodyText(root: MimeNode): string {
  const leaves = collectLeaves(root).filter(l => isTextBody(l) && l.filename === '');
  const plain = leaves
    .filter(l => l.mimeType === 'text/plain')
    .map(l => l.content.toString('utf8'));
  if (plain.length) return plain.join('\n');
  return leaves.map(l => htmlToText(l.content.toString('utf8'))).join('\n');
}

/** Gmail's snippet: the first characters of the text, with HTML special characters escaped. */
export function makeSnippet(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------- building ----------

export interface BuildAttachment {
  filename: string;
  mimeType: string;
  data: Buffer;
  contentId?: string;
}

export interface BuildSpec {
  headers: [string, string][];
  text?: string;
  html?: string;
  attachments?: BuildAttachment[];
}

interface BuiltPart {
  headers: string[];
  body: string;
}

const isAscii = (text: string): boolean => /^[\x00-\x7f]*$/.test(text);

function wrapBase64(data: Buffer): string {
  return (data.toString('base64').match(/.{1,76}/g) ?? []).join('\r\n');
}

function textPart(mimeType: string, text: string): BuiltPart {
  const ascii = isAscii(text);
  return {
    headers: [
      `Content-Type: ${mimeType}; charset="UTF-8"`,
      `Content-Transfer-Encoding: ${ascii ? '7bit' : 'base64'}`,
    ],
    body: ascii ? text.replace(/\r?\n/g, '\r\n') : wrapBase64(Buffer.from(text, 'utf8')),
  };
}

function attachmentPart(a: BuildAttachment): BuiltPart {
  const headers = [
    `Content-Type: ${a.mimeType}; name="${a.filename}"`,
    `Content-Disposition: ${a.contentId ? 'inline' : 'attachment'}; filename="${a.filename}"`,
    'Content-Transfer-Encoding: base64',
  ];
  if (a.contentId) headers.push(`Content-ID: <${a.contentId}>`);
  return { headers, body: wrapBase64(a.data) };
}

function multipart(subtype: string, children: BuiltPart[], boundary: string): BuiltPart {
  const body =
    children.map(c => `--${boundary}\r\n${c.headers.join('\r\n')}\r\n\r\n${c.body}`).join('\r\n') +
    `\r\n--${boundary}--\r\n`;
  return { headers: [`Content-Type: multipart/${subtype}; boundary="${boundary}"`], body };
}

/** Builds an RFC 822 message. `nextBoundary` supplies deterministic boundary strings. */
export function buildRfc822(spec: BuildSpec, nextBoundary: () => string): Buffer {
  const texts: BuiltPart[] = [];
  if (spec.text !== undefined || spec.html === undefined)
    texts.push(textPart('text/plain', spec.text ?? ''));
  if (spec.html !== undefined) texts.push(textPart('text/html', spec.html));
  let root = texts.length > 1 ? multipart('alternative', texts, nextBoundary()) : texts[0];
  if (spec.attachments?.length)
    root = multipart('mixed', [root, ...spec.attachments.map(attachmentPart)], nextBoundary());
  const lines = [
    ...spec.headers.map(([name, value]) => `${name}: ${value}`),
    'MIME-Version: 1.0',
    ...root.headers,
  ];
  return Buffer.from(`${lines.join('\r\n')}\r\n\r\n${root.body}`, 'latin1');
}

/** Prepends the headers Gmail adds on send or insert when the client left them out. */
export function withDefaultHeaders(raw: Buffer, defaults: Record<string, string>): Buffer {
  const present = new Set(topHeaders(raw).map(h => h.name.toLowerCase()));
  const missing = Object.entries(defaults).filter(([name]) => !present.has(name.toLowerCase()));
  if (!missing.length) return raw;
  return Buffer.concat([
    Buffer.from(missing.map(([n, v]) => `${n}: ${v}\r\n`).join(''), 'latin1'),
    raw,
  ]);
}

/** The message without the named top-level headers (case-insensitive), folded continuation lines included. */
export function withoutHeaders(raw: Buffer, names: readonly string[]): Buffer {
  const text = raw.toString('latin1');
  const { head, rest } = splitHeadBodyKeepingSeparator(text);
  const drop = new Set(names.map(n => n.toLowerCase()));
  const kept: string[] = [];
  let dropping = false;
  for (const line of head.split(/(?<=\n)/)) {
    if (/^[ \t]/.test(line)) {
      if (!dropping) kept.push(line);
      continue;
    }
    dropping = drop.has(line.slice(0, Math.max(0, line.indexOf(':'))).toLowerCase());
    if (!dropping) kept.push(line);
  }
  return Buffer.from(kept.join('') + rest, 'latin1');
}

function splitHeadBodyKeepingSeparator(text: string): { head: string; rest: string } {
  const at = text.search(/\r?\n\r?\n/);
  if (at === -1) return { head: text, rest: '' };
  const lineEnd = text.indexOf('\n', at) + 1;
  return { head: text.slice(0, lineEnd), rest: text.slice(lineEnd) };
}
