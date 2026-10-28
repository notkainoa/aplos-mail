import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { ProviderError, type RequestIo } from '@aplos/engine/ports';
import { FakeClock, createGmailEmulator, SCOPE } from '@aplos/emulators';
import { createHttpClient } from '../../src/host/providers/shared/http';
import {
  GoogleTokenSource,
  tokenSkewMs,
  type GoogleTokenBundle,
  type SecretVault,
} from '../../src/host/providers/oauth/token-source';

const clientId = 'client-a.apps.googleusercontent.com';
const clientSecret = 'GOCSPX-secret-never-shown';
const refreshToken = '1//refresh-never-shown';
const mailScope = SCOPE.gmailModify;
const account = 'acct-1';

interface MemoryVault extends SecretVault<GoogleTokenBundle> {
  entries: Map<string, GoogleTokenBundle>;
  writes: GoogleTokenBundle[];
  failWrites: boolean;
}

/** Like `main/vault.ts`: a refused write leaves the previous value in place. */
function memoryVault(initial?: GoogleTokenBundle): MemoryVault {
  const vault: MemoryVault = {
    entries: new Map(initial ? [[account, { ...initial }]] : []),
    writes: [],
    failWrites: false,
    get: ref => vault.entries.get(ref),
    async set(ref, value) {
      if (vault.failWrites) throw new Error('Account credentials could not be saved securely.');
      vault.writes.push({ ...value });
      vault.entries.set(ref, { ...value });
    },
  };
  return vault;
}

type Script = (body: URLSearchParams) => Response | Promise<Response>;

interface ScriptedFetch {
  fetch: typeof fetch;
  calls: URLSearchParams[];
}

function scriptedFetch(...script: Script[]): ScriptedFetch {
  const calls: URLSearchParams[] = [];
  const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = new URLSearchParams(String(init?.body ?? ''));
    calls.push(body);
    const next = script[Math.min(calls.length - 1, script.length - 1)];
    return next(body);
  }) as typeof fetch;
  return { fetch: fetchFn, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const ok =
  (extra: Record<string, unknown> = {}): Script =>
  () =>
    json({ access_token: 'ya29.access', expires_in: 3599, scope: mailScope, ...extra });

const oauthRefusal =
  (error: string, status = 400, description = 'Token has been expired or revoked.'): Script =>
  () =>
    json({ error, error_description: description }, status);

interface Setup {
  source: GoogleTokenSource;
  vault: MemoryVault;
  clock: FakeClock;
  calls: URLSearchParams[];
}

function setup(
  script: Script[],
  options: { bundle?: GoogleTokenBundle | null; client?: string } = {},
): Setup {
  const clock = new FakeClock();
  const scripted = scriptedFetch(...script);
  const bundle =
    options.bundle === null ? undefined : (options.bundle ?? { clientId, refreshToken });
  const vault = memoryVault(bundle);
  const http = createHttpClient({ fetch: scripted.fetch, clock, userAgent: 'aplos-test' });
  const source = new GoogleTokenSource({
    vault,
    http,
    clock,
    client: () => ({ clientId: options.client ?? clientId, clientSecret }),
  });
  return { source, vault, clock, calls: scripted.calls };
}

const io = (): RequestIo => ({ signal: new AbortController().signal });

async function failure(promise: Promise<unknown>): Promise<ProviderError> {
  const error = await promise.then(
    () => assert.fail('expected the refresh to fail'),
    (e: unknown) => e,
  );
  assert.ok(error instanceof ProviderError, `not a ProviderError: ${String(error)}`);
  return error;
}

function assertNoSecrets(error: unknown, secrets: string[]): void {
  const views = [String(error), JSON.stringify(error), inspect(error, { depth: 10 })];
  if (error instanceof Error) views.push(error.message, error.stack ?? '');
  for (const view of views) {
    for (const secret of secrets) assert.ok(!view.includes(secret), 'a secret leaked');
  }
}

test('cached is empty before a refresh, then serves the token without I/O until the skew', async () => {
  const { source, clock, calls } = setup([ok()]);
  assert.equal(source.cached(account), undefined);
  const token = await source.refresh(account, io());
  assert.equal(token.token, 'ya29.access');
  assert.equal(token.expiresAt, clock.now() + 3599_000);
  assert.deepEqual(source.cached(account), token);
  assert.equal(source.cached('other'), undefined, 'the cache is per account');
  await clock.advance(3599_000 - tokenSkewMs - 1);
  assert.ok(source.cached(account));
  await clock.advance(1);
  assert.equal(source.cached(account), undefined);
  assert.equal(calls.length, 1, 'cached never touches the network');
});

test('refresh makes exactly one POST with the bundle’s refresh token and client', async () => {
  const { source, calls } = setup([oauthRefusal('backendError', 503)]);
  const error = await failure(source.refresh(account, io()));
  assert.equal(error.error.class, 'transient');
  assert.equal(calls.length, 1, 'no retry inside the token source');
  assert.equal(calls[0].get('grant_type'), 'refresh_token');
  assert.equal(calls[0].get('refresh_token'), refreshToken);
  assert.equal(calls[0].get('client_id'), clientId);
  assert.equal(calls[0].get('client_secret'), clientSecret);
});

test('invalid_grant is class auth with a UI sentence, clears the cache and keeps the vault bundle', async () => {
  const { source, vault, clock } = setup([ok(), oauthRefusal('invalid_grant')]);
  await source.refresh(account, io());
  assert.ok(source.cached(account));
  await clock.advance(60_000);
  const error = await failure(source.refresh(account, io()));
  assert.equal(error.error.class, 'auth');
  assert.equal(error.error.reason, 'invalid_grant');
  assert.equal(error.scope, 'account');
  assert.match(error.message, /sign in to this account again/);
  assert.equal(source.cached(account), undefined, 'cache cleared on auth failure');
  assert.deepEqual(vault.entries.get(account), { clientId, refreshToken });
  assert.equal(vault.writes.length, 0);
});

test('admin_policy_enforced is auth too; invalid_client is a project-wide config refusal', async () => {
  const admin = setup([oauthRefusal('admin_policy_enforced')]);
  assert.equal((await failure(admin.source.refresh(account, io()))).error.class, 'auth');
  const client = setup([oauthRefusal('invalid_client', 401, 'Unauthorized')]);
  const error = await failure(client.source.refresh(account, io()));
  assert.equal(error.error.class, 'config');
  assert.equal(error.scope, 'project');
});

test('network failures, timeouts and 5xx are transient and keep the refresh token and the cache', async () => {
  const down: Script = () => Promise.reject(Object.assign(new TypeError('fetch failed'), {}));
  const hang: Script = () => new Promise<Response>(() => {});
  for (const script of [down, hang, oauthRefusal('internal_failure', 500)]) {
    const { source, vault, clock } = setup([ok(), script]);
    await source.refresh(account, io());
    const kept = source.cached(account);
    await clock.advance(1000);
    const error = await failure(source.refresh(account, io()));
    assert.equal(error.error.class, 'transient');
    assert.deepEqual(vault.entries.get(account), { clientId, refreshToken });
    assert.deepEqual(source.cached(account), kept, 'a failed renewal does not drop a valid token');
  }
});

test('an aborted request is cancelled, not auth', async () => {
  const { source, vault } = setup([ok()]);
  const controller = new AbortController();
  controller.abort();
  const error = await failure(source.refresh(account, { signal: controller.signal }));
  assert.equal(error.error.class, 'cancelled');
  assert.deepEqual(vault.entries.get(account), { clientId, refreshToken });
});

test('a rotated refresh token is stored as one bundle write before the token is used', async () => {
  const { source, vault } = setup([ok({ refresh_token: '1//rotated' })]);
  await source.refresh(account, io());
  assert.deepEqual(vault.writes, [{ clientId, refreshToken: '1//rotated' }]);
  const untouched = setup([ok()]);
  await untouched.source.refresh(account, io());
  assert.equal(untouched.vault.writes.length, 0, 'no write when nothing rotated');
});

test('a refused rotation write keeps the old bundle in the vault and the new token for the next try', async () => {
  const { source, vault, calls } = setup([ok({ refresh_token: '1//rotated' }), ok()]);
  vault.failWrites = true;
  const error = await failure(source.refresh(account, io()));
  assert.equal(error.error.class, 'transient');
  assert.equal(error.error.reason, 'vaultWriteFailed');
  assert.equal(source.cached(account), undefined, 'not used before it is stored');
  assert.deepEqual(vault.entries.get(account), { clientId, refreshToken });
  vault.failWrites = false;
  await source.refresh(account, io());
  assert.equal(calls[1].get('refresh_token'), '1//rotated', 'the newest refresh token is used');
  assert.deepEqual(vault.entries.get(account), { clientId, refreshToken: '1//rotated' });
});

test('a bundle replaced while the request was out (a reconnect) wins', async () => {
  const late: { vault?: MemoryVault } = {};
  const reconnectDuringRequest: Script = () => {
    late.vault!.entries.set(account, { clientId, refreshToken: '1//reconnected' });
    return ok({ refresh_token: '1//stale-rotation' })(new URLSearchParams());
  };
  const { source, vault } = setup([reconnectDuringRequest]);
  late.vault = vault;
  const error = await failure(source.refresh(account, io()));
  assert.equal(error.error.reason, 'grantChanged');
  assert.equal(source.cached(account), undefined);
  assert.deepEqual(vault.entries.get(account), { clientId, refreshToken: '1//reconnected' });
});

test('concurrent refreshes for one account share one request', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const slow: Script = async () => {
    await gate;
    return ok()(new URLSearchParams());
  };
  const { source, calls } = setup([slow]);
  const first = source.refresh(account, io());
  const second = source.refresh(account, io());
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls.length, 1);
  assert.deepEqual(a, b);
  await source.refresh(account, io());
  assert.equal(calls.length, 2, 'a settled refresh is not reused');
});

test('no token, refresh token or client secret appears in any thrown error', async () => {
  const secrets = [refreshToken, clientSecret, 'ya29.leaky'];
  const echo = `refresh_token=${refreshToken} client_secret=${clientSecret}`;
  const leakyNetwork: Script = () =>
    Promise.reject(new TypeError(`fetch failed for ${refreshToken}`, { cause: echo }));
  const scripts: Script[] = [
    oauthRefusal('invalid_grant', 400, echo),
    oauthRefusal(refreshToken, 400, echo),
    () => new Response(`<html>${echo}</html>`, { status: 502 }),
    () => new Response(`{"access_token":"ya29.leaky","expires_in":`, { status: 200 }),
    leakyNetwork,
  ];
  for (const script of scripts) {
    const { source } = setup([script]);
    const error = await failure(source.refresh(account, io()));
    assertNoSecrets(error, secrets);
  }
});

test('a bundle granted to another client is refused without a request', async () => {
  const { source, calls, vault } = setup([ok()], {
    bundle: { clientId: 'old-client.apps.googleusercontent.com', refreshToken },
  });
  const error = await failure(source.refresh(account, io()));
  assert.equal(error.error.class, 'auth');
  assert.equal(error.error.reason, 'clientMismatch');
  assert.equal(calls.length, 0, 'the other client and its secret were never used');
  assert.equal(vault.writes.length, 0);
});

test('no stored bundle is auth; no client in this build is config', async () => {
  const empty = setup([ok()], { bundle: null });
  assert.equal((await failure(empty.source.refresh(account, io()))).error.reason, 'noCredential');
  const none = setup([ok()], { client: '' });
  const error = await failure(none.source.refresh(account, io()));
  assert.equal(error.error.class, 'config');
  assert.equal(none.calls.length, 0);
});

test('granted scopes that lose the mail scope are a permission refusal', async () => {
  const { source } = setup([ok({ scope: `openid ${SCOPE.calendarEvents}` })]);
  const error = await failure(source.refresh(account, io()));
  assert.equal(error.error.class, 'permission');
  assert.deepEqual(error.error.missingScopes, [mailScope]);
  assert.match(error.message, /read and organise your Gmail/);
  assert.equal(source.cached(account), undefined);
});

test('Gmail emulator: refresh works, then day 7 in Testing mode answers invalid_grant as auth', async () => {
  const clock = new FakeClock();
  const emulator = createGmailEmulator({ clock, testingMode: true });
  emulator.oauth.addClient(clientId, clientSecret);
  emulator.addUser({ sub: 'sub-1', email: 'owner@example.test', name: 'Owner' });
  const signed = await emulator.oauth.signIn({
    clientId,
    clientSecret,
    scopes: [SCOPE.openid, SCOPE.email, mailScope],
    prompt: 'consent',
    fetch: emulator.fetch,
  });
  const vault = memoryVault({ clientId, refreshToken: signed.refreshToken! });
  const http = createHttpClient({ fetch: emulator.fetch, clock, userAgent: 'aplos-test' });
  const client = () => ({ clientId, clientSecret });
  const source = new GoogleTokenSource({ vault, http, clock, client });
  const token = await source.refresh(account, io());
  assert.ok(emulator.oauth.checkBearer(`Bearer ${token.token}`).ok);
  await clock.advance(7 * 24 * 60 * 60 * 1000);
  const error = await failure(source.refresh(account, io()));
  assert.equal(error.error.class, 'auth');
  assert.equal(error.error.reason, 'invalid_grant');
  assert.equal(source.cached(account), undefined);
  assert.equal(vault.entries.get(account)?.refreshToken, signed.refreshToken);
});
