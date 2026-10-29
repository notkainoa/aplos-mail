// The Google adapter's `connect` (plan 20 PV5, D21, D25): sign-in through `flow.ts`, then every check that can
// refuse the grant (a refresh token, the id_token, the same account on a reconnect, the mail scope) BEFORE the token
// bundle is written to the vault. A refused, failed or cancelled connect stores nothing and leaves an old bundle in
// place. A refused grant is revoked (best effort) only when it provably belongs to another Google user than the
// account being reconnected; otherwise its unused refresh token is just dropped (it was never stored).
//
// TODO(live): whether Google's revoke ends one token or the whole grant for the user and client needs a live probe.
// Until then a grant that may be the same user's (any new connect, a same-subject reconnect) is never revoked: if the
// revoke ends the whole grant, it would also kill a credential Aplos holds for that user.
//
// Refs: the bundle goes under `refFor(accountId)`, the one ref `GoogleTokenSource` reads, not a fresh ref per attempt.
// The engine keeps no credential ref and tells the factory nothing when it commits a reconnect, so a bundle under a
// fresh ref could never be found again. Instead nothing is written until every check here has passed, and a cancel
// that lands during the write takes it back out (the previous bundle restored, or the new entry deleted).

import { ProviderError } from '@aplos/engine/ports';
import type {
  AccountId,
  Capabilities,
  ConnectContext,
  ConnectRequest,
  ConnectResult,
} from '@aplos/engine/ports';
import type { ResolvedGoogleClient } from './client';
import { abortedError, connectError, type ConnectError } from './connect-errors';
import {
  authParamsFor,
  revokeGrant,
  runAuthorization,
  type FlowClient,
  type FlowContext,
  type FlowDeps,
  type TokenExchange,
} from './flow';
import {
  checkExpectedAddress,
  checkReconnectIdentity,
  checkRequiredScopes,
  grantFromTokenResponse,
  type Grant,
} from './grant';
import { identityFromIdToken, subjectClaim, type GoogleIdentity } from './id-token';
import {
  connectScopes,
  googleScopeManifest,
  grantedFeatures,
  missingRequiredScopes,
} from './scopes';
import type { CredentialVault, GoogleTokenBundle } from './token-source';

export type GoogleConnect = (req: ConnectRequest, ctx: ConnectContext) => Promise<ConnectResult>;

export interface GoogleConnectDeps extends FlowDeps {
  /** `resolveGoogleClient` over the environment, Settings and the bundled client, read at each connect. */
  resolveClient(): ResolvedGoogleClient;
  /** The same vault and bundle shape `GoogleTokenSource` reads, plus `delete` to take a cancelled write back. */
  vault: CredentialVault<GoogleTokenBundle>;
  /** The vault reference of an account's bundle. Default: the account id (as `GoogleTokenSource`). */
  refFor?: (account: AccountId) => string;
  /**
   * Optional manifest scopes to ask for besides the required ones. Default: none for a new connect, every optional
   * scope for `grantPermissions`.
   */
  optionalScopes?: (req: ConnectRequest) => readonly string[];
  /**
   * The scopes the account's stored grant holds. Installed apps have no incremental auth, so a reconnect or re-grant
   * asks for these optional scopes again, or the new grant would silently drop them.
   */
  grantedScopes?: (account: AccountId) => readonly string[] | undefined;
  /** Capabilities for a grant. Default: `googleCapabilities`. */
  capabilities?: (grantedScopes: readonly string[]) => Capabilities;
}

/**
 * What the Gmail adapter can do today, as prov-gmail's own rig declares it (tests/prov-gmail/harness.ts); the adapter
 * itself declares none yet. Filters also need their granted scope; calendar stays off until the adapter has a
 * calendar half (prov-cal).
 */
export function googleCapabilities(grantedScopes: readonly string[]): Capabilities {
  const features = grantedFeatures(grantedScopes);
  return {
    labels: true,
    folders: false,
    drafts: true,
    serverSearch: true,
    calendar: false,
    filters: features.has('filters'),
    push: false,
    sendAs: true,
    unsubscribeHeaders: true,
    threading: 'native',
  };
}

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value !== '';

function clientFor(resolved: ResolvedGoogleClient): FlowClient {
  const clientId = resolved.clientId?.trim();
  if (!clientId) throw connectError('config', 'noClient', { scope: 'project' });
  return resolved.clientSecret ? { clientId, clientSecret: resolved.clientSecret } : { clientId };
}

/** A reconnect or re-grant replaces an existing account's bundle, so it must know whose account that is. */
function requireExpectedAccount(req: ConnectRequest): void {
  if (req.mode === 'new' || nonEmpty(req.expectedSubject) || nonEmpty(req.address?.trim())) return;
  throw connectError('permanent', 'noExpectedSubject', {
    message:
      'Aplos could not tell which account to reconnect. Try again from the account’s settings.',
  });
}

function refreshTokenFrom(body: Record<string, unknown>): string {
  if (nonEmpty(body.refresh_token)) return body.refresh_token;
  throw connectError('auth', 'noRefreshToken', {
    method: 'oauth.token',
    extra: { uncertain: false },
  });
}

/** What revokes the grant: the refresh token, else the access token (Google revokes its refresh token with it). */
function grantTokenOf(body: Record<string, unknown>): string | undefined {
  if (nonEmpty(body.refresh_token)) return body.refresh_token;
  return nonEmpty(body.access_token) ? body.access_token : undefined;
}

const optionalManifestScopes = googleScopeManifest.filter(e => !e.required).map(e => e.scope);

/** New: the caller's optional scopes. Reconnect: those plus the ones held before. Re-grant: every optional scope. */
function scopesFor(deps: GoogleConnectDeps, req: ConnectRequest, account: AccountId): string[] {
  const asked = deps.optionalScopes?.(req);
  if (req.mode === 'new') return connectScopes(asked ?? []);
  const held = new Set(deps.grantedScopes?.(account) ?? []);
  const kept = optionalManifestScopes.filter(scope => held.has(scope));
  const wanted = asked ?? (req.mode === 'grantPermissions' ? optionalManifestScopes : []);
  return connectScopes([...new Set([...kept, ...wanted])]);
}

const newConnectMessage =
  'That is not the Google account Aplos asked for. Sign in with that account, or start again.';

/**
 * The account the request names: its `sub` when it carries one (any mode), else its address against the id_token's
 * verified email. The engine sends only the address for an account saved before subjects were kept, and on a retried
 * new connect that reuses a waiting row, so a new connect that names an address is held to it too.
 */
function identityRefusal(req: ConnectRequest, identity: GoogleIdentity): ConnectError | undefined {
  const check = nonEmpty(req.expectedSubject)
    ? checkReconnectIdentity(req.expectedSubject, identity.subject)
    : checkExpectedAddress(req.address, identity.address);
  if (check.ok) return undefined;
  const message = req.mode === 'new' ? newConnectMessage : check.message;
  return connectError(check.kind, check.reason, { message });
}

function scopeRefusal(granted: readonly string[]): ConnectError | undefined {
  const check = checkRequiredScopes(granted);
  if (check.ok) return undefined;
  const missingScopes = missingRequiredScopes(granted).map(entry => entry.scope);
  return connectError(check.kind, check.reason, {
    method: 'oauth.token',
    extra: { missingScopes },
    message: check.message,
  });
}

/** One connect attempt: the request, the flow's context (with the request's own signal joined in) and the client. */
interface Attempt {
  req: ConnectRequest;
  flow: FlowContext;
  ref: string;
  client: FlowClient;
  testingMode: boolean;
}

/** `ConnectRequest.signal` ends the attempt too (`Account/cancelConnect`), even when the context's does not follow it. */
function attemptSignal(req: ConnectRequest, ctx: ConnectContext): AbortSignal {
  return req.signal ? AbortSignal.any([ctx.signal, req.signal]) : ctx.signal;
}

function startAttempt(deps: GoogleConnectDeps, req: ConnectRequest, ctx: ConnectContext): Attempt {
  const resolved = deps.resolveClient();
  const flow = { governor: ctx.governor, clock: ctx.clock, signal: attemptSignal(req, ctx) };
  return {
    req,
    flow,
    ref: deps.refFor ? deps.refFor(ctx.accountId) : ctx.accountId,
    client: clientFor(resolved),
    testingMode: resolved.testingMode,
  };
}

interface Accepted {
  identity: GoogleIdentity;
  grant: Grant;
  bundle: GoogleTokenBundle;
}

/** Every check on the token response; throws the first refusal. Nothing is stored or revoked here. */
function acceptExchange(attempt: Attempt, exchange: TokenExchange): Accepted {
  const { body, receivedAt } = exchange;
  const clientId = attempt.client.clientId;
  const refreshToken = refreshTokenFrom(body);
  const identity = identityFromIdToken(body.id_token, { clientId, now: receivedAt });
  const grant = grantFromTokenResponse({
    now: receivedAt,
    testingMode: attempt.testingMode,
    response: body,
    clientId,
  });
  const refused = identityRefusal(attempt.req, identity) ?? scopeRefusal(grant.scopes);
  if (refused) throw refused;
  return { identity, grant, bundle: { clientId, refreshToken } };
}

async function write(
  vault: CredentialVault<GoogleTokenBundle>,
  ref: string,
  bundle: GoogleTokenBundle,
) {
  try {
    await vault.set(ref, bundle);
  } catch {
    throw connectError('transient', 'vaultWriteFailed', { extra: { uncertain: false } });
  }
}

/** Takes a cancelled write back out: the previous bundle again, or no entry. Best effort. */
async function undo(
  vault: CredentialVault<GoogleTokenBundle>,
  ref: string,
  bundle: GoogleTokenBundle,
  previous: GoogleTokenBundle | undefined,
): Promise<void> {
  try {
    if (vault.get(ref)?.refreshToken !== bundle.refreshToken) return;
    if (previous) await vault.set(ref, previous);
    else await vault.delete(ref);
  } catch {
    /* the grant is the account's own (it passed every check), so a bundle left behind still works */
  }
}

/** What a cancel would put back. Unreadable: nothing is written, since a cancel could not be undone. */
function readPrevious(
  vault: CredentialVault<GoogleTokenBundle>,
  ref: string,
): GoogleTokenBundle | undefined {
  try {
    return vault.get(ref);
  } catch {
    throw connectError('transient', 'vaultReadFailed', { extra: { uncertain: false } });
  }
}

/** A cancel before the write stores nothing; one that lands during it takes the write back out. */
async function store(
  deps: GoogleConnectDeps,
  attempt: Attempt,
  bundle: GoogleTokenBundle,
): Promise<void> {
  const { signal } = attempt.flow;
  if (signal.aborted) throw abortedError();
  const previous = readPrevious(deps.vault, attempt.ref);
  await write(deps.vault, attempt.ref, bundle);
  if (!signal.aborted) return;
  await undo(deps.vault, attempt.ref, bundle, previous);
  throw abortedError();
}

/**
 * Provably another Google user than the account being reconnected: refused as `wrongAccount`, or an id_token
 * refused for another reason whose `sub` (decoded, unchecked) is not the expected one. Never for a new connect: its
 * user may already be an account in Aplos (the engine refuses the duplicate after sign-in).
 */
function foreignGrant(attempt: Attempt, body: Record<string, unknown>, error: unknown): boolean {
  if (attempt.req.mode === 'new') return false;
  if (error instanceof ProviderError && error.error.reason === 'wrongAccount') return true;
  const expected = attempt.req.expectedSubject;
  const subject = subjectClaim(body.id_token);
  return nonEmpty(expected) && subject !== undefined && subject !== expected;
}

/** On its own signal: a cancel must not stop the revoke of a grant it refused. */
async function revokeIfForeign(
  deps: GoogleConnectDeps,
  attempt: Attempt,
  exchange: TokenExchange,
  error: unknown,
): Promise<void> {
  const token = grantTokenOf(exchange.body);
  if (!token || !foreignGrant(attempt, exchange.body, error)) return;
  const ctx = { ...attempt.flow, signal: new AbortController().signal };
  await revokeGrant(deps, ctx, token);
}

function resultFor(deps: GoogleConnectDeps, attempt: Attempt, accepted: Accepted): ConnectResult {
  const { grant } = accepted;
  return {
    identity: accepted.identity,
    grantedScopes: grant.scopes,
    capabilities: (deps.capabilities ?? googleCapabilities)(grant.scopes),
    grant: {
      grantedAt: grant.grantedAt,
      ...(grant.refreshExpiresAt !== undefined ? { refreshExpiresAt: grant.refreshExpiresAt } : {}),
      client: attempt.client.clientId,
    },
    credentialRef: attempt.ref,
  };
}

/** After the code exchange: accept and store, or drop the grant (revoking it only when foreign) and rethrow. */
async function finishConnect(
  deps: GoogleConnectDeps,
  attempt: Attempt,
  exchange: TokenExchange,
): Promise<ConnectResult> {
  try {
    const accepted = acceptExchange(attempt, exchange);
    await store(deps, attempt, accepted.bundle);
    return resultFor(deps, attempt, accepted);
  } catch (error) {
    await revokeIfForeign(deps, attempt, exchange, error);
    throw error;
  }
}

export function createGoogleConnect(deps: GoogleConnectDeps): GoogleConnect {
  return async (req, ctx) => {
    requireExpectedAccount(req);
    const attempt = startAttempt(deps, req, ctx);
    const scopes = scopesFor(deps, req, ctx.accountId);
    const request = { client: attempt.client, scopes, params: authParamsFor(req) };
    const exchange = await runAuthorization(deps, request, attempt.flow);
    return finishConnect(deps, attempt, exchange);
  };
}
