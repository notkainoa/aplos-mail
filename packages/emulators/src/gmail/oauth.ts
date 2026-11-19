import { createHash } from 'node:crypto';
import type { Clock } from '../kit/clock';
import { jsonReply, type Reply } from './reply';
import { Random } from './rng';

/**
 * Google's OAuth for installed apps, in memory. The emulator never opens a browser: tests run the
 * consent step with `authorize(url)`, which returns the redirect URL the browser would have gone to.
 */
export const SCOPE = {
  openid: 'openid',
  email: 'https://www.googleapis.com/auth/userinfo.email',
  profile: 'https://www.googleapis.com/auth/userinfo.profile',
  gmailReadonly: 'https://www.googleapis.com/auth/gmail.readonly',
  gmailModify: 'https://www.googleapis.com/auth/gmail.modify',
  gmailCompose: 'https://www.googleapis.com/auth/gmail.compose',
  gmailSettingsBasic: 'https://www.googleapis.com/auth/gmail.settings.basic',
  mailFull: 'https://mail.google.com/',
  calendarList: 'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  calendarEvents: 'https://www.googleapis.com/auth/calendar.events',
  // Broader Calendar scopes that Google also accepts for the same calls.
  calendarFull: 'https://www.googleapis.com/auth/calendar',
  calendarReadonly: 'https://www.googleapis.com/auth/calendar.readonly',
  calendarEventsReadonly: 'https://www.googleapis.com/auth/calendar.events.readonly',
  calendarListFull: 'https://www.googleapis.com/auth/calendar.calendarlist',
} as const;

/** Google reports the short sign-in scopes in their long form. */
const SCOPE_ALIASES: Record<string, string> = { email: SCOPE.email, profile: SCOPE.profile };
const ACCESS_TOKEN_SECONDS = 3599;
const TESTING_REFRESH_MS = 7 * 86400_000;
const CODE_LIFETIME_MS = 10 * 60_000;
const REFRESH_TOKEN_CAP = 100;

export interface TestUserInput {
  sub: string;
  email: string;
  name: string;
  /** In testing mode only listed test users may consent. Default true. */
  testUser?: boolean;
}

export interface TestUser extends Required<TestUserInput> {
  /** Scopes this user ticks on the consent screen; null grants everything requested. */
  grantedScopes: string[] | null;
  /** A Workspace admin blocks the app for this user. */
  adminBlocked: boolean;
}

interface AuthCode {
  clientId: string;
  redirectUri: string;
  /** Absent when the request sent no code_challenge (Google allows that; PKCE is "Recommended"). */
  challenge?: { value: string; method: 'S256' | 'plain' };
  user: TestUser;
  granted: string[];
  prompt: string;
  at: number;
}

interface RefreshRecord {
  token: string;
  clientId: string;
  user: TestUser;
  scopes: string[];
  consentAt: number;
  revoked: boolean;
}

interface AccessRecord {
  token: string;
  user: TestUser;
  scopes: string[];
  clientId: string;
  expiresAt: number;
  revoked: boolean;
  refreshToken?: string;
}

export type BearerCheck =
  | { ok: true; user: TestUser; scopes: string[] }
  | { ok: false; reason: 'missing' | 'invalid' | 'expired' };

export interface OAuthOptions {
  testingMode: boolean;
  /** Whether a repeat consent without prompt=consent returns a new refresh token. Default true. */
  repeatConsentIssuesRefreshToken: boolean;
  /**
   * Stricter than Google: refuse authorization requests without `state` or an S256 PKCE challenge.
   * Google only recommends both (native-app guide), so the default is false; Aplos's own sign-in
   * tests turn it on to prove the client always sends them.
   */
  requirePkceAndState?: boolean;
}

export interface SignInOptions {
  clientId: string;
  clientSecret?: string;
  scopes: string[];
  loginHint?: string;
  /** Picks the account explicitly, as choosing it on Google's account chooser would. */
  as?: string;
  prompt?: string;
  fetch: typeof fetch;
}

export interface SignInResult {
  accessToken: string;
  refreshToken?: string;
  scope: string;
  /** The token endpoint's full JSON answer. */
  response: Record<string, unknown>;
}

const oauthError = (status: number, error: string, description?: string): Reply => ({
  status,
  headers: {},
  json: { error, ...(description ? { error_description: description } : {}) },
  reason: error,
});

export class OAuthServer {
  testingMode: boolean;
  repeatConsentIssuesRefreshToken: boolean;
  requirePkceAndState: boolean;
  private readonly users: TestUser[] = [];
  private readonly clients = new Map<string, { secret?: string }>();
  private readonly codes = new Map<string, AuthCode>();
  private readonly refreshTokens = new Map<string, RefreshRecord>();
  private readonly accessTokens = new Map<string, AccessRecord>();
  private readonly consented = new Set<string>();
  private counter = 0;

  constructor(
    private readonly clock: Clock,
    private readonly random: Random,
    options: OAuthOptions,
  ) {
    this.testingMode = options.testingMode;
    this.repeatConsentIssuesRefreshToken = options.repeatConsentIssuesRefreshToken;
    this.requirePkceAndState = options.requirePkceAndState ?? false;
  }

  // ---------- test helpers ----------

  /**
   * Registers an OAuth client. With a secret it behaves like Google's Desktop client type, which
   * must send the secret at the token endpoint; without one it models a client type that has no
   * secret (Google's iOS and Android clients), so the token endpoint does not ask for it.
   */
  addClient(clientId: string, secret?: string): void {
    if (!clientId) throw new Error('clientId must not be empty');
    this.clients.set(clientId, { secret });
  }

  addUser(input: TestUserInput): TestUser {
    const user: TestUser = { testUser: true, ...input, grantedScopes: null, adminBlocked: false };
    this.users.push(user);
    return user;
  }

  listUsers(): TestUser[] {
    return [...this.users];
  }

  /** Finds a user by email or sub. */
  findUser(who: string): TestUser | undefined {
    const lower = who.toLowerCase();
    return this.users.find(u => u.email.toLowerCase() === lower || u.sub === who);
  }

  private requireUser(who: string): TestUser {
    const user = this.findUser(who);
    if (!user) throw new Error(`Unknown test user: ${who}`);
    return user;
  }

  /** Which scopes the user ticks at consent; `null` ticks everything requested. */
  setGrantedScopes(who: string, scopes: string[] | null): void {
    this.requireUser(who).grantedScopes = scopes ? scopes.map(s => SCOPE_ALIASES[s] ?? s) : null;
  }

  /** Revokes every refresh and access token of the user, as "Remove access" in their Google account does. */
  revoke(who: string): void {
    const user = this.requireUser(who);
    for (const r of this.refreshTokens.values()) if (r.user === user) r.revoked = true;
    for (const a of this.accessTokens.values()) if (a.user === user) a.revoked = true;
  }

  /** Workspace admin policy: new consent and refresh answer `admin_policy_enforced`. */
  setAdminPolicy(who: string, enforced = true): void {
    this.requireUser(who).adminBlocked = enforced;
  }

  /** Makes every access token handed out so far expire now. */
  expireAccessTokens(): void {
    const now = this.clock.now();
    for (const a of this.accessTokens.values()) a.expiresAt = Math.min(a.expiresAt, now);
  }

  /** When the refresh token stops working in testing mode (undefined if unknown). */
  refreshTokenExpiresAt(token: string): number | undefined {
    const record = this.refreshTokens.get(token);
    return record ? record.consentAt + TESTING_REFRESH_MS : undefined;
  }

  /**
   * Runs the consent step for an authorization URL and returns the redirect URL the browser would
   * visit. `as` picks the account explicitly; `deny` clicks Cancel. Throws when Google would show an
   * error page instead of redirecting (unknown client, bad redirect_uri).
   */
  authorize(url: string | URL, options: { as?: string; deny?: boolean } = {}): string {
    const reply = this.consent(new URL(url), options);
    const location = reply.headers.location;
    if (reply.status !== 302 || !location)
      throw new Error(`Authorization request rejected: ${JSON.stringify(reply.json)}`);
    return location;
  }

  /** Complete in-process sign-in: PKCE, consent and code exchange through the emulator's own fetch. */
  async signIn(options: SignInOptions): Promise<SignInResult> {
    const verifier = this.random.hex(43);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const redirectUri = 'http://127.0.0.1:53682/oauth/callback';
    const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    auth.search = new URLSearchParams({
      client_id: options.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: options.scopes.join(' '),
      state: this.random.hex(16),
      code_challenge: challenge,
      code_challenge_method: 'S256',
      ...(options.loginHint ? { login_hint: options.loginHint } : {}),
      ...(options.prompt ? { prompt: options.prompt } : {}),
    }).toString();
    const redirect = new URL(this.authorize(auth, { as: options.as }));
    const code = redirect.searchParams.get('code');
    if (!code) throw new Error(`Sign-in failed: ${redirect.searchParams.get('error')}`);
    const response = await options.fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: options.clientId,
        redirect_uri: redirectUri,
        code_verifier: verifier,
        ...(options.clientSecret ? { client_secret: options.clientSecret } : {}),
      }),
    });
    const body = (await response.json()) as Record<string, unknown>;
    if (!response.ok) throw new Error(`Token exchange failed: ${JSON.stringify(body)}`);
    return {
      accessToken: String(body.access_token),
      refreshToken: body.refresh_token as string | undefined,
      scope: String(body.scope),
      response: body,
    };
  }

  // ---------- endpoints ----------

  private redirectWith(redirectUri: string, params: Record<string, string | undefined>): Reply {
    const target = new URL(redirectUri);
    for (const [key, value] of Object.entries(params))
      if (value !== undefined) target.searchParams.set(key, value);
    return { status: 302, headers: { location: target.toString() } };
  }

  /** GET /o/oauth2/v2/auth, with the consent screen answered automatically. */
  consent(url: URL, options: { as?: string; deny?: boolean } = {}): Reply {
    const q = url.searchParams;
    const clientId = q.get('client_id') ?? '';
    if (!clientId || !this.clients.has(clientId))
      return oauthError(401, 'invalid_client', 'The OAuth client was not found.');
    const redirectUri = q.get('redirect_uri') ?? '';
    if (!isLoopbackWithPort(redirectUri)) {
      return oauthError(
        400,
        'redirect_uri_mismatch',
        'redirect_uri must be http://127.0.0.1:<port>/..., http://localhost:<port>/... or http://[::1]:<port>/...',
      );
    }
    const state = q.get('state') ?? undefined;
    const fail = (error: string, description?: string): Reply =>
      this.redirectWith(redirectUri, { error, error_description: description, state });

    if (q.get('response_type') !== 'code') return fail('unsupported_response_type');
    const challengeValue = q.get('code_challenge') ?? '';
    // Without a method Google assumes "plain" (RFC 7636 section 4.3).
    const method = q.get('code_challenge_method') || 'plain';
    if (challengeValue && method !== 'S256' && method !== 'plain')
      return fail('invalid_request', 'Invalid code_challenge_method');
    if (this.requirePkceAndState) {
      if (!state) return fail('invalid_request', 'state is required');
      if (!challengeValue || method !== 'S256')
        return fail('invalid_request', 'code_challenge with method S256 is required');
    }
    const requested = (q.get('scope') ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .map(s => SCOPE_ALIASES[s] ?? s);
    if (!requested.length) return fail('invalid_scope', 'scope is required');

    const user = this.chooseUser(q.get('login_hint'), options.as);
    if (!user || options.deny) return fail('access_denied');
    if (this.testingMode && !user.testUser)
      return fail('access_denied', 'The user is not a listed test user.');
    if (user.adminBlocked)
      return fail(
        'admin_policy_enforced',
        'The application is blocked by a Workspace administrator.',
      );
    const granted = user.grantedScopes
      ? requested.filter(s => user.grantedScopes!.includes(s))
      : requested;
    if (!granted.length) return fail('access_denied');

    const code = `4/emu-${this.random.hex(40)}`;
    this.codes.set(code, {
      clientId,
      redirectUri,
      challenge: challengeValue
        ? { value: challengeValue, method: method as 'S256' | 'plain' }
        : undefined,
      user,
      granted,
      prompt: q.get('prompt') ?? '',
      at: this.clock.now(),
    });
    return this.redirectWith(redirectUri, { code, state, scope: granted.join(' ') });
  }

  /** The hint wins when it names a known account; otherwise the first test user signs in. */
  private chooseUser(hint: string | null, explicit?: string): TestUser | undefined {
    if (explicit) return this.findUser(explicit);
    return (hint ? this.findUser(hint) : undefined) ?? this.users[0];
  }

  /** POST /token. `params` are the decoded form (or JSON) fields. */
  token(params: URLSearchParams): Reply {
    const clientId = params.get('client_id') ?? '';
    const client = this.clients.get(clientId);
    if (!client) return oauthError(401, 'invalid_client', 'The OAuth client was not found.');
    if (client.secret !== undefined) {
      // Google asks Desktop clients for the secret even though the native-app guide calls it
      // optional: a missing one is 400 invalid_request, a wrong one 401 invalid_client [observed].
      const sent = params.get('client_secret');
      if (!sent) return oauthError(400, 'invalid_request', 'client_secret is missing.');
      if (sent !== client.secret) return oauthError(401, 'invalid_client', 'Unauthorized');
    }
    const grant = params.get('grant_type');
    if (grant === 'authorization_code') return this.exchangeCode(params, clientId);
    if (grant === 'refresh_token') return this.refresh(params, clientId);
    return oauthError(400, 'unsupported_grant_type', 'Invalid grant_type');
  }

  private exchangeCode(params: URLSearchParams, clientId: string): Reply {
    const code = params.get('code') ?? '';
    const stored = this.codes.get(code);
    this.codes.delete(code); // a code works once, even when the attempt fails
    const now = this.clock.now();
    if (!stored || stored.clientId !== clientId || now - stored.at > CODE_LIFETIME_MS)
      return oauthError(400, 'invalid_grant', 'Bad Request');
    // A redirect_uri other than the authorization request's is a configuration fault, not a dead grant.
    if (stored.redirectUri !== params.get('redirect_uri'))
      return oauthError(400, 'redirect_uri_mismatch', 'Bad Request');
    if (stored.challenge) {
      const verifier = params.get('code_verifier');
      if (!verifier) return oauthError(400, 'invalid_grant', 'Missing code verifier.');
      const derived =
        stored.challenge.method === 'S256'
          ? createHash('sha256').update(verifier).digest('base64url')
          : verifier;
      if (derived !== stored.challenge.value)
        return oauthError(400, 'invalid_grant', 'Invalid code verifier.');
    }
    if (stored.user.adminBlocked)
      return oauthError(
        400,
        'admin_policy_enforced',
        'The application is blocked by a Workspace administrator.',
      );

    const seen = `${stored.user.sub}|${clientId}`;
    const repeat = this.consented.has(seen);
    this.consented.add(seen);
    const forced = stored.prompt.split(/\s+/).includes('consent');
    const issueRefresh = !repeat || this.repeatConsentIssuesRefreshToken || forced;
    const refresh = issueRefresh
      ? this.newRefreshToken(stored.user, clientId, stored.granted, now)
      : undefined;
    return this.tokenReply(stored.user, clientId, stored.granted, refresh, now, true);
  }

  private refresh(params: URLSearchParams, clientId: string): Reply {
    const record = this.refreshTokens.get(params.get('refresh_token') ?? '');
    const now = this.clock.now();
    const dead = oauthError(400, 'invalid_grant', 'Token has been expired or revoked.');
    if (!record || record.clientId !== clientId || record.revoked) return dead;
    if (record.user.adminBlocked)
      return oauthError(
        400,
        'admin_policy_enforced',
        'The application is blocked by a Workspace administrator.',
      );
    if (this.testingMode && now - record.consentAt >= TESTING_REFRESH_MS) return dead;
    return this.tokenReply(record.user, clientId, record.scopes, record, now, false);
  }

  private newRefreshToken(
    user: TestUser,
    clientId: string,
    scopes: string[],
    now: number,
  ): RefreshRecord {
    const record: RefreshRecord = {
      token: `1//emu-${this.random.hex(48)}`,
      clientId,
      user,
      scopes,
      consentAt: now,
      revoked: false,
    };
    this.refreshTokens.set(record.token, record);
    // Google keeps at most 100 refresh tokens per account and client; the oldest quietly dies.
    const mine = [...this.refreshTokens.values()].filter(
      r => r.user === user && r.clientId === clientId && !r.revoked,
    );
    if (mine.length > REFRESH_TOKEN_CAP) mine[0].revoked = true;
    return record;
  }

  /** `grant` is the refresh token behind this access token; `isNew` means it is returned to the client. */
  private tokenReply(
    user: TestUser,
    clientId: string,
    scopes: string[],
    grant: RefreshRecord | undefined,
    now: number,
    isNew: boolean,
  ): Reply {
    const access: AccessRecord = {
      token: `ya29.emu-${this.counter++}-${this.random.hex(40)}`,
      user,
      scopes,
      clientId,
      expiresAt: now + ACCESS_TOKEN_SECONDS * 1000,
      revoked: false,
      refreshToken: grant?.token,
    };
    this.accessTokens.set(access.token, access);
    const body: Record<string, unknown> = {
      access_token: access.token,
      expires_in: ACCESS_TOKEN_SECONDS,
      scope: scopes.join(' '),
      token_type: 'Bearer',
    };
    if (grant && isNew) body.refresh_token = grant.token;
    // proto-google.md 8.1 reads the docs as "only for time-based access"; live Testing-mode
    // projects are widely seen to send it too (about 604,799 s). Unknown to confirm on the first live run.
    if (grant && this.testingMode)
      body.refresh_token_expires_in = Math.max(
        0,
        Math.floor((grant.consentAt + TESTING_REFRESH_MS - now) / 1000),
      );
    if (isNew && scopes.includes(SCOPE.openid))
      body.id_token = this.idToken(user, clientId, scopes, now);
    return jsonReply(body, 200, { 'cache-control': 'no-store' });
  }

  /** An unsigned, clearly synthetic id token; tests can decode it, real clients must not trust it. */
  private idToken(user: TestUser, clientId: string, scopes: string[], now: number): string {
    const part = (value: unknown): string =>
      Buffer.from(JSON.stringify(value)).toString('base64url');
    const claims = {
      iss: 'https://accounts.google.com',
      aud: clientId,
      sub: user.sub,
      iat: Math.floor(now / 1000),
      exp: Math.floor(now / 1000) + ACCESS_TOKEN_SECONDS,
      ...(scopes.includes(SCOPE.email) ? { email: user.email, email_verified: true } : {}),
      ...(scopes.includes(SCOPE.profile) ? { name: user.name } : {}),
    };
    return `${part({ alg: 'none', typ: 'JWT' })}.${part(claims)}.emulator-unsigned`;
  }

  /** POST /revoke: kills the whole grant behind a refresh or access token. A dead token is 400 [observed]. */
  revokeToken(params: URLSearchParams): Reply {
    const token = params.get('token') ?? '';
    const refresh = this.refreshTokens.get(token);
    const access = this.accessTokens.get(token);
    const dead = refresh
      ? refresh.revoked
      : !access || access.revoked || this.clock.now() >= access.expiresAt;
    if (dead) return oauthError(400, 'invalid_token', 'Token expired or revoked');
    const grant = refresh ?? this.refreshTokens.get(access!.refreshToken ?? '');
    if (grant) {
      grant.revoked = true;
      for (const a of this.accessTokens.values())
        if (a.refreshToken === grant.token) a.revoked = true;
    }
    if (access) access.revoked = true;
    return { status: 200, headers: {}, text: '' };
  }

  /** Looks a bearer token up. */
  checkBearer(header: string | null | undefined): BearerCheck {
    const match = /^Bearer\s+(\S+)$/i.exec(header ?? '');
    if (!match) return { ok: false, reason: header ? 'invalid' : 'missing' };
    const record = this.accessTokens.get(match[1]);
    if (!record || record.revoked) return { ok: false, reason: 'invalid' };
    if (this.clock.now() >= record.expiresAt) return { ok: false, reason: 'expired' };
    return { ok: true, user: record.user, scopes: record.scopes };
  }

  /** GET userinfo: sub always, email and name only when the grant covers them. */
  userinfo(header: string | null | undefined): Reply {
    const check = this.checkBearer(header);
    if (!check.ok) {
      return {
        status: 401,
        headers: { 'www-authenticate': 'Bearer error="invalid_token"' },
        json: { error: 'invalid_request', error_description: 'Invalid Credentials' },
        reason: 'invalid_request',
      };
    }
    const { user, scopes } = check;
    return jsonReply({
      sub: user.sub,
      ...(scopes.includes(SCOPE.profile) ? { name: user.name } : {}),
      ...(scopes.includes(SCOPE.email) ? { email: user.email, email_verified: true } : {}),
    });
  }
}

export function isLoopbackWithPort(uri: string): boolean {
  try {
    const url = new URL(uri);
    return (
      url.protocol === 'http:' &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
      url.port !== ''
    );
  } catch {
    return false;
  }
}
