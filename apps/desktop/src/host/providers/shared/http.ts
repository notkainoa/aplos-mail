import type { Clock as PortClock } from '@aplos/engine/ports';
import { parseRetryAfter } from './retry-after';

/** The client only waits (timeouts); it never arms a timer through `Clock.timer`. */
type Clock = Pick<PortClock, 'now' | 'sleep'>;

/**
 * The one HTTP door for provider adapters.
 *
 * `request` performs exactly ONE fetch. It never loops, never retries and never sleeps to pace.
 * Retrying and pacing belong to the governor (ARCH 6.1), the single retry layer. Adapters must never
 * wrap `request` in a loop or a retry helper; call it from inside `governor.run` and let a failure
 * propagate. The only wait in here is the request timeout, driven by the injected clock so fake
 * clocks can fast-forward it.
 *
 * Failures are typed (`HttpFailure`) and carry no URL, header or body, so they are safe to log.
 */

export type HttpFailureKind = 'network' | 'timeout' | 'aborted';

export class HttpFailure extends Error {
  /**
   * Whether the request may have reached the server. True means an outcome we cannot know: a write
   * that fails this way is uncertain (ARCH 6.3), not failed. False means it certainly never left
   * (DNS failure, refused connection, bad certificate, aborted before the fetch started).
   */
  constructor(
    readonly kind: HttpFailureKind,
    readonly written: boolean,
    options?: { cause?: unknown },
  ) {
    super(`http ${kind}${written ? ' (request may have been sent)' : ''}`, options);
    this.name = 'HttpFailure';
  }
}

export interface HttpResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  /** The body is read inside `request`, under the timeout, so these never touch the network. */
  json<T = unknown>(): T;
  text(): string;
  /** Parsed `Retry-After`, in ms from the moment the response arrived; no cap. */
  retryAfterMs?: number;
}

export interface HttpClientOptions {
  fetch: typeof fetch;
  clock: Clock;
  /** Google asks for 'gzip' in the User-Agent to enable compression; it is appended when missing. */
  userAgent: string;
  /** Covers connecting, headers and reading the body. Default 30 s. */
  timeoutMs?: number;
}

export interface HttpClient {
  request(url: string | URL, init?: RequestInit): Promise<HttpResponse>;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export function createHttpClient(options: HttpClientOptions): HttpClient {
  const { clock } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const userAgent = /gzip/i.test(options.userAgent)
    ? options.userAgent
    : `${options.userAgent} (gzip)`;

  return {
    async request(url, init = {}) {
      const caller = init.signal ?? undefined;
      if (caller?.aborted) throw new HttpFailure('aborted', false, { cause: caller.reason });

      const headers = new Headers(init.headers);
      headers.set('User-Agent', userAgent);
      if (!headers.has('Accept-Encoding')) headers.set('Accept-Encoding', 'gzip');

      // One internal controller reaches fetch; it fires for the caller's abort or our timeout.
      const internal = new AbortController();
      const timer = new AbortController();
      let cause: 'timeout' | 'aborted' | undefined;
      // Settles the request on an abort even when the fetch, or the stream behind its response,
      // ignores the signal (an in-process emulator fetch can).
      let rejectStopped!: (error: unknown) => void;
      const stopped = new Promise<never>((_, reject) => {
        rejectStopped = reject;
      });
      stopped.catch(() => {
        /* raced below; never unhandled */
      });
      const stop = (why: 'timeout' | 'aborted') => {
        cause ??= why;
        internal.abort();
        rejectStopped(new Error(why));
      };
      const onCallerAbort = () => stop('aborted');
      caller?.addEventListener('abort', onCallerAbort, { once: true });
      clock.sleep(timeoutMs, timer.signal).then(
        () => stop('timeout'),
        () => {
          /* timer cancelled */
        },
      );

      let response: Response | undefined;
      try {
        response = await Promise.race([
          options.fetch(url, { ...init, headers, signal: internal.signal }),
          stopped,
        ]);
        const body = await Promise.race([response.text(), stopped]);
        return {
          status: response.status,
          ok: response.ok,
          headers: response.headers,
          json: <T>() => JSON.parse(body) as T,
          text: () => body,
          retryAfterMs: parseRetryAfter(response.headers.get('retry-after'), clock.now()),
        };
      } catch (error) {
        // Release a body the abort left half-read; a stream that ignores cancel is left to the GC.
        if (cause && response?.body && !response.bodyUsed) response.body.cancel().catch(() => {});
        if (cause) throw new HttpFailure(cause, true, { cause: error });
        // Aborted by something other than us (a custom fetch) is still an abort.
        if (caller?.aborted) throw new HttpFailure('aborted', true, { cause: error });
        throw new HttpFailure('network', mayHaveBeenWritten(error), { cause: error });
      } finally {
        timer.abort();
        caller?.removeEventListener('abort', onCallerAbort);
      }
    },
  };
}

/** Error codes that prove no byte of the request was sent. Everything else is assumed written. */
const NEVER_SENT = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'EAI_FAIL',
  'ECONNREFUSED',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EADDRNOTAVAIL',
  'ERR_INVALID_URL',
  'ERR_INVALID_ARG_TYPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
]);

function mayHaveBeenWritten(error: unknown): boolean {
  const codes: string[] = [];
  const walk = (e: unknown, depth: number) => {
    if (!e || typeof e !== 'object' || depth > 5) return;
    const { code, cause, errors } = e as { code?: unknown; cause?: unknown; errors?: unknown };
    if (typeof code === 'string') codes.push(code);
    walk(cause, depth + 1);
    if (Array.isArray(errors)) for (const inner of errors) walk(inner, depth + 1);
  };
  walk(error, 0);
  // No known code, or any code that is not a pre-connection failure: assume the request left.
  return codes.length === 0 || !codes.every(code => NEVER_SENT.has(code));
}
