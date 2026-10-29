// The account identity from the `id_token` of an authorization-code exchange. The token came straight from Google's
// token endpoint over TLS, in answer to our own request, so its signature is not checked (OpenID Connect Core
// 3.1.3.7); its claims are: issuer, audience, expiry, a subject and an email that are present, and `email_verified`,
// which must be the boolean `true`: a reconnect may match on the address alone, so an unverified one is never trusted.

import { connectError } from './connect-errors';

export const googleIssuers: ReadonlySet<string> = new Set([
  'accounts.google.com',
  'https://accounts.google.com',
]);

export interface GoogleIdentity {
  subject: string;
  /** Lower-cased. */
  address: string;
  displayName?: string;
}

export interface IdTokenCheck {
  clientId: string;
  /** Epoch ms. */
  now: number;
}

type Claims = Record<string, unknown>;

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value !== '';

function decodeClaims(token: unknown): Claims | undefined {
  if (!nonEmpty(token)) return undefined;
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return undefined;
  try {
    const claims: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return typeof claims === 'object' && claims !== null && !Array.isArray(claims)
      ? (claims as Claims)
      : undefined;
  } catch {
    return undefined;
  }
}

/** The `sub` claim, decoded but NOT checked: only to tell whether a refused token is another user's. */
export function subjectClaim(token: unknown): string | undefined {
  const sub = decodeClaims(token)?.sub;
  return nonEmpty(sub) ? sub : undefined;
}

/** The first claim that fails, by name only; never its value. */
function failedClaim(claims: Claims, check: IdTokenCheck): string | undefined {
  if (typeof claims.iss !== 'string' || !googleIssuers.has(claims.iss)) return 'iss';
  if (claims.aud !== check.clientId) return 'aud';
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= check.now) return 'exp';
  if (!nonEmpty(claims.sub)) return 'sub';
  if (!nonEmpty(claims.email)) return 'email';
  if (claims.email_verified !== true) return 'email_verified';
  return undefined;
}

function invalid(claim: string) {
  return connectError('auth', 'invalidIdToken', {
    method: 'oauth.token',
    extra: { providerMessage: `id_token claim refused: ${claim}`, uncertain: false },
  });
}

export function identityFromIdToken(token: unknown, check: IdTokenCheck): GoogleIdentity {
  const claims = decodeClaims(token);
  if (!claims) throw invalid('format');
  const failed = failedClaim(claims, check);
  if (failed) throw invalid(failed);
  const name = nonEmpty(claims.name) ? claims.name : undefined;
  return {
    subject: claims.sub as string,
    address: (claims.email as string).toLowerCase(),
    ...(name ? { displayName: name } : {}),
  };
}
