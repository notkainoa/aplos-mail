// The Google adapter's `connect` (plan 20 PV5, D21, D25): sign-in through `flow.ts`, then every check that can
// refuse the grant (a refresh token, the id_token, the same account on a reconnect, the mail scope) BEFORE the token
// bundle is written to the vault. A refused or failed connect stores nothing and leaves an old bundle in place.

import type {
  AccountId,
  Capabilities,
  ConnectContext,
  ConnectRequest,
  ConnectResult,
} from '@aplos/engine/ports';
import type { ResolvedGoogleClient } from './client';
import { connectError } from './connect-errors';
import { runAuthorization, authParamsFor, type FlowClient, type FlowDeps } from './flow';
import { checkReconnectIdentity, checkRequiredScopes, grantFromTokenResponse } from './grant';
import { identityFromIdToken, type GoogleIdentity } from './id-token';
import { connectScopes, grantedFeatures, missingRequiredScopes } from './scopes';
import type { GoogleTokenBundle, SecretVault } from './token-source';

export type GoogleConnect = (req: ConnectRequest, ctx: ConnectContext) => Promise<ConnectResult>;

export interface GoogleConnectDeps extends FlowDeps {
  /** `resolveGoogleClient` over the environment, Settings and the bundled client, read at each connect. */
  resolveClient(): ResolvedGoogleClient;
  /** The same vault and bundle shape `GoogleTokenSource` reads. */
  vault: SecretVault<GoogleTokenBundle>;
  /** The vault reference of an account's bundle. Default: the account id (as `GoogleTokenSource`). */
  refFor?: (account: AccountId) => string;
  /** Optional manifest scopes to ask for besides the required ones. Default: none. */
  optionalScopes?: (req: ConnectRequest) => readonly string[];
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
function requireExpectedSubject(req: ConnectRequest): void {
  if (req.mode === 'new' || nonEmpty(req.expectedSubject)) return;
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

function checkIdentity(req: ConnectRequest, identity: GoogleIdentity): void {
  const check = checkReconnectIdentity(req.expectedSubject, identity.subject);
  if (check.ok) return;
  throw connectError(check.kind, check.reason, { message: check.message });
}

function checkScopes(granted: readonly string[]): void {
  const check = checkRequiredScopes(granted);
  if (check.ok) return;
  const missingScopes = missingRequiredScopes(granted).map(entry => entry.scope);
  throw connectError(check.kind, check.reason, {
    method: 'oauth.token',
    extra: { missingScopes },
    message: check.message,
  });
}

async function store(
  deps: GoogleConnectDeps,
  ref: string,
  bundle: GoogleTokenBundle,
  signal: AbortSignal,
): Promise<void> {
  // A cancel that lands after the exchange still stores nothing.
  if (signal.aborted) throw connectError('cancelled', 'aborted', { extra: { uncertain: false } });
  try {
    await deps.vault.set(ref, bundle);
  } catch {
    throw connectError('transient', 'vaultWriteFailed', { extra: { uncertain: false } });
  }
}

export function createGoogleConnect(deps: GoogleConnectDeps): GoogleConnect {
  return async (req, ctx) => {
    requireExpectedSubject(req);
    const resolved = deps.resolveClient();
    const client = clientFor(resolved);
    const scopes = connectScopes(deps.optionalScopes?.(req) ?? []);
    const params = authParamsFor(req);
    const { body, receivedAt } = await runAuthorization(deps, { client, scopes, params }, ctx);
    const refreshToken = refreshTokenFrom(body);
    const identity = identityFromIdToken(body.id_token, {
      clientId: client.clientId,
      now: receivedAt,
    });
    checkIdentity(req, identity);
    const grant = grantFromTokenResponse({
      now: receivedAt,
      testingMode: resolved.testingMode,
      response: body,
      clientId: client.clientId,
    });
    checkScopes(grant.scopes);
    const credentialRef = deps.refFor ? deps.refFor(ctx.accountId) : ctx.accountId;
    await store(deps, credentialRef, { clientId: client.clientId, refreshToken }, ctx.signal);
    return {
      identity,
      grantedScopes: grant.scopes,
      capabilities: (deps.capabilities ?? googleCapabilities)(grant.scopes),
      grant: {
        grantedAt: grant.grantedAt,
        ...(grant.refreshExpiresAt !== undefined
          ? { refreshExpiresAt: grant.refreshExpiresAt }
          : {}),
        client: client.clientId,
      },
      credentialRef,
    };
  };
}
