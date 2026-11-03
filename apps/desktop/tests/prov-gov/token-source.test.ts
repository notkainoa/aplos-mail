import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { ProviderError, type RequestIo } from '@aplos/engine/ports';
import { FakeClock, createGmailEmulator, SCOPE } from '@aplos/emulators';
import { createHttpClient } from '../../src/host/providers/shared/http';
import {
  GoogleTokenSource,
  googleTokenUrl,
  tokenSkewMs,
  type GoogleTokenSourceOptions,
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
  failReads: boolean;
  /** Runs while a write is still being persisted, after the entry changed (as `main/vault.ts` orders it). */
  duringWrite?: () => void;
}

/** Like `main/vault.ts`: a refused write leaves the previous value in place. */
function memoryVault(initial?: GoogleTokenBundle): MemoryVault {
  const vault: MemoryVault = {
    entries: new Map(initial ? [[account, { ...initial }]] : []),
    writes: [],
    failWrites: false,
    failReads: false,
    get(ref) {
      if (vault.failReads) throw new Error(`keychain locked for ${refreshToken}`);
      return vault.entries.get(ref);
    },
    async set(ref, value) {
      if (vault.failWrites) throw new Error(`could not save ${value.refreshToken}`);
      vault.writes.push({ ...value });
      vault.entries.set(ref, { ...value });
      await Promise.resolve();
      vault.duringWrite?.();
    },
  };
  return vault;
}

type Script = (body: URLSearchParams) => Response | Promise<Response>;

interface ScriptedFetch {
  fetch: typeof fetch;
  calls: URLSearchParams[];
  urls: string[];
}

function scriptedFetch(...script: Script[]): ScriptedFetch {
  const calls: URLSearchParams[] = [];
  const urls: string[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = new URLSearchParams(String(init?.body ?? ''));
    urls.push(String(url));
    calls.push(body);
    const next = script[Math.min(calls.length - 1, script.length - 1)];
    return next(body);
  }) as typeof fetch;
  return { fetch: fetchFn, calls, urls };
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

/** Not the whole secret, and not its first 8 characters either (a secret cut at a length cap). */
function assertNoSecrets(error: unknown, secrets: string[]): void {
  const views = [
    String(error),
    JSON.stringify(error),
    inspect(error, { depth: 10, showHidden: true }),
  ];
  if (error instanceof Error) views.push(error.message, error.stack ?? '');
  const forms = secrets.flatMap(secret => [secret, encodeURIComponent(secret)]);
  for (const view of views) {
    for (const form of forms) assert.ok(!view.includes(form.slice(0, 8)), 'a secret leaked');
  }
}

function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>(resolve => {
    open = resolve;
  });
  return { wait, open };
}

const reconnected: GoogleTokenBundle = { clientId, refreshToken: '1//reconnected' };

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

test('cached drops a token whose grant was replaced in the vault (reconnect, more permissions)', async () => {
  const { source, vault } = setup([ok()]);
  await source.refresh(account, io());
  assert.ok(source.cached(account));
  vault.entries.set(account, reconnected);
  assert.equal(source.cached(account), undefined);
  vault.entries.set(account, { clientId, refreshToken });
  assert.equal(source.cached(account), undefined, 'a dropped token does not come back');
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

test('network failures, timeouts and 5xx are transient, keep the refresh token and drop the cache', async () => {
  const down: Script = () => Promise.reject(Object.assign(new TypeError('fetch failed'), {}));
  const hang: Script = () => new Promise<Response>(() => {});
  for (const script of [down, hang, oauthRefusal('internal_failure', 500)]) {
    const { source, vault, clock } = setup([ok(), script]);
    await source.refresh(account, io());
    assert.ok(source.cached(account));
    await clock.advance(1000);
    const error = await failure(source.refresh(account, io()));
    assert.equal(error.error.class, 'transient');
    assert.deepEqual(vault.entries.get(account), { clientId, refreshToken });
    assert.equal(source.cached(account), undefined, 'a refused or failed renewal drops the token');
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

test('aborting a hung request cancels it, keeps the bundle, and the next refresh starts afresh', async () => {
  const hang: Script = () => new Promise<Response>(() => {});
  const { source, vault, calls } = setup([hang, ok()]);
  const controller = new AbortController();
  const pending = source.refresh(account, { signal: controller.signal });
  await Promise.resolve();
  controller.abort();
  const error = await failure(pending);
  assert.equal(error.error.class, 'cancelled');
  assert.deepEqual(vault.entries.get(account), { clientId, refreshToken });
  await source.refresh(account, io());
  assert.equal(calls.length, 2);
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
  const { source, vault, calls } = setup([ok(), ok({ refresh_token: '1//rotated' }), ok()]);
  await source.refresh(account, io());
  assert.ok(source.cached(account));
  vault.failWrites = true;
  const error = await failure(source.refresh(account, io()));
  assert.equal(error.error.class, 'transient');
  assert.equal(error.error.reason, 'vaultWriteFailed');
  assertNoSecrets(error, ['1//rotated', refreshToken]);
  assert.equal(source.cached(account), undefined, 'not used before it is stored');
  assert.deepEqual(vault.entries.get(account), { clientId, refreshToken });
  vault.failWrites = false;
  await source.refresh(account, io());
  assert.equal(calls[2].get('refresh_token'), '1//rotated', 'the newest refresh token is used');
  assert.deepEqual(vault.entries.get(account), { clientId, refreshToken: '1//rotated' });
});

test('a rotated refresh token is stored even when the scope check then refuses the reply', async () => {
  const shrunk = ok({ refresh_token: '1//rotated', scope: 'openid' });
  const { source, vault } = setup([shrunk]);
  const error = await failure(source.refresh(account, io()));
  assert.equal(error.error.class, 'permission');
  assert.deepEqual(vault.entries.get(account), { clientId, refreshToken: '1//rotated' });
});

test('a bundle replaced while the request was out (a reconnect) wins', async () => {
  const late: { vault?: MemoryVault } = {};
  const reconnectDuringRequest: Script = () => {
    late.vault!.entries.set(account, reconnected);
    return ok({ refresh_token: '1//stale-rotation' })(new URLSearchParams());
  };
  const { source, vault, clock } = setup([ok(), reconnectDuringRequest]);
  late.vault = vault;
  await source.refresh(account, io());
  assert.ok(source.cached(account));
  await clock.advance(1000);
  const error = await failure(source.refresh(account, io()));
  assert.equal(error.error.reason, 'grantChanged');
  assert.equal(source.cached(account), undefined);
  assert.deepEqual(vault.entries.get(account), reconnected);
});

test('a reconnect that lands while a rotation is being written wins, and its grant is not cached', async () => {
  const { source, vault } = setup([ok({ refresh_token: '1//rotated' })]);
  vault.duringWrite = () => vault.entries.set(account, reconnected);
  const error = await failure(source.refresh(account, io()));
  assert.equal(error.error.reason, 'grantChanged');
  assert.equal(source.cached(account), undefined);
  assert.deepEqual(vault.entries.get(account), reconnected);
});

test('a reconnect after a refused rotation write wins over the unsaved token', async () => {
  const { source, vault, calls } = setup([ok({ refresh_token: '1//rotated' }), ok()]);
  vault.failWrites = true;
  await failure(source.refresh(account, io()));
  vault.failWrites = false;
  vault.entries.set(account, reconnected);
  await source.refresh(account, io());
  assert.equal(calls[1].get('refresh_token'), '1//reconnected');
  assert.deepEqual(vault.entries.get(account), reconnected);
  assert.ok(source.cached(account));
});

test('concurrent refreshes for one account share one request', async () => {
  const held = gate();
  const slow: Script = async () => {
    await held.wait;
    return ok()(new URLSearchParams());
  };
  const { source, calls } = setup([slow]);
  const first = source.refresh(account, io());
  const second = source.refresh(account, io());
  held.open();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls.length, 1);
  assert.deepEqual(a, b);
  await source.refresh(account, io());
  assert.equal(calls.length, 2, 'a settled refresh is not reused');
});

test('a caller that aborts a shared refresh does not cancel the other caller', async () => {
  const held = gate();
  const seen: AbortSignal[] = [];
  const fetchSignal = async (_url: string | URL | Request, init?: RequestInit) => {
    seen.push(init!.signal!);
    await held.wait;
    return ok()(new URLSearchParams());
  };
  const clock = new FakeClock();
  const http = createHttpClient({ fetch: fetchSignal as typeof fetch, clock, userAgent: 'a' });
  const vault = memoryVault({ clientId, refreshToken });
  const source = new GoogleTokenSource({ vault, http, clock, client: () => ({ clientId }) });
  const quitter = new AbortController();
  const first = source.refresh(account, { signal: quitter.signal });
  const second = source.refresh(account, io());
  await Promise.resolve();
  quitter.abort();
  assert.equal((await failure(first)).error.class, 'cancelled');
  assert.equal(seen[0].aborted, false, 'the shared request is still running');
  held.open();
  assert.equal((await second).token, 'ya29.access');
  assert.equal(seen.length, 1);
});

test('no token, refresh token or client secret appears in any thrown error', async () => {
  const secrets = [refreshToken, clientSecret, 'ya29.leaky'];
  const echo = `refresh_token=${refreshToken} client_secret=${clientSecret}`;
  const encoded = new URLSearchParams({
    refresh_token: refreshToken,
    client_secret: clientSecret,
  }).toString();
  const leakyNetwork: Script = () =>
    Promise.reject(new TypeError(`fetch failed for ${refreshToken}`, { cause: echo }));
  const scripts: Script[] = [
    oauthRefusal('invalid_grant', 400, echo),
    oauthRefusal(refreshToken, 400, echo),
    () => new Response(`<html>${echo}</html>`, { status: 502 }),
    // A proxy or captive portal quoting the form-encoded request it blocked.
    () => new Response(`<html><pre>POST /token\n${encoded}</pre></html>`, { status: 403 }),
    () => new Response(`blocked: ${encoded}`, { status: 400 }),
    oauthRefusal('invalid_grant', 400, encoded),
    () => new Response(`{"access_token":"ya29.leaky","expires_in":`, { status: 200 }),
    leakyNetwork,
  ];
  for (const script of scripts) {
    const { source } = setup([script]);
    const error = await failure(source.refresh(account, io()));
    assertNoSecrets(error, secrets);
  }
});

test('a body that is not an OAuth error never becomes providerMessage', async () => {
  const page = '<html><body>Access denied by your network administrator</body></html>';
  const { source } = setup([() => new Response(page, { status: 403 })]);
  const error = await failure(source.refresh(account, io()));
  assert.equal(
    error.error.providerMessage,
    'The token endpoint answered 4xx without an OAuth error.',
  );
  const oauth = setup([oauthRefusal('invalid_grant')]);
  const parsed = await failure(oauth.source.refresh(account, io()));
  assert.equal(parsed.error.providerMessage, 'Token has been expired or revoked.');
});

test('inspecting or serializing the token source shows no token', async () => {
  const { source, vault } = setup([ok(), ok({ refresh_token: '1//rotated-unsaved' })]);
  await source.refresh(account, io());
  vault.failWrites = true;
  const views = () => [JSON.stringify(source), inspect(source, { depth: 10, showHidden: true })];
  for (const view of views()) {
    assert.ok(!view.includes('ya29.access'), 'cached access token visible');
    assert.ok(!view.includes(refreshToken), 'refresh token visible');
  }
  await failure(source.refresh(account, io()));
  for (const view of views()) assert.ok(!view.includes('rotated-unsaved'), 'unsaved token visible');
});

test('the refresh always goes to Google’s token endpoint, whatever the options say', async () => {
  const scripted = scriptedFetch(ok());
  const clock = new FakeClock();
  const http = createHttpClient({ fetch: scripted.fetch, clock, userAgent: 'aplos-test' });
  const options = {
    vault: memoryVault({ clientId, refreshToken }),
    http,
    clock,
    client: () => ({ clientId, clientSecret }),
    tokenUrl: 'https://token.attacker.example/token',
  } as GoogleTokenSourceOptions;
  await new GoogleTokenSource(options).refresh(account, io());
  assert.deepEqual(scripted.urls, [googleTokenUrl]);
});

test('a secret cut by the 300-character cap leaves no part of itself behind', async () => {
  const pad = 'x'.repeat(290);
  // As is, and with one character \u-escaped so only the parsed text holds the whole secret.
  const plain = `{"error":"invalid_grant","error_description":"${pad}${refreshToken}"}`;
  const hidden = refreshToken.replace('//r', '//\\u0072');
  const escaped = `{"error":"invalid_grant","error_description":"${pad}${hidden}"}`;
  for (const body of [plain, escaped]) {
    const { source } = setup([() => new Response(body, { status: 400 })]);
    const error = await failure(source.refresh(account, io()));
    assert.equal(error.error.class, 'auth');
    assertNoSecrets(error, [refreshToken]);
  }
});

test('a provider reason that names an Object property still gets a plain sentence', async () => {
  for (const reason of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    const { source } = setup([oauthRefusal(reason)]);
    const error = await failure(source.refresh(account, io()));
    assert.equal(typeof error.message, 'string');
    assert.equal(error.message, 'Google refused to renew this account’s sign-in.');
  }
});

test('a vault that throws on read or write is a secret-free transient error', async () => {
  const reads = setup([ok()]);
  reads.vault.failReads = true;
  const readError = await failure(reads.source.refresh(account, io()));
  assert.equal(readError.error.class, 'transient');
  assert.equal(readError.error.reason, 'vaultReadFailed');
  assertNoSecrets(readError, [refreshToken]);
  assert.equal(reads.calls.length, 0);
  assert.equal(reads.source.cached(account), undefined, 'cached never throws');
  const writes = setup([ok({ refresh_token: '1//rotated' })]);
  writes.vault.failWrites = true;
  const writeError = await failure(writes.source.refresh(account, io()));
  assert.equal(writeError.error.reason, 'vaultWriteFailed');
  assertNoSecrets(writeError, ['1//rotated', refreshToken]);
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
  const { source, clock } = setup([ok(), ok({ scope: `openid ${SCOPE.calendarEvents}` })]);
  await source.refresh(account, io());
  assert.ok(source.cached(account));
  await clock.advance(1000);
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
