/**
 * The two pieces of MIME the Gmail adapter needs: the `multipart/mixed` envelope of Gmail's batch endpoint, and a walk
 * over the `payload` tree `format=full` returns. Written from RFC 2046 and Gmail's batch guide; no parsing library.
 */

// ---- batch envelope ----

export interface BatchRequestPart {
  /** Path and query below the origin, e.g. `/gmail/v1/users/me/messages/abc?format=metadata`. */
  target: string;
}

export interface BatchResponsePart {
  status: number;
  headers: Headers;
  /** Raw body text; JSON for Gmail parts. */
  body: string;
}

export function buildBatch(parts: BatchRequestPart[], boundary: string): string {
  const lines: string[] = [];
  parts.forEach((part, index) => {
    lines.push(
      `--${boundary}`,
      'Content-Type: application/http',
      `Content-ID: <item${index}>`,
      '',
      `GET ${part.target} HTTP/1.1`,
      '',
      '',
    );
  });
  lines.push(`--${boundary}--`, '');
  return lines.join('\r\n');
}

function boundaryOf(contentType: string | null): string | undefined {
  const match = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType ?? '');
  return match ? (match[1] ?? match[2]) : undefined;
}

/** Splits `text` at the first blank line. */
function headAndBody(text: string): [string, string] {
  const blank = /\r?\n\r?\n/.exec(text);
  return blank
    ? [text.slice(0, blank.index), text.slice(blank.index + blank[0].length)]
    : [text, ''];
}

/**
 * Parses a batch reply into parts indexed by the request order. Parts come back as `Content-ID: <response-itemN>`;
 * a part whose id cannot be read keeps its position. Throws when the envelope has no boundary.
 */
export function parseBatch(
  contentType: string | null,
  text: string,
  count: number,
): (BatchResponsePart | undefined)[] {
  const boundary = boundaryOf(contentType);
  if (!boundary) throw new Error('batch reply without a boundary');
  const out: (BatchResponsePart | undefined)[] = new Array(count).fill(undefined);
  const chunks = text.split(`--${boundary}`).slice(1);
  chunks.forEach((chunk, position) => {
    if (chunk.startsWith('--')) return;
    const [partHead, http] = headAndBody(chunk.replace(/^\r?\n/, ''));
    const id = /content-id:\s*<?response-item(\d+)>?/i.exec(partHead)?.[1];
    const [statusAndHeaders, body] = headAndBody(http);
    const [statusLine, ...headerLines] = statusAndHeaders.split(/\r?\n/);
    const status = Number(/^HTTP\/[\d.]+\s+(\d{3})/.exec(statusLine.trim())?.[1] ?? 0);
    const headers = new Headers();
    for (const line of headerLines) {
      const colon = line.indexOf(':');
      if (colon > 0) headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
    }
    const index = id !== undefined ? Number(id) : position;
    if (index >= 0 && index < count)
      out[index] = { status, headers, body: body.replace(/\r?\n$/, '') };
  });
  return out;
}

// ---- payload walk ----

export interface GmailHeader {
  name: string;
  value: string;
}

export interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
}

export function headerOf(
  headers: readonly GmailHeader[] | undefined,
  name: string,
): string | undefined {
  const wanted = name.toLowerCase();
  return headers?.find(h => h.name.toLowerCase() === wanted)?.value;
}

/** Decodes body bytes in the part's declared charset; unknown labels fall back to UTF-8. */
export function decodeText(bytes: Uint8Array, contentType: string | undefined): string {
  const charset = /charset="?([^";\s]+)"?/i.exec(contentType ?? '')?.[1] ?? 'utf-8';
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

export interface BodyLeaf {
  part: GmailPart;
  kind: 'text' | 'html' | 'attachment';
  /** Present when Gmail inlined the bytes. */
  data?: string;
  /** Present when the bytes must be fetched with `messages.attachments.get`. */
  attachmentId?: string;
  cid?: string;
  inline: boolean;
}

/**
 * Every leaf of a `format=full` payload. The first `text/plain` and `text/html` without a filename or an attachment
 * disposition are the body; everything else is an attachment. Gmail sometimes stores a body leaf by `attachmentId`
 * only (D15): the leaf keeps the id so the caller can resolve them all in one batch.
 */
export function walkPayload(root: GmailPart): BodyLeaf[] {
  const leaves: BodyLeaf[] = [];
  let haveText = false;
  let haveHtml = false;
  const visit = (part: GmailPart) => {
    if (part.parts?.length) {
      part.parts.forEach(visit);
      return;
    }
    const mime = (part.mimeType ?? '').toLowerCase();
    const disposition = (headerOf(part.headers, 'Content-Disposition') ?? '').toLowerCase();
    const cidHeader = headerOf(part.headers, 'Content-ID');
    const cid = cidHeader ? cidHeader.trim().replace(/^<|>$/g, '') : undefined;
    const named = Boolean(part.filename) || disposition.startsWith('attachment');
    let kind: BodyLeaf['kind'] = 'attachment';
    if (!named && mime === 'text/plain' && !haveText) {
      kind = 'text';
      haveText = true;
    } else if (!named && mime === 'text/html' && !haveHtml) {
      kind = 'html';
      haveHtml = true;
    }
    leaves.push({
      part,
      kind,
      ...(part.body?.data !== undefined ? { data: part.body.data } : {}),
      ...(part.body?.attachmentId ? { attachmentId: part.body.attachmentId } : {}),
      ...(cid ? { cid } : {}),
      inline:
        disposition.startsWith('inline') || (Boolean(cid) && !disposition.startsWith('attachment')),
    });
  };
  visit(root);
  return leaves;
}

export function fromBase64Url(data: string): Uint8Array {
  return new Uint8Array(Buffer.from(data, 'base64url'));
}
