// Google access tokens over the vault (plan 20 PV5, D21). The governor calls `refresh` inside a governed `oauth`
// request and owns every retry; this module makes exactly one token-endpoint POST per refresh. No token, refresh
// token or client secret ever reaches an error, a log or a thrown object.

import { createHash } from 'node:crypto';
import type { AccountId, RequestIo, TokenSource } from '@aplos/engine/ports';
import type { HttpClient, HttpResponse } from '../shared/http';
import type { OAuthClient } from './client';
import { checkRequiredScopes } from './grant';
import { missingRequiredScopes, parseGrantedScopes } from './scopes';
import {
  cancelledError,
  grantChangedError,
  refusalError,
  tokenError,
  transportError,
} from './token-errors';

export { TokenRefreshError } from './token-errors';

export const googleTokenUrl = 'https://oauth2.googleapis.com/token';
/** `cached` stops handing out a token this long before it expires. */
export const tokenSkewMs = 60_000;

/** What the vault holds per account: the refresh token and the client it was granted to, as one bundle (D21). */
export interface GoogleTokenBundle {
  clientId: string;
  refreshToken: string;
}

/**
 * The slice of the secret vault this needs; `main/vault.ts`'s `Vault<T>` fits. `get` is synchronous and does no I/O
 * (that vault keeps decrypted entries in memory), so `cached` can see a grant a reconnect replaced. `set` replaces
 * the whole value.
 */
export interface SecretVault<T> {
  get(ref: string): T | undefined;
  set(ref: string, value: T): Promise<void>;
}

/** What connect needs besides: taking a write back out (a cancel during it, the engine refusing the result). */
export interface CredentialVault<T> extends SecretVault<T> {
  /** A ref that is not stored is not an error. */
  delete(ref: string): Promise<void>;
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
}

export interface AccessToken {
  /** Not enumerable: a spread, `JSON.stringify` or `util.inspect` of the object never shows it. */
  readonly token: string;
  expiresAt: number;
}

export function accessToken(token: string, expiresAt: number): AccessToken {
  const value = { expiresAt } as AccessToken;
  Object.defineProperty(value, 'token', { value: token, enumerable: false });
  return value;
}

/** `grant` fingerprints the bundle the token came from; the refresh token itself is never kept here. */
interface CachedToken {
  token: string;
  expiresAt: number;
  grant: string;
}

/** One shared token request; it is aborted only when every caller waiting on it has given up. */
interface Flight {
  promise: Promise<AccessToken>;
  controller: AbortController;
  waiters: number;
}

/** The bundle to refresh with, and the refresh token the vault itself holds (they differ after a failed write). */
interface Current {
  bundle: GoogleTokenBundle;
  stored: string;
}

interface TokenReply {
  accessToken: string;
  expiresInMs: number;
  refreshToken?: string;
  scope?: string;
}

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value !== '';

function grantId(bundle: GoogleTokenBundle): string {
  return createHash('sha256')
    .update(`${bundle.clientId}\n${bundle.refreshToken}`)
    .digest('base64url');
}

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

export class GoogleTokenSource implements TokenSource {
  // True private fields: tokens never show in `util.inspect`, `console.log` or `JSON.stringify` of the source.
  readonly #cache = new Map<AccountId, CachedToken>();
  readonly #inFlight = new Map<AccountId, Flight>();
  /** A rotated bundle the vault refused, used while the vault still holds `over` (so a reconnect wins). */
  readonly #unsaved = new Map<AccountId, { bundle: GoogleTokenBundle; over: string }>();

  readonly #options: GoogleTokenSourceOptions;

  /** The endpoint is always Google's (`googleTokenUrl`): no option, setting or variable may send the secrets elsewhere. */
  constructor(options: GoogleTokenSourceOptions) {
    this.#options = options;
  }

  /** Only a token from the grant the vault holds now, and not within the skew of its expiry. */
  cached(account: AccountId): AccessToken | undefined {
    const hit = this.#cache.get(account);
    if (!hit || hit.expiresAt - tokenSkewMs <= this.#options.clock.now()) return undefined;
    if (!this.holdsGrant(account, hit.grant)) {
      this.#cache.delete(account);
      return undefined;
    }
    return accessToken(hit.token, hit.expiresAt);
  }

  /** Concurrent calls for one account share one request; each caller's own signal ends only its own wait. */
  refresh(account: AccountId, io: RequestIo): Promise<AccessToken> {
    if (io.signal.aborted) return Promise.reject(cancelledError());
    const flight = this.#inFlight.get(account) ?? this.launch(account);
    return this.join(account, flight, io.signal);
  }

  /** Drops what this process remembers for an account (disconnect). The vault is the caller's. */
  forget(account: AccountId): void {
    this.#cache.delete(account);
    this.#unsaved.delete(account);
  }

  private launch(account: AccountId): Flight {
    const controller = new AbortController();
    const flight: Flight = {
      controller,
      waiters: 0,
      promise: this.run(account, controller.signal),
    };
    flight.promise = flight.promise.finally(() => this.land(account, flight));
    flight.promise.catch(() => {
      /* every caller gets the outcome through `join`; none may be left */
    });
    this.#inFlight.set(account, flight);
    return flight;
  }

  private land(account: AccountId, flight: Flight): void {
    if (this.#inFlight.get(account) === flight) this.#inFlight.delete(account);
  }

  private join(account: AccountId, flight: Flight, signal: AbortSignal): Promise<AccessToken> {
    flight.waiters += 1;
    return new Promise<AccessToken>((resolve, reject) => {
      let left = false;
      const leave = () => {
        if (left) return;
        left = true;
        signal.removeEventListener('abort', onAbort);
        flight.waiters -= 1;
      };
      const onAbort = () => {
        leave();
        if (flight.waiters === 0) this.abandon(account, flight);
        reject(cancelledError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      flight.promise.then(
        token => {
          leave();
          resolve(accessToken(token.token, token.expiresAt));
        },
        (error: unknown) => {
          leave();
          reject(error);
        },
      );
    });
  }

  /** Nobody waits any more: the request is cut, and the next caller starts a fresh one. */
  private abandon(account: AccountId, flight: Flight): void {
    this.land(account, flight);
    flight.controller.abort();
  }

  /** Any failure drops the cached token: the governor refreshes only when that token was due or refused. */
  private async run(account: AccountId, signal: AbortSignal): Promise<AccessToken> {
    try {
      return await this.refreshOnce(account, signal);
    } catch (error) {
      this.#cache.delete(account);
      throw error;
    }
  }

  private async refreshOnce(account: AccountId, signal: AbortSignal): Promise<AccessToken> {
    const used = this.readCurrent(account);
    if (!used) throw tokenError('auth', 'noCredential');
    const secret = this.secretFor(used.bundle);
    const startedAt = this.#options.clock.now();
    const response = await this.post(used.bundle, secret, signal);
    if (!response.ok) throw refusalError(response, [used.bundle.refreshToken, secret ?? '']);
    const reply = parseReply(response);
    if (!reply) {
      throw tokenError('transient', 'malformedTokenResponse', {
        extra: { status: response.status },
      });
    }
    // A rotated refresh token is stored before anything else can refuse the reply.
    const bundle = await this.keep(account, used, reply);
    checkReplyScopes(reply);
    // Checked and cached in one synchronous step, so a reconnect cannot slip in between.
    this.assertGrant(account, bundle);
    const expiresAt = startedAt + reply.expiresInMs;
    this.#cache.set(account, { token: reply.accessToken, expiresAt, grant: grantId(bundle) });
    return accessToken(reply.accessToken, expiresAt);
  }

  private ref(account: AccountId): string {
    return this.#options.refFor ? this.#options.refFor(account) : account;
  }

  private current(account: AccountId): Current | undefined {
    const stored = validBundle(this.#options.vault.get(this.ref(account)));
    const pending = this.#unsaved.get(account);
    if (pending && stored?.refreshToken === pending.over) {
      return { bundle: pending.bundle, stored: stored.refreshToken };
    }
    this.#unsaved.delete(account);
    return stored && { bundle: stored, stored: stored.refreshToken };
  }

  /** `current`, with a vault that throws turned into a secret-free `transient` error. */
  private readCurrent(account: AccountId): Current | undefined {
    try {
      return this.current(account);
    } catch {
      throw tokenError('transient', 'vaultReadFailed', { extra: { uncertain: false } });
    }
  }

  private holdsGrant(account: AccountId, grant: string): boolean {
    try {
      const now = this.current(account);
      return now !== undefined && grantId(now.bundle) === grant;
    } catch {
      return false;
    }
  }

  private assertGrant(account: AccountId, bundle: GoogleTokenBundle): void {
    if (!this.holdsGrant(account, grantId(bundle))) throw grantChangedError();
  }

  /** D21: the refresh token only works with the client it was granted to; any other client is refused unsent. */
  private secretFor(bundle: GoogleTokenBundle): string | undefined {
    const client = this.#options.client();
    const id = client.clientId?.trim();
    if (!id) throw tokenError('config', 'noClient', { scope: 'project' });
    if (id !== bundle.clientId) throw tokenError('auth', 'clientMismatch');
    return client.clientSecret || undefined;
  }

  private async post(
    bundle: GoogleTokenBundle,
    secret: string | undefined,
    signal: AbortSignal,
  ): Promise<HttpResponse> {
    const form = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: bundle.refreshToken,
      client_id: bundle.clientId,
    });
    if (secret) form.set('client_secret', secret);
    try {
      return await this.#options.http.request(googleTokenUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: form,
        // A redirect would carry the refresh token and secret to another host.
        redirect: 'error',
        signal,
      });
    } catch (error) {
      throw transportError(error);
    }
  }

  /**
   * Stores a rotated refresh token as one bundle write before the new access token is used, and returns the bundle
   * now in force. A bundle replaced while the request was out (a reconnect) wins: nothing is written over it.
   */
  private async keep(
    account: AccountId,
    used: Current,
    reply: TokenReply,
  ): Promise<GoogleTokenBundle> {
    const now = this.readCurrent(account);
    if (!now || grantId(now.bundle) !== grantId(used.bundle)) throw grantChangedError();
    const next = { ...now.bundle, refreshToken: reply.refreshToken ?? now.bundle.refreshToken };
    if (next.refreshToken === now.stored) return now.bundle;
    // Compared and written in one synchronous step; `assertGrant` afterwards catches a write that raced this one.
    await this.write(account, next, now.stored);
    return next;
  }

  /** A refused write leaves the vault's bundle in place and keeps the new one in memory for the next try. */
  private async write(account: AccountId, next: GoogleTokenBundle, over: string): Promise<void> {
    try {
      await this.#options.vault.set(this.ref(account), next);
    } catch {
      if (this.storedToken(account) === over) this.#unsaved.set(account, { bundle: next, over });
      throw tokenError('transient', 'vaultWriteFailed', { extra: { uncertain: false } });
    }
    this.#unsaved.delete(account);
  }

  private storedToken(account: AccountId): string | undefined {
    try {
      return validBundle(this.#options.vault.get(this.ref(account)))?.refreshToken;
    } catch {
      return undefined;
    }
  }
}
