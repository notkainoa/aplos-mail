// The loopback redirect of the installed-app sign-in: a one-shot HTTP listener on 127.0.0.1 that accepts exactly
// one callback carrying the expected `state`. Anything else (wrong or missing state, another path or method, a
// `Host` other than this listener's own, a request after the one accepted) is answered 400 and ignored. The listener closes on success, failure, abort and
// timeout. It never echoes the query back into the page.

import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Clock } from '@aplos/engine/ports';

export const loopbackHost = '127.0.0.1';
export const callbackTimeoutMs = 5 * 60_000;

export type CallbackOutcome =
  | { kind: 'code'; code: string }
  | { kind: 'error'; error: string }
  | { kind: 'timeout' }
  | { kind: 'aborted' };

export type CallbackDecision =
  { status: 200; outcome: CallbackOutcome & { kind: 'code' | 'error' } } | { status: 400 };

const refused: CallbackDecision = { status: 400 };

/** Constant-time: both sides are hashed to one length first, so neither length nor content leaks through timing. */
export function sameSecret(a: string, b: string): boolean {
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right);
}

function parsePath(rawUrl: string): URL | undefined {
  try {
    // Joined, not resolved: a target like `//host/` must keep `//host/` as its path.
    return new URL(`http://${loopbackHost}${rawUrl}`);
  } catch {
    return undefined;
  }
}

/**
 * Exactly `127.0.0.1:<port>` or `localhost:<port>`, as a browser sends them: a page that rebinds its own name to
 * 127.0.0.1 (DNS rebinding) sends its own `Host` and is refused, and so is any other spelling (case, trailing dot,
 * `[::1]`, another port).
 */
export function loopbackHostAllowed(host: string | undefined, port: number): boolean {
  return host === `${loopbackHost}:${port}` || host === `localhost:${port}`;
}

/** The one `Host` header, from the raw headers: Node keeps only the first of duplicates in `headers.host`. */
export function soleHostHeader(rawHeaders: readonly string[]): string | undefined {
  const values: string[] = [];
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    if (rawHeaders[i].toLowerCase() === 'host') values.push(rawHeaders[i + 1]);
  }
  return values.length === 1 ? values[0] : undefined;
}

/** What one request gets. Pure, so the rules are testable without a socket. */
export function decideCallback(
  method: string | undefined,
  rawUrl: string | undefined,
  expectedState: string,
  settled: boolean,
): CallbackDecision {
  if (settled || method !== 'GET' || !rawUrl?.startsWith('/')) return refused;
  const url = parsePath(rawUrl);
  if (!url || url.pathname !== '/') return refused;
  const state = url.searchParams.get('state');
  if (!state || !sameSecret(state, expectedState)) return refused;
  const error = url.searchParams.get('error');
  if (error) return { status: 200, outcome: { kind: 'error', error } };
  const code = url.searchParams.get('code');
  if (code) return { status: 200, outcome: { kind: 'code', code } };
  return { status: 200, outcome: { kind: 'error', error: 'missing_code' } };
}

const refusedPage = 'This sign-in link is not valid.';

/**
 * The success page hands the owner back to the app: a meta refresh to the fixed `aplos://oauth-return`
 * deep link, plus the same link as a visible fallback for the browser that refuses the scheme. The
 * deep link is the only thing interpolated and it is a fixed prefix plus the app's own hex nonce, so
 * the page stays fully static: no scripts, no styles, no reflected input, and `default-src 'none'`
 * still covers it (a meta refresh and an anchor are navigations, not resource loads).
 */
const returningPage = (link: string): string =>
  '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  `<meta http-equiv="refresh" content="0;url=${link}">` +
  '<title>Sign-in complete</title></head><body>' +
  '<p>Sign-in complete. Returning to Aplos Mail…</p>' +
  `<p>If it does not open, <a href="${link}">return to Aplos Mail</a>.</p>` +
  '</body></html>';

const failedPage = (link: string | undefined): string =>
  link
    ? '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
      '<title>Sign-in</title></head><body>' +
      '<p>Sign-in did not finish.</p>' +
      `<p><a href="${link}">Return to Aplos Mail</a></p>` +
      '</body></html>'
    : 'Sign-in did not finish. Return to Aplos Mail.';

interface Page {
  body: string;
  html: boolean;
}

function page(decision: CallbackDecision, returnLink: string | undefined): Page {
  if (decision.status === 400) return { body: refusedPage, html: false };
  if (decision.outcome.kind === 'code')
    return returnLink
      ? { body: returningPage(returnLink), html: true }
      : { body: 'Sign-in received. You can close this tab and return to Aplos Mail.', html: false };
  return { body: failedPage(returnLink), html: returnLink !== undefined };
}

function reply(res: ServerResponse, decision: CallbackDecision, returnLink?: string): void {
  const result = page(decision, returnLink);
  res.writeHead(decision.status, {
    'content-type': result.html ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    // `default-src` does not cover framing, the base URI or form targets: close those too.
    'content-security-policy':
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    'referrer-policy': 'no-referrer',
    connection: 'close',
  });
  res.end(result.body);
}

export interface LoopbackOptions {
  state: string;
  clock: Pick<Clock, 'sleep'>;
  signal: AbortSignal;
  timeoutMs?: number;
  /**
   * The `aplos://oauth-return?n=<nonce>` link the ok page redirects to and the failed page offers.
   * Absent: the pages stay plain text, exactly as before. The refused (400) page never carries it.
   */
  returnLink?: string;
}

export interface Loopback {
  /** `http://127.0.0.1:<port>/`, the `redirect_uri` of both the consent URL and the code exchange. */
  redirectUri: string;
  address: AddressInfo;
  /** Always resolves, exactly once. */
  outcome: Promise<CallbackOutcome>;
  /** Ends the wait (as an abort) and closes the listener; harmless after it settled. */
  close(): void;
}

function listen(server: Server): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, loopbackHost, () => {
      server.off('error', reject);
      resolve(server.address() as AddressInfo);
    });
  });
}

function shutdown(server: Server, now: boolean): void {
  server.close();
  if (now) server.closeAllConnections();
}

export async function openLoopback(options: LoopbackOptions): Promise<Loopback> {
  let settled = false;
  let resolveOutcome!: (outcome: CallbackOutcome) => void;
  const outcome = new Promise<CallbackOutcome>(resolve => {
    resolveOutcome = resolve;
  });
  const timer = new AbortController();
  let port = 0;
  const server = createServer((req, res) => {
    const decision = loopbackHostAllowed(soleHostHeader(req.rawHeaders), port)
      ? decideCallback(req.method, req.url, options.state, settled)
      : refused;
    reply(res, decision, options.returnLink);
    if (decision.status !== 200) return;
    // The answer is written first; the listener stops taking connections now and drops the rest once it is sent.
    finish(decision.outcome, false);
    res.once('close', () => server.closeAllConnections());
  });
  const onAbort = () => finish({ kind: 'aborted' }, true);
  function finish(result: CallbackOutcome, now: boolean): void {
    if (settled) return;
    settled = true;
    timer.abort();
    options.signal.removeEventListener('abort', onAbort);
    shutdown(server, now);
    resolveOutcome(result);
  }
  const address = await listen(server);
  port = address.port;
  options.signal.addEventListener('abort', onAbort, { once: true });
  if (options.signal.aborted) onAbort();
  options.clock.sleep(options.timeoutMs ?? callbackTimeoutMs, timer.signal).then(
    () => finish({ kind: 'timeout' }, true),
    () => {
      /* settled first */
    },
  );
  return {
    redirectUri: `http://${loopbackHost}:${address.port}/`,
    address,
    outcome,
    close: onAbort,
  };
}
