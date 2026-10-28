import { statusText } from './http-status';
import { replyBody, type Reply } from './reply';

/**
 * Gmail's batch endpoint: multipart/mixed in, multipart/mixed out. Each part is an embedded HTTP
 * request or response. Batching saves round trips, not quota: every part is metered on its own.
 */
export const MAX_BATCH_PARTS = 100;

export interface BatchPart {
  contentId: string;
  method: string;
  /** Path and query, e.g. /gmail/v1/users/me/messages/abc?format=metadata. */
  target: string;
  headers: Headers;
  body: Buffer;
}

export function boundaryOf(contentType: string | null): string | undefined {
  const match = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType ?? '');
  return match ? (match[1] ?? match[2]) : undefined;
}

/** Splits a batch body into its embedded requests. Throws on a part that is not an HTTP request. */
export function parseBatch(body: string, boundary: string): BatchPart[] {
  const parts: BatchPart[] = [];
  const chunks = body
    .split(new RegExp(`--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?[ \\t]*\\r?\\n?`))
    .slice(1);
  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    const split = /\r?\n\r?\n/.exec(chunk);
    if (!split) throw new Error('Batch part has no headers');
    const partHeaders = chunk.slice(0, split.index);
    const content = chunk.slice(split.index + split[0].length);
    const contentId =
      /^content-id:\s*(.+)$/im.exec(partHeaders)?.[1]?.trim() ?? `<item${parts.length + 1}>`;

    const requestSplit = /\r?\n\r?\n/.exec(content);
    const head = requestSplit ? content.slice(0, requestSplit.index) : content;
    const payload = requestSplit ? content.slice(requestSplit.index + requestSplit[0].length) : '';
    const [requestLine, ...headerLines] = head.split(/\r?\n/);
    const line = /^([A-Z]+)\s+(\S+)(?:\s+HTTP\/\d(?:\.\d)?)?\s*$/.exec(requestLine.trim());
    if (!line) throw new Error('Batch part is not an HTTP request');
    const headers = new Headers();
    for (const headerLine of headerLines) {
      const colon = headerLine.indexOf(':');
      if (colon > 0)
        headers.set(headerLine.slice(0, colon).trim(), headerLine.slice(colon + 1).trim());
    }
    parts.push({
      contentId,
      method: line[1],
      target: line[2],
      headers,
      body: Buffer.from(payload.replace(/\r?\n$/, ''), 'utf8'),
    });
  }
  return parts;
}

/** Builds the multipart/mixed response body and its Content-Type. */
export function buildBatchResponse(
  replies: { contentId: string; reply: Reply }[],
  boundary: string,
): { contentType: string; body: string } {
  const pieces = replies.map(({ contentId, reply }, index) => {
    const text = replyBody(reply);
    const innerHeaders = [
      ...(reply.json !== undefined ? ['Content-Type: application/json; charset=UTF-8'] : []),
      ...Object.entries(reply.headers).map(([name, value]) => `${name}: ${value}`),
      `Content-Length: ${Buffer.byteLength(text)}`,
    ];
    const id = contentId.replace(/^<|>$/g, '') || `item${index + 1}`;
    return [
      `--${boundary}`,
      'Content-Type: application/http',
      `Content-ID: <response-${id}>`,
      '',
      `HTTP/1.1 ${reply.status} ${statusText(reply.status)}`,
      ...innerHeaders,
      '',
      text,
    ].join('\r\n');
  });
  return {
    contentType: `multipart/mixed; boundary=${boundary}`,
    body: `${pieces.join('\r\n')}\r\n--${boundary}--\r\n`,
  };
}

/**
 * Chance that a part of a batch of `size` is refused with 429 even though the unit meter has room.
 * Google rate-limits big batches harder: nothing up to 10 parts, about 1.2% at 25, about 19% at 50,
 * and (extrapolated) up to 55% at 100.
 */
export function batchRefusalProbability(size: number): number {
  const points: [number, number][] = [
    [10, 0],
    [25, 0.012],
    [50, 0.19],
    [100, 0.55],
  ];
  if (size <= points[0][0]) return 0;
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1];
    const [x1, y1] = points[i];
    if (size <= x1) return y0 + ((y1 - y0) * (size - x0)) / (x1 - x0);
  }
  return points[points.length - 1][1];
}
