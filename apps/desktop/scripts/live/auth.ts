import { RunnerError } from './errors';

/**
 * Access-token handling for the runner. The refresh token comes from the vault; the short-lived
 * access token stays in a closure and is added to requests here, below the guard, so probes never
 * see it.
 */
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export class TokenRefusal extends RunnerError {
  /** Google's error code only (for example invalid_grant), never a response body. */
  constructor(readonly code: string) {
    super(`Google refused the token refresh (${code})`);
    this.name = 'TokenRefusal';
  }
}

export interface OAuthClient {
  clientId: string;
  clientSecret?: string;
}

export function clientFromEnv(env: Record<string, string | undefined>): OAuthClient {
  const clientId = env.APLOS_GOOGLE_CLIENT_ID;
  if (!clientId)
    throw new RunnerError(
      'Set APLOS_GOOGLE_CLIENT_ID (and APLOS_GOOGLE_CLIENT_SECRET if the client has one)',
    );
  return {
    clientId,
    ...(env.APLOS_GOOGLE_CLIENT_SECRET ? { clientSecret: env.APLOS_GOOGLE_CLIENT_SECRET } : {}),
  };
}

/** Exchanges the refresh token for an access token. `send` should be a guarded fetch. */
export async function refreshAccessToken(
  send: typeof fetch,
  client: OAuthClient,
  refreshToken: string,
): Promise<string> {
  const response = await send(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: client.clientId,
      ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
    }),
  });
  const body = (await response.json().catch(() => ({}))) as {
    access_token?: unknown;
    error?: unknown;
  };
  if (!response.ok || typeof body.access_token !== 'string') {
    const code =
      typeof body.error === 'string' && /^[a-z_]{1,40}$/.test(body.error) ? body.error : 'unknown';
    throw new TokenRefusal(code);
  }
  return body.access_token;
}

/** Adds the bearer token to every request except the OAuth ones. */
export function withBearer(inner: typeof fetch, getToken: () => string): typeof fetch {
  return (input, init) => {
    const url =
      typeof input === 'string' ? new URL(input) : input instanceof URL ? input : undefined;
    if (!url || url.origin === 'https://oauth2.googleapis.com') return inner(input, init);
    const headers = new Headers(init?.headers);
    headers.set('authorization', `Bearer ${getToken()}`);
    return inner(input, { ...init, headers });
  };
}
