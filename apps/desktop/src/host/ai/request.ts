import { AiCallError } from '@aplos/engine';
import { baseUrl, providerRow, type AiProviderId, type ProviderRow } from './providers';
import type { AiKeys } from './keys';

/**
 * The one HTTP call every provider transport shares: base-URL resolution, auth, provider headers, a timeout and
 * `AiCallError` classification. No retries here and no `retry-after` sleep — the engine owns the single AI retry
 * layer (ARCH 8.4), so this file only reports failures. Provider error bodies are never read into messages.
 */

/** What `createAiHost` was given; the transports take it apart. */
export interface AiDeps {
  fetch: typeof fetch;
  env: NodeJS.ProcessEnv;
  /**
   * The owner's server addresses from Settings → AI (local providers); env vars are the fallback. A thunk is
   * re-read per request so a Settings change takes effect without a restart.
   */
  addresses?: Partial<Record<AiProviderId, string>> | (() => Partial<Record<AiProviderId, string>>);
}

export interface CallOptions {
  method?: string;
  body?: BodyInit;
  /** Send `Content-Type: application/json`. Defaults to true when there is a body; false for multipart. */
  json?: boolean;
  headers?: Record<string, string>;
  /** One attempt's ceiling; the default covers a slow streamed answer. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export const cancelled = (): AiCallError => new AiCallError('cancelled', 'AI request cancelled.');

/** `Retry-After` in seconds or as an HTTP-date, to milliseconds from now. */
export function retryAfterMs(headers: Headers): number | undefined {
  const raw = headers.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(raw);
  if (!Number.isNaN(at)) return Math.max(0, at - Date.now());
  return undefined;
}

/** A bounded `response.json()` for non-streaming endpoints — a hostile body can't grow unbounded. */
export async function readJson(
  response: Response,
  label: string,
  maxBytes = 1024 * 1024,
): Promise<unknown> {
  const text = await response.text();
  if (text.length > maxBytes)
    throw new AiCallError('invalid', `${label} returned a response that was too large.`);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AiCallError('invalid', `${label} returned an invalid response.`);
  }
}

/** Authorization-class headers redacted for any log field; the transport itself never logs. */
export function redactHeaders(
  headers: HeadersInit | Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers as Record<string, string>))
    out[k] = /^authorization$|^x-api-key$/i.test(k) ? '<redacted>' : String(v);
  return out;
}

/** An HTTP status becomes a code and one generic sentence; the body is left unread. */
export function httpError(status: number, headers: Headers, label: string): AiCallError {
  if (status === 401 || status === 403)
    return new AiCallError('rejected', `${label} rejected the API key.`);
  if (status === 402)
    return new AiCallError('rejected', `${label} needs a paid plan or billing top-up.`);
  if (status === 429)
    return new AiCallError('rateLimited', `${label} rate limit reached.`, retryAfterMs(headers));
  if (status >= 500) return new AiCallError('unreachable', `${label} request failed (${status}).`);
  return new AiCallError('invalid', `${label} request failed (${status}).`);
}

const isAbort = (error: unknown): boolean =>
  error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');

/** Wire-shape accessors — provider JSON is `unknown` until a field is checked. */
export const asObj = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
export const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

function authHeaders(row: ProviderRow, key: string | undefined): Record<string, string> {
  if (row.wire === 'anthropic')
    return { 'anthropic-version': '2023-06-01', ...(key ? { 'x-api-key': key } : {}) };
  return key ? { Authorization: `Bearer ${key}` } : {};
}

/**
 * One provider call. `path` is relative to the provider's base URL unless it is an absolute `http(s)` URL.
 * Throws `AiCallError` already classified: `unavailable` (no address), `missingKey`, `cancelled`, `unreachable`,
 * or the `httpError` mapping.
 */
export async function callProvider(
  deps: AiDeps,
  keys: AiKeys,
  row: ProviderRow,
  path: string,
  init: CallOptions = {},
): Promise<Response> {
  const base = baseUrl(
    row,
    deps.env,
    typeof deps.addresses === 'function' ? deps.addresses() : deps.addresses,
  );
  if (!base && !/^https?:\/\//.test(path))
    throw new AiCallError(
      'unavailable',
      `${row.label} has no server address. Set one in Settings → AI.`,
    );
  const key = keys.keyOf(row.id);
  if (!key && !row.keyOptional)
    throw new AiCallError('missingKey', `Add your ${row.label} key in Settings → AI.`);
  const url = /^https?:\/\//.test(path) ? path : `${base}/${path}`;
  const method = init.method ?? (init.body === undefined ? 'GET' : 'POST');
  const signals = [AbortSignal.timeout(init.timeoutMs ?? 90_000)];
  if (init.signal) signals.push(init.signal);
  let response: Response;
  try {
    response = await deps.fetch(url, {
      // A redirect could carry the key header to a different host — never follow one.
      redirect: 'error',
      method,
      headers: {
        ...authHeaders(row, key),
        ...(init.body !== undefined && init.json !== false
          ? { 'Content-Type': 'application/json' }
          : {}),
        ...row.headers,
        ...init.headers,
      },
      ...(method === 'GET' || method === 'HEAD' ? {} : { body: init.body }),
      signal: AbortSignal.any(signals),
    });
  } catch (error) {
    if (init.signal?.aborted) throw cancelled();
    // A timeout here is a provider that did not answer, not a caller that gave up.
    if (isAbort(error)) throw new AiCallError('unreachable', `${row.label} did not answer.`);
    throw new AiCallError('unreachable', `${row.label} could not complete the request.`);
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw httpError(response.status, response.headers, row.label);
  }
  return response;
}

/**
 * Reads a `text/event-stream` body: each `data:` line's JSON goes to `onData`; `[DONE]` ends the read early.
 * An abort while a read is pending rejects with `cancelled`.
 */
export async function readSse(
  body: ReadableStream<Uint8Array>,
  onData: (value: Record<string, unknown>) => void,
  signal?: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let total = 0;
  const rowLabel = 'the provider';
  const line = (raw: string): boolean => {
    if (!raw.startsWith('data:')) return false;
    const data = raw.slice(5).trim();
    if (!data) return false;
    if (data === '[DONE]') return true;
    try {
      onData(JSON.parse(data) as Record<string, unknown>);
    } catch (error) {
      if (error instanceof SyntaxError) return false;
      throw error;
    }
    return false;
  };
  let stop: (() => void) | undefined;
  const aborted = signal
    ? new Promise<never>((_, reject) => {
        stop = () => reject(cancelled());
        if (signal.aborted) stop();
        else signal.addEventListener('abort', stop, { once: true });
      })
    : undefined;
  aborted?.catch(() => {});
  try {
    for (;;) {
      const { done, value } = await (aborted
        ? Promise.race([reader.read(), aborted])
        : reader.read());
      if (done) break;
      total += value.length;
      if (total > 8 * 1024 * 1024)
        throw new AiCallError('invalid', `${rowLabel} streamed a response that was too large.`);
      buffer += decoder.decode(value, { stream: true });
      for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
        if (at > 64 * 1024)
          throw new AiCallError('invalid', `${rowLabel} sent an event that was too large.`);
        if (line(buffer.slice(0, at).replace(/\r$/, ''))) return;
        buffer = buffer.slice(at + 1);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) line(buffer.trim());
  } finally {
    if (stop) signal?.removeEventListener('abort', stop);
    void reader.cancel().catch(() => {});
  }
}

/** The row for `id`, or the classified `noProvider` failure every caller can throw. */
export function requireRow(id: string): ProviderRow {
  const row = providerRow(id);
  if (!row) throw new AiCallError('noProvider', 'That AI provider is not known.');
  return row;
}
