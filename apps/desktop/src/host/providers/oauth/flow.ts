// Google's installed-app authorization-code flow with PKCE (plan 20 PV5): a loopback listener on 127.0.0.1, the
// consent URL handed to the host's `openExternal` (this module never starts a browser), and one governed code
// exchange. Abortable through the caller's signal. No code, verifier, token or secret reaches an error or a log.

import type { BoundGovernor, Clock, ConnectRequest } from '@aplos/engine/ports';
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
import { openLoopback, type CallbackOutcome, type Loopback } from './loopback';
import { createPkce, createState, nodeRandom, type Pkce, type RandomSource } from './pkce';
import { googleTokenUrl } from './token-source';
import { refusalError, transportError } from './token-errors';

export const googleAuthUrl = 'https://accounts.google.com/o/oauth2/v2/auth';

export interface FlowDeps {
  /** One request, no retries (`shared/http.ts`); called only inside `governor.run`. */
  http: HttpClient;
  /** Opens the consent URL in the owner's browser (Electron's `shell.openExternal`). */
  openExternal(url: string): Promise<void> | void;
  random?: RandomSource;
  authUrl?: string;
  tokenUrl?: string;
  /** Default 5 minutes. */
  callbackTimeoutMs?: number;
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

async function openCallback(state: string, deps: FlowDeps, ctx: FlowContext): Promise<Loopback> {
  try {
    return await openLoopback({
      state,
      clock: ctx.clock,
      signal: ctx.signal,
      timeoutMs: deps.callbackTimeoutMs,
    });
  } catch {
    throw connectError('transient', 'loopbackFailed', { extra: { uncertain: false } });
  }
}

async function launch(deps: FlowDeps, url: string): Promise<void> {
  try {
    await deps.openExternal(url);
  } catch {
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
    return await deps.http.request(deps.tokenUrl ?? googleTokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: exchangeForm(request.client, exchange),
      signal,
    });
  } catch (error) {
    throw asConnect(transportError(error));
  }
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
  const ticket = {
    budget: 'oauth',
    lane: 'interactive',
    kind: 'write',
    method: 'oauth.token',
    cost: 1,
    auth: false,
    signal: ctx.signal,
  } as const;
  return ctx.governor.run(ticket, async io => {
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
  const random = deps.random ?? nodeRandom;
  const pkce = createPkce(random);
  const state = createState(random);
  const loopback = await openCallback(state, deps, ctx);
  try {
    const base = deps.authUrl ?? googleAuthUrl;
    const redirectUri = loopback.redirectUri;
    await launch(deps, consentUrl({ base, request, redirectUri, state, pkce }));
    const code = codeFrom(await loopback.outcome);
    throwIfAborted(ctx.signal);
    return await exchangeCode(deps, request, { code, verifier: pkce.verifier, redirectUri }, ctx);
  } catch (error) {
    throw asConnect(error);
  } finally {
    loopback.close();
  }
}
