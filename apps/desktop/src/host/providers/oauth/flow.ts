// Google's installed-app authorization-code flow with PKCE (plan 20 PV5): a loopback listener on 127.0.0.1, the
// consent URL handed to the host's `openExternal` (this module never starts a browser), and one governed code
// exchange. Abortable through the caller's signal. No code, verifier, token or secret reaches an error or a log.

import type { BoundGovernor, Clock, ConnectRequest, GovernedRequest } from '@aplos/engine/ports';
import { ProviderError } from '@aplos/engine/ports';
import type { HttpClient, HttpResponse } from '../shared/http';
import {
  abortedError,
  asConnectError,
  connectError,
  ConnectError,
  redirectError,
} from './connect-errors';
import { reconnectAuthParams } from './grant';
import { callbackTimeoutMs, openLoopback, type CallbackOutcome, type Loopback } from './loopback';
import { createPkce, createState, nodeRandom, type Pkce, type RandomSource } from './pkce';
import { oauthReturnLink, type OauthReturns, type OauthReturnPurpose } from './returns';
import { googleTokenUrl } from './token-source';
import { refusalError, transportError } from './token-errors';

/** How long the return link outlives the callback wait. */
const returnGraceMs = 60_000;

export const googleAuthUrl = 'https://accounts.google.com/o/oauth2/v2/auth';
export const googleRevokeUrl = 'https://oauth2.googleapis.com/revoke';

/**
 * The endpoints are always Google's fixed URLs (`googleAuthUrl`, `googleTokenUrl`, `googleRevokeUrl`): no option,
 * setting or variable may send a code, verifier, token or secret elsewhere. Tests reroute at the transport (`http`).
 */
export interface FlowDeps {
  /** One request, no retries (`shared/http.ts`); called only inside `governor.run`. */
  http: HttpClient;
  /** Opens the consent URL in the owner's browser (Electron's `shell.openExternal`). */
  openExternal(url: string): Promise<void> | void;
  random?: RandomSource;
  /** Default 5 minutes. */
  callbackTimeoutMs?: number;
  /**
   * The deep-link nonce registry behind `returns.ts`: when present and the request names a `returnTo`
   * window, the success page redirects to `aplos://oauth-return?n=<nonce>` so that window comes
   * forward. Absent: the pages stay plain text.
   */
  returns?: OauthReturns;
}

export interface FlowClient {
  clientId: string;
  clientSecret?: string;
}

export interface FlowRequest {
  client: FlowClient;
  scopes: readonly string[];
  /** `access_type`, `prompt`, `login_hint`; never overrides the flow's own parameters. */
  params: Readonly<Record<string, string>>;
  /** The window the success page's deep link returns to (recorded with the nonce by `FlowDeps.returns`). */
  returnTo?: OauthReturnPurpose;
}

export interface FlowContext {
  governor: BoundGovernor;
  clock: Clock;
  signal: AbortSignal;
}

/** The token endpoint's answer, parsed but unchecked, and when it arrived. */
export interface TokenExchange {
  receivedAt: number;
  body: Record<string, unknown>;
}

/** New connects ask for offline access with consent; reconnects and re-grants also preselect the account. */
export function authParamsFor(req: Pick<ConnectRequest, 'mode' | 'loginHint'>) {
  if (req.mode === 'new') return { access_type: 'offline', prompt: 'consent' };
  return reconnectAuthParams(req.loginHint);
}

export interface ConsentUrlInput {
  base: string;
  request: FlowRequest;
  redirectUri: string;
  state: string;
  pkce: Pkce;
}

export function consentUrl(input: ConsentUrlInput): string {
  const url = new URL(input.base);
  const params = new URLSearchParams(input.request.params);
  params.set('client_id', input.request.client.clientId);
  params.set('redirect_uri', input.redirectUri);
  params.set('response_type', 'code');
  params.set('scope', input.request.scopes.join(' '));
  params.set('state', input.state);
  params.set('code_challenge', input.pkce.challenge);
  params.set('code_challenge_method', input.pkce.method);
  url.search = params.toString();
  return url.toString();
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortedError();
}

async function openCallback(
  state: string,
  deps: FlowDeps,
  ctx: FlowContext,
  returnLink: string | undefined,
): Promise<Loopback> {
  try {
    return await openLoopback({
      state,
      clock: ctx.clock,
      signal: ctx.signal,
      timeoutMs: deps.callbackTimeoutMs,
      ...(returnLink ? { returnLink } : {}),
    });
  } catch {
    throw connectError('transient', 'loopbackFailed', { extra: { uncertain: false } });
  }
}

/** The 128-bit deep-link nonce, minted by the flow itself (never the OAuth `state` or `code`). */
function returnNonce(random: RandomSource): string {
  return Buffer.from(random(16)).toString('hex');
}

/** Only Google's consent page over TLS reaches the browser: no other host, scheme, port or userinfo. */
export function checkConsentUrl(url: string): void {
  let parsed: URL | undefined;
  try {
    parsed = new URL(url);
  } catch {
    parsed = undefined;
  }
  const google = new URL(googleAuthUrl);
  const ok =
    parsed !== undefined &&
    parsed.protocol === 'https:' &&
    parsed.host === google.host &&
    parsed.username === '' &&
    parsed.password === '';
  if (!ok) throw connectError('permanent', 'badConsentUrl', { extra: { uncertain: false } });
}

/** Settles with `work`, or rejects as soon as `signal` aborts (a browser launch that never returns). */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortedError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortedError());
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

async function launch(deps: FlowDeps, url: string, signal: AbortSignal): Promise<void> {
  checkConsentUrl(url);
  try {
    await untilAborted(
      Promise.resolve().then(() => deps.openExternal(url)),
      signal,
    );
  } catch {
    if (signal.aborted) throw abortedError();
    throw connectError('transient', 'browserFailed', { extra: { uncertain: false } });
  }
}

function codeFrom(outcome: CallbackOutcome): string {
  if (outcome.kind === 'code') return outcome.code;
  if (outcome.kind === 'timeout') throw connectError('cancelled', 'timedOut');
  if (outcome.kind === 'aborted') throw abortedError();
  throw redirectError(outcome.error);
}

/** Never `response.json()`: a parse error message can quote the body, and the body holds the tokens. */
function parseBody(response: HttpResponse): Record<string, unknown> | undefined {
  try {
    const body: unknown = JSON.parse(response.text());
    return typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

interface Exchange {
  code: string;
  verifier: string;
  redirectUri: string;
}

function exchangeForm(client: FlowClient, exchange: Exchange): URLSearchParams {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code: exchange.code,
    client_id: client.clientId,
    redirect_uri: exchange.redirectUri,
    code_verifier: exchange.verifier,
  });
  if (client.clientSecret) form.set('client_secret', client.clientSecret);
  return form;
}

/** Token-module errors get the sign-in sentence; anything else (the governor's `PausedError`) passes unchanged. */
function asConnect(error: unknown): unknown {
  if (error instanceof ConnectError || !(error instanceof ProviderError)) return error;
  return asConnectError(error);
}

async function postExchange(
  deps: FlowDeps,
  request: FlowRequest,
  exchange: Exchange,
  signal: AbortSignal,
): Promise<HttpResponse> {
  try {
    return await deps.http.request(googleTokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: exchangeForm(request.client, exchange),
      // A redirect would carry the code, verifier and secret to another host.
      redirect: 'error',
      signal,
    });
  } catch (error) {
    throw asConnect(transportError(error));
  }
}

/** A token-endpoint call: no access token, never repeated by the governor (`write`). */
function oauthTicket(method: string, cost: number, signal: AbortSignal): GovernedRequest {
  return { budget: 'oauth', lane: 'interactive', kind: 'write', method, cost, auth: false, signal };
}

/**
 * A free governed no-op with the exchange's own ticket: a cooldown, daily stop or config block on the token endpoint
 * throws the governor's `PausedError` now, before the owner spends a consent and the single-use code on it.
 */
async function checkAdmission(ctx: FlowContext): Promise<void> {
  await ctx.governor.run(oauthTicket('oauth.token', 0, ctx.signal), async () => undefined);
}

/**
 * The code is single-use, so the exchange is a `write`: the governor never repeats it. A refusal is classified by
 * the token module's rules, with the code, verifier and secret scrubbed from Google's text.
 */
function exchangeCode(
  deps: FlowDeps,
  request: FlowRequest,
  exchange: Exchange,
  ctx: FlowContext,
): Promise<TokenExchange> {
  const secrets = [exchange.code, exchange.verifier, request.client.clientSecret ?? ''];
  return ctx.governor.run(oauthTicket('oauth.token', 1, ctx.signal), async io => {
    const response = await postExchange(deps, request, exchange, io.signal);
    if (!response.ok) throw asConnect(refusalError(response, secrets));
    const body = parseBody(response);
    if (!body) {
      throw connectError('transient', 'malformedTokenResponse', {
        method: 'oauth.token',
        extra: { status: response.status, uncertain: false },
      });
    }
    return { receivedAt: ctx.clock.now(), body };
  });
}

/** Consent in the browser, the one callback, then the code exchange; the listener is closed on every path. */
export async function runAuthorization(
  deps: FlowDeps,
  request: FlowRequest,
  ctx: FlowContext,
): Promise<TokenExchange> {
  throwIfAborted(ctx.signal);
  await checkAdmission(ctx);
  const random = deps.random ?? nodeRandom;
  const pkce = createPkce(random);
  const state = createState(random);
  const nonce = deps.returns && request.returnTo ? returnNonce(random) : undefined;
  const link =
    nonce &&
    deps.returns!.register({
      nonce,
      purpose: request.returnTo!,
      // A grace past the callback wait: a sign-in finished at the last second still gets a live fallback link.
      ttlMs: (deps.callbackTimeoutMs ?? callbackTimeoutMs) + returnGraceMs,
    })
      ? oauthReturnLink(nonce)
      : undefined;
  // Whether a page carrying the link was served: only then may the nonce outlive the flow. The
  // whole rest of the run sits inside the try so an `openLoopback` failure revokes too.
  let served = false;
  let loopback: Loopback | undefined;
  try {
    loopback = await openCallback(state, deps, ctx, link);
    const base = googleAuthUrl;
    const redirectUri = loopback.redirectUri;
    await launch(deps, consentUrl({ base, request, redirectUri, state, pkce }), ctx.signal);
    const outcome = await loopback.outcome;
    served = outcome.kind === 'code' || outcome.kind === 'error';
    const code = codeFrom(outcome);
    throwIfAborted(ctx.signal);
    return await exchangeCode(deps, request, { code, verifier: pkce.verifier, redirectUri }, ctx);
  } catch (error) {
    throw asConnect(error);
  } finally {
    loopback?.close();
    if (nonce && !served) deps.returns?.revoke(nonce);
  }
}

async function postRevoke(deps: FlowDeps, token: string, signal: AbortSignal): Promise<boolean> {
  try {
    const response = await deps.http.request(googleRevokeUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
      redirect: 'error',
      signal,
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Best effort: hands back a grant the connect refused as another Google user's (`connect.ts` decides which), so it
 * does not sit in that account or count against the refresh-token cap. `ctx.signal` ends it (`connect.ts` joins the
 * cancel and a short timeout), so a revoke never holds a refusal up. Never
 * throws and never logs; the governor sees a success either way, so a failed revoke changes no account state.
 */
export async function revokeGrant(deps: FlowDeps, ctx: FlowContext, token: string): Promise<void> {
  try {
    await ctx.governor.run(oauthTicket('oauth.revoke', 1, ctx.signal), io =>
      postRevoke(deps, token, io.signal),
    );
  } catch {
    /* refused before the call (a pause, a cancel): nothing to do */
  }
}
