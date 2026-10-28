// Google access tokens over the vault (plan 20 PV5, D21). The governor calls `refresh` inside a governed `oauth`
// request and owns every retry; this module makes exactly one token-endpoint POST per refresh. No token, refresh
// token or client secret ever reaches an error, a log or a thrown object.

import type { ClassifiedError, ErrorClass } from '@aplos/contract';
import {
  ProviderError,
  type AccountId,
  type RequestIo,
  type TokenSource,
} from '@aplos/engine/ports';
import { HttpFailure, type HttpClient, type HttpResponse } from '../shared/http';
import { MAX_MESSAGE_LENGTH, parseGoogleError } from '../shared/google-error';
import { noGoogleClientMessage, type OAuthClient } from './client';
import { checkRequiredScopes } from './grant';
import { missingRequiredScopes, parseGrantedScopes } from './scopes';

export const googleTokenUrl = 'https://oauth2.googleapis.com/token';
/** `cached` stops handing out a token this long before it expires. */
export const tokenSkewMs = 60_000;

/** What the vault holds per account: the refresh token and the client it was granted to, as one bundle (D21). */
export interface GoogleTokenBundle {
  clientId: string;
  refreshToken: string;
}

/** The slice of the secret vault this needs; `main/vault.ts`'s `Vault<T>` fits. `set` replaces the whole value. */
export interface SecretVault<T> {
  get(ref: string): T | undefined | Promise<T | undefined>;
  set(ref: string, value: T): Promise<void>;
}

export interface GoogleTokenSourceOptions {
  vault: SecretVault<GoogleTokenBundle>;
  /** One request, no retries (`shared/http.ts`). */
  http: HttpClient;
  clock: { now(): number };
  /** The client this build signs in with now; its secret is sent only when its id is the bundle's. */
  client: () => OAuthClient;
  /** The vault reference of an account's bundle. Default: the account id. */
  refFor?: (account: AccountId) => string;
  tokenUrl?: string;
}

export interface AccessToken {
  token: string;
  expiresAt: number;
}

const method = 'oauth.token';

const userMessages: Partial<Record<ErrorClass, string>> = {
  auth: 'Google needs you to sign in to this account again. Choose Reconnect to keep syncing.',
  config: 'Google refused this build’s sign-in setup. Check the Google client id and secret.',
  permanent: 'Google refused to renew this account’s sign-in.',
  transient: 'Google sign-in could not be renewed just now. Aplos will try again.',
  cancelled: 'Google sign-in renewal was cancelled.',
};

const reasonMessages: Record<string, string> = {
  clientMismatch:
    'This account was connected with a different Google sign-in setup. Reconnect it to keep syncing.',
  noClient: noGoogleClientMessage,
  vaultWriteFailed:
    'Aplos could not save the renewed Google sign-in securely. Check the data directory and your keychain.',
};

/** A `ProviderError` whose `message` is a sentence the UI may show; `error.reason` stays the stable code. */
export class TokenRefreshError extends ProviderError {
  constructor(error: ClassifiedError, scope: 'account' | 'project', message: string) {
    super(error, scope);
    this.message = message;
  }
}

interface TokenErrorInit {
  extra?: Partial<ClassifiedError>;
  scope?: 'account' | 'project';
  /** Overrides the sentence picked from the reason and class. */
  message?: string;
}

function tokenError(cls: ErrorClass, reason: string, init: TokenErrorInit = {}): TokenRefreshError {
  const error: ClassifiedError = { class: cls, provider: 'oauth', method, reason, ...init.extra };
  const message = init.message ?? reasonMessages[reason] ?? userMessages[cls] ?? reason;
  return new TokenRefreshError(error, init.scope ?? 'account', message);
}

/** Refusals that only a new sign-in fixes (plan 20 section 3.3). */
const authReasons = new Set([
  'invalid_grant',
  'admin_policy_enforced',
  'interaction_required',
  'consent_required',
  'access_denied',
]);
/** Refusals of the client itself, which hit every account on the project. */
const configReasons = new Set([
  'invalid_client',
  'unauthorized_client',
  'invalid_request',
  'invalid_scope',
  'unsupported_grant_type',
]);

function refusalClass(status: number, reason: string): ErrorClass {
  if (authReasons.has(reason)) return 'auth';
  if (status === 408 || status === 429 || status >= 500) return 'transient';
  if (configReasons.has(reason)) return 'config';
  return 'permanent';
}

/** Replaces every secret sent with the request, in case a server echoes one back. */
function scrub(text: string, secrets: readonly string[]): string {
  let clean = text;
  for (const secret of secrets) if (secret) clean = clean.split(secret).join('[redacted]');
  return clean.slice(0, MAX_MESSAGE_LENGTH);
}

function refusal(response: HttpResponse, secrets: readonly string[]): TokenRefreshError {
  const info = parseGoogleError(response.status, response.text());
  const cls = refusalClass(response.status, info.reason);
  const description = scrub(info.oauthDescription ?? info.message, secrets);
  const extra: Partial<ClassifiedError> = {
    status: response.status,
    ...(response.retryAfterMs !== undefined ? { retryAfterMs: response.retryAfterMs } : {}),
    ...(description ? { providerMessage: description } : {}),
  };
  const scope = cls === 'config' ? 'project' : 'account';
  return tokenError(cls, scrub(info.reason, secrets), { extra, scope });
}

/** Only the failure's kind survives: a `cause` is not ours to vouch for, so nothing else is passed on. */
function transportError(error: unknown): TokenRefreshError {
  const extra = { uncertain: false };
  if (!(error instanceof HttpFailure)) return tokenError('transient', 'requestFailed', { extra });
  if (error.kind === 'aborted') return tokenError('cancelled', 'aborted', { extra });
  return tokenError('transient', error.kind, { extra });
}

interface TokenReply {
  accessToken: string;
  expiresInMs: number;
  refreshToken?: string;
  scope?: string;
}

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value !== '';

/** Never `response.json()`: a parse error message can quote the body, and the body holds the token. */
function parseReply(response: HttpResponse): TokenReply | undefined {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(response.text()) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const seconds = Number(body?.expires_in);
  if (!nonEmpty(body?.access_token) || !Number.isFinite(seconds) || seconds <= 0) return undefined;
  return {
    accessToken: body.access_token,
    expiresInMs: seconds * 1000,
    refreshToken: nonEmpty(body.refresh_token) ? body.refresh_token : undefined,
    scope: typeof body.scope === 'string' ? body.scope : undefined,
  };
}

/** A refresh grant that lost the mail scope is a `permission` refusal; no `scope` field means no news. */
function checkReplyScopes(reply: TokenReply): void {
  if (reply.scope === undefined) return;
  const granted = parseGrantedScopes(reply.scope);
  const check = checkRequiredScopes(granted);
  if (check.ok) return;
  const missingScopes = missingRequiredScopes(granted).map(entry => entry.scope);
  throw tokenError('permission', check.reason, {
    extra: { missingScopes },
    message: check.message,
  });
}

function validBundle(value: GoogleTokenBundle | undefined): GoogleTokenBundle | undefined {
  if (!value || !nonEmpty(value.refreshToken) || !nonEmpty(value.clientId)) return undefined;
  return value;
}

/** The bundle to refresh with, and the refresh token the vault itself holds (they differ after a failed write). */
interface Current {
  bundle: GoogleTokenBundle;
  stored: string;
}

export class GoogleTokenSource implements TokenSource {
  private readonly cache = new Map<AccountId, AccessToken>();
  private readonly inFlight = new Map<AccountId, Promise<AccessToken>>();
  /** A rotated bundle the vault refused, used while the vault still holds `over` (so a reconnect wins). */
  private readonly unsaved = new Map<AccountId, { bundle: GoogleTokenBundle; over: string }>();

  constructor(private readonly options: GoogleTokenSourceOptions) {}

  cached(account: AccountId): AccessToken | undefined {
    const hit = this.cache.get(account);
    if (!hit || hit.expiresAt - tokenSkewMs <= this.options.clock.now()) return undefined;
    return { ...hit };
  }

  /** Concurrent calls for one account share one request; the first caller's `io` carries it. */
  refresh(account: AccountId, io: RequestIo): Promise<AccessToken> {
    const pending = this.inFlight.get(account);
    if (pending) return pending;
    const started = this.run(account, io).finally(() => {
      if (this.inFlight.get(account) === started) this.inFlight.delete(account);
    });
    this.inFlight.set(account, started);
    return started;
  }

  /** Drops what this process remembers for an account (disconnect). The vault is the caller's. */
  forget(account: AccountId): void {
    this.cache.delete(account);
    this.unsaved.delete(account);
  }

  private async run(account: AccountId, io: RequestIo): Promise<AccessToken> {
    try {
      return await this.refreshOnce(account, io);
    } catch (error) {
      if (error instanceof ProviderError && error.error.class === 'auth')
        this.cache.delete(account);
      throw error;
    }
  }

  private async refreshOnce(account: AccountId, io: RequestIo): Promise<AccessToken> {
    const current = await this.current(account);
    if (!current) throw tokenError('auth', 'noCredential');
    const secret = this.secretFor(current.bundle);
    const startedAt = this.options.clock.now();
    const response = await this.post(current.bundle, secret, io);
    const secrets = [current.bundle.refreshToken, secret ?? ''];
    if (!response.ok) throw refusal(response, secrets);
    const reply = parseReply(response);
    if (!reply) {
      throw tokenError('transient', 'malformedTokenResponse', {
        extra: { status: response.status },
      });
    }
    // A rotated refresh token is stored before anything else can refuse the reply.
    await this.keep(account, current, reply);
    checkReplyScopes(reply);
    const token = { token: reply.accessToken, expiresAt: startedAt + reply.expiresInMs };
    this.cache.set(account, token);
    return { ...token };
  }

  private ref(account: AccountId): string {
    return this.options.refFor ? this.options.refFor(account) : account;
  }

  private async current(account: AccountId): Promise<Current | undefined> {
    const stored = validBundle(await this.options.vault.get(this.ref(account)));
    const pending = this.unsaved.get(account);
    if (pending && stored?.refreshToken === pending.over) {
      return { bundle: pending.bundle, stored: stored.refreshToken };
    }
    this.unsaved.delete(account);
    return stored && { bundle: stored, stored: stored.refreshToken };
  }

  /** D21: the refresh token only works with the client it was granted to; any other client is refused unsent. */
  private secretFor(bundle: GoogleTokenBundle): string | undefined {
    const client = this.options.client();
    const id = client.clientId?.trim();
    if (!id) throw tokenError('config', 'noClient', { scope: 'project' });
    if (id !== bundle.clientId) throw tokenError('auth', 'clientMismatch');
    return client.clientSecret || undefined;
  }

  private async post(
    bundle: GoogleTokenBundle,
    secret: string | undefined,
    io: RequestIo,
  ): Promise<HttpResponse> {
    const form = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: bundle.refreshToken,
      client_id: bundle.clientId,
    });
    if (secret) form.set('client_secret', secret);
    try {
      return await this.options.http.request(this.options.tokenUrl ?? googleTokenUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: form,
        signal: io.signal,
      });
    } catch (error) {
      throw transportError(error);
    }
  }

  /**
   * Stores a rotated refresh token as one bundle write before the new access token is used. A bundle replaced while
   * the request was out (a reconnect) wins. A refused write leaves the vault's old bundle in place and keeps the new
   * one in memory for the next try.
   */
  private async keep(account: AccountId, used: Current, reply: TokenReply): Promise<void> {
    const now = await this.current(account);
    if (!now || now.bundle.refreshToken !== used.bundle.refreshToken) {
      throw tokenError('transient', 'grantChanged', { extra: { uncertain: false } });
    }
    const next = { ...now.bundle, refreshToken: reply.refreshToken ?? now.bundle.refreshToken };
    if (next.refreshToken === now.stored) return;
    try {
      await this.options.vault.set(this.ref(account), next);
    } catch {
      this.unsaved.set(account, { bundle: next, over: now.stored });
      throw tokenError('transient', 'vaultWriteFailed', { extra: { uncertain: false } });
    }
    this.unsaved.delete(account);
  }
}
