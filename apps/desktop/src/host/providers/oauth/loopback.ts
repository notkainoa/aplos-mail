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
 * Only `127.0.0.1:<port>` or `localhost:<port>`, the names the browser was sent to: a page that rebinds its own name
 * to 127.0.0.1 (DNS rebinding) sends its own `Host` and is refused.
 */
export function loopbackHostAllowed(host: string | undefined, port: number): boolean {
  const name = host?.toLowerCase();
  return name === `${loopbackHost}:${port}` || name === `localhost:${port}`;
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

const pages = {
  ok: 'Sign-in received. You can close this tab and return to Aplos Mail.',
  failed: 'Sign-in did not finish. Return to Aplos Mail.',
  refused: 'This sign-in link is not valid.',
};

function reply(res: ServerResponse, decision: CallbackDecision): void {
  const text =
    decision.status === 400
      ? pages.refused
      : decision.outcome.kind === 'code'
        ? pages.ok
        : pages.failed;
  res.writeHead(decision.status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'",
    'referrer-policy': 'no-referrer',
    connection: 'close',
  });
  res.end(text);
}

export interface LoopbackOptions {
  state: string;
  clock: Pick<Clock, 'sleep'>;
  signal: AbortSignal;
  timeoutMs?: number;
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
    const decision = loopbackHostAllowed(req.headers.host, port)
      ? decideCallback(req.method, req.url, options.state, settled)
      : refused;
    reply(res, decision);
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
