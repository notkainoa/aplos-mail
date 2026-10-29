// What a token response tells us about the grant: when it was made, when the refresh token stops working, and
// whether a reconnect is the same Google account (plan 20 PV5, weekly reconnect).

import { parseGrantedScopes, missingRequiredScopes } from './scopes';

export const testingRefreshLifetimeMs = 7 * 24 * 60 * 60 * 1000;
/** Ask for the reconnect this long before the refresh token dies, so a user who is away overnight is not locked out. */
export const reconnectMarginMs = 18 * 60 * 60 * 1000;

export interface GrantInputs {
  /** Epoch ms of the token response. */
  now: number;
  /** `testingMode` of the resolved client. */
  testingMode: boolean;
  /** The raw token response body. */
  response: { scope?: unknown; refresh_token_expires_in?: unknown };
  clientId?: string;
}

export interface Grant {
  grantedAt: number;
  /** Becomes `reconnectBy`. */
  refreshExpiresAt?: number;
  client?: string;
  scopes: string[];
}

function reportedLifetimeMs(value: unknown): number | undefined {
  const seconds = typeof value === 'string' ? Number(value) : value;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return undefined;
  return seconds * 1000;
}

/**
 * The earlier of grant + 7 days (Testing mode) and the lifetime Google reports, less a margin (at most half the
 * lifetime, so a very short one still leaves time); none when neither applies.
 */
export function refreshExpiresAt(inputs: GrantInputs): number | undefined {
  const reported = reportedLifetimeMs(inputs.response.refresh_token_expires_in);
  const limits = [inputs.testingMode ? testingRefreshLifetimeMs : undefined, reported].filter(
    (ms): ms is number => ms !== undefined,
  );
  if (!limits.length) return undefined;
  const lifetime = Math.min(...limits);
  return inputs.now + lifetime - Math.min(reconnectMarginMs, lifetime / 2);
}

/** For authorization-code exchanges only: a refresh-grant response carries no `refresh_token_expires_in`. */
export function grantFromTokenResponse(inputs: GrantInputs): Grant {
  return {
    grantedAt: inputs.now,
    refreshExpiresAt: refreshExpiresAt(inputs),
    client: inputs.clientId,
    scopes: parseGrantedScopes(inputs.response.scope),
  };
}

export type GrantCheck =
  | { ok: true }
  | {
      ok: false;
      kind: 'permission' | 'auth';
      reason: 'missingRequiredScope' | 'wrongAccount';
      message: string;
    };

/** A grant without the mail scope is refused in a plain sentence. */
export function checkRequiredScopes(granted: readonly string[]): GrantCheck {
  if (missingRequiredScopes(granted).length === 0) return { ok: true };
  return {
    ok: false,
    kind: 'permission',
    reason: 'missingRequiredScope',
    message:
      'Aplos needs permission to read and organise your Gmail to work. Try again and allow it on Google’s screen.',
  };
}

const wrongAccount: GrantCheck = {
  ok: false,
  kind: 'auth',
  reason: 'wrongAccount',
  message: 'That is a different Google account. Sign in with the account you are reconnecting.',
};

/** A reconnect must return the same Google account; a different `sub` is refused and nothing is stored. */
export function checkReconnectIdentity(
  expectedSubject: string | undefined,
  subject: string,
): GrantCheck {
  if (!expectedSubject || expectedSubject === subject) return { ok: true };
  return wrongAccount;
}

/**
 * Without a `sub` to compare (an account saved before subjects were kept), the requested address must be the
 * id_token's email, lower-cased on both sides. Only sound because `id-token.ts` requires `email_verified === true`.
 */
export function checkExpectedAddress(expected: string | undefined, address: string): GrantCheck {
  const wanted = expected?.trim().toLowerCase();
  if (!wanted || wanted === address.toLowerCase()) return { ok: true };
  return wrongAccount;
}

/**
 * The OAuth parameters that differ for a reconnect: the same account is preselected (D21). Consent is always asked
 * for, because Google returns a refresh token only on a consent grant; a reconnect that comes back without one must
 * be treated as failed and keep the old state.
 */
export function reconnectAuthParams(loginHint: string | undefined): Record<string, string> {
  const base = { access_type: 'offline', prompt: 'consent' };
  return loginHint ? { ...base, login_hint: loginHint } : base;
}
