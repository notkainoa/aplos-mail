import type { ApiError } from './errors';

/** An answer before it becomes a `Response`; batch parts and fields masks work on this shape. */
export interface Reply {
  status: number;
  headers: Record<string, string>;
  json?: unknown;
  text?: string;
  /** Google's `errors[0].reason` for refusals, copied to the request log. */
  reason?: string;
}

export const jsonReply = (
  json: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Reply => ({ status, headers, json });
export const emptyReply = (status = 204): Reply => ({ status, headers: {} });
export const errorReply = (error: ApiError, headers: Record<string, string> = {}): Reply => ({
  status: error.httpStatus,
  headers,
  json: error.body(),
  reason: error.visibleReason,
});

export function replyBody(reply: Reply): string {
  if (reply.text !== undefined) return reply.text;
  return reply.json === undefined ? '' : JSON.stringify(reply.json);
}

export function toResponse(reply: Reply): Response {
  const body = replyBody(reply);
  const headers = new Headers(reply.headers);
  if (reply.json !== undefined && !headers.has('content-type'))
    headers.set('content-type', 'application/json; charset=UTF-8');
  const bodyless =
    reply.status === 204 ||
    reply.status === 205 ||
    reply.status === 304 ||
    (reply.status >= 300 && reply.status < 400);
  return new Response(bodyless ? null : body, { status: reply.status, headers });
}

export async function replyFromResponse(response: Response): Promise<Reply> {
  const text = await response.text();
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  let reason: string | undefined;
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    const error = parsed.error;
    if (typeof error === 'string') reason = error;
    else if (error && typeof error === 'object') {
      const first = (error as { errors?: { reason?: string }[] }).errors?.[0];
      reason = first?.reason;
    }
  } catch {
    // Not JSON; there is no reason to record.
  }
  return { status: response.status, headers, text, reason };
}
