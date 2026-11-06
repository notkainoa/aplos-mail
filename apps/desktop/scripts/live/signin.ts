import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';
import { printableMessage, RunnerError } from './errors';
import { clientFromEnv, withBearer, type OAuthClient } from './auth';
import { createGuardedFetch } from './guard';
import {
  defaultKeychainService,
  keychainReader,
  keychainWriter,
  addressHash,
  LABEL,
  newAddressSalt,
  reconnectBy,
  saveAccount,
  vaultDir,
  type SecretReader,
  type SecretWriter,
} from './vault';

/**
 * The one-time sign-in for a test account, run by the owner (never by an agent): loopback redirect
 * plus PKCE against the app's own OAuth client. The refresh token goes to the keychain and only
 * metadata goes to accounts.json. Nothing here prints a token, an address or the sign-in URL.
 */
export const LIVE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.settings.basic',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/calendar.events.readonly',
];
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const PROFILE_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/profile?fields=emailAddress';
/** The login hint is an address, so it is read from the environment, never from argv. */
const LOGIN_HINT_ENV = 'APLOS_LIVE_LOGIN_HINT';

export interface SignInDeps {
  /** Reaches the token endpoint; the sign-in wraps it in a tier R guard. */
  fetch: typeof fetch;
  /** Opens the sign-in page in the system browser. */
  opener(url: string): Promise<void>;
  readSecret: SecretReader;
  writeSecret: SecretWriter;
  now(): number;
  vaultDir: string;
  timeoutMs?: number;
}

export interface SignInArgs {
  label: string;
  client: OAuthClient;
  loginHint?: string;
}

export interface SignInOutcome {
  grantedAt: string;
  reconnectBy: string;
}

const base64url = (bytes: Buffer): string => bytes.toString('base64url');

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // Loopback only: nothing outside this Mac can reach the redirect.
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

export async function signIn(args: SignInArgs, deps: SignInDeps): Promise<SignInOutcome> {
  if (!LABEL.test(args.label))
    throw new RunnerError('Account labels are lowercase names such as "agent"');
  const verifier = base64url(randomBytes(48));
  const state = base64url(randomBytes(24));
  const server = createServer();
  const callback = new Promise<URL>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new RunnerError('Sign-in timed out')),
      deps.timeoutMs ?? 5 * 60_000,
    );
    server.on('request', (request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/oauth/callback') {
        response.writeHead(404).end();
        return;
      }
      response
        .writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
        .end('You can close this tab and return to the terminal.');
      clearTimeout(timer);
      resolve(url);
    });
    server.on('error', reject);
  });

  try {
    const port = await listen(server);
    const redirectUri = `http://127.0.0.1:${port}/oauth/callback`;
    const auth = new URL(AUTH_URL);
    auth.search = new URLSearchParams({
      client_id: args.client.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: LIVE_SCOPES.join(' '),
      state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      // Offline access and a fresh consent make sure Google hands back a refresh token.
      access_type: 'offline',
      prompt: 'consent',
      ...(args.loginHint ? { login_hint: args.loginHint } : {}),
    }).toString();
    await deps.opener(auth.href);

    const returned = await callback;
    if (returned.searchParams.get('state') !== state)
      throw new RunnerError('Sign-in answer did not match this request');
    const error = returned.searchParams.get('error');
    if (error)
      throw new RunnerError(
        `Google did not grant access (${/^[a-z_]{1,40}$/.test(error) ? error : 'unknown'})`,
      );
    const code = returned.searchParams.get('code');
    if (!code) throw new RunnerError('Sign-in answer had no code');

    // Tier R plus the one code exchange; the bearer layer signs the profile read with the new token.
    let accessToken = '';
    const send = createGuardedFetch(
      withBearer(deps.fetch, () => accessToken),
      { tier: 'R', allowCodeExchange: true },
    );
    const response = await send(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: args.client.clientId,
        redirect_uri: redirectUri,
        code_verifier: verifier,
        ...(args.client.clientSecret ? { client_secret: args.client.clientSecret } : {}),
      }),
    });
    const body = (await response.json().catch(() => ({}))) as {
      access_token?: unknown;
      refresh_token?: unknown;
      refresh_token_expires_in?: unknown;
      scope?: unknown;
      error?: unknown;
    };
    if (!response.ok)
      throw new RunnerError(
        `Google refused the sign-in code (${typeof body.error === 'string' && /^[a-z_]{1,40}$/.test(body.error) ? body.error : 'unknown'})`,
      );
    if (typeof body.refresh_token !== 'string')
      throw new RunnerError(
        'Google returned no refresh token; remove the app under Google account permissions and sign in again',
      );
    const granted = typeof body.scope === 'string' ? body.scope.split(' ') : [];
    if (!granted.includes(LIVE_SCOPES[0]!))
      throw new RunnerError(
        'Gmail access was not granted; tick every permission on the consent screen',
      );

    // The account's own address, kept only as a salted hash for the runner's account check.
    if (typeof body.access_token !== 'string')
      throw new RunnerError('Google returned no access token');
    accessToken = body.access_token;
    const profile = await send(PROFILE_URL);
    const address = ((await profile.json().catch(() => ({}))) as { emailAddress?: unknown })
      .emailAddress;
    if (!profile.ok || typeof address !== 'string')
      throw new RunnerError('Could not read the account profile');
    const addressSalt = newAddressSalt();

    const service = defaultKeychainService(args.label);
    await deps.writeSecret(service, body.refresh_token);
    // Read it back so a keychain that silently kept the old value is noticed now, not at the next run.
    if ((await deps.readSecret(service)) !== body.refresh_token)
      throw new RunnerError('The keychain did not keep the new token');

    const grantedAtMs = deps.now();
    const expiresIn =
      typeof body.refresh_token_expires_in === 'number' ? body.refresh_token_expires_in : undefined;
    const meta = {
      provider: 'gmail' as const,
      grantedAt: new Date(grantedAtMs).toISOString(),
      ...(expiresIn
        ? { refreshExpiresAt: new Date(grantedAtMs + expiresIn * 1000).toISOString() }
        : {}),
      keychainService: service,
      addressSalt,
      addressHash: addressHash(address, addressSalt),
    };
    await saveAccount(deps.vaultDir, args.label, meta);
    return { grantedAt: meta.grantedAt, reconnectBy: new Date(reconnectBy(meta)).toISOString() };
  } finally {
    server.close();
    server.closeAllConnections();
  }
}

// ---------- command line ----------

function flag(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
}

/**
 * The command line's label and hint. The hint is an address, and argv is visible to every process
 * on the Mac (and lands in shell history), so it comes from APLOS_LIVE_LOGIN_HINT instead.
 */
export function signInArgsFrom(
  argv: string[],
  env: Record<string, string | undefined>,
): { label: string; loginHint?: string } {
  if (argv.some(arg => arg === '--login-hint' || arg.startsWith('--login-hint=')))
    throw new RunnerError(
      `--login-hint is not accepted on the command line (other processes can read it); set ${LOGIN_HINT_ENV} instead`,
    );
  const label = flag(argv, '--label');
  if (flag(argv, '--provider') !== 'gmail' || !label)
    throw new RunnerError(
      `Usage: ${LOGIN_HINT_ENV}=<address, optional> tsx apps/desktop/scripts/live/signin.ts --provider gmail --label agent`,
    );
  const loginHint = env[LOGIN_HINT_ENV]?.trim();
  return { label, ...(loginHint ? { loginHint } : {}) };
}

async function main(argv: string[]): Promise<void> {
  let parsed: { label: string; loginHint?: string };
  try {
    parsed = signInArgsFrom(argv, process.env);
  } catch (error) {
    console.error(printableMessage(error, 'Sign-in failed'));
    process.exitCode = 2;
    return;
  }
  const { label } = parsed;
  const outcome = await signIn(
    { ...parsed, client: clientFromEnv(process.env) },
    {
      fetch,
      // `open` shows the page in the owner's browser. This only runs when the owner types the command.
      opener: url =>
        new Promise((resolve, reject) =>
          execFile('open', [url], error =>
            error ? reject(new RunnerError('Could not open the browser')) : resolve(),
          ),
        ),
      readSecret: keychainReader,
      writeSecret: keychainWriter,
      now: Date.now,
      vaultDir: vaultDir(),
    },
  );
  console.log(
    `Signed in test account ${label}. Reconnect it by ${outcome.reconnectBy.slice(0, 10)}.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(error => {
    console.error(printableMessage(error, 'Sign-in failed'));
    process.exitCode = 1;
  });
}
