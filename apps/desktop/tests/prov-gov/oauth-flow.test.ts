import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnection } from 'node:net';
import { inspect } from 'node:util';
import {
  ProviderError,
  type BoundGovernor,
  type Clock,
  type ConnectContext,
  type ConnectRequest,
  type GovernedRequest,
} from '@aplos/engine/ports';
import type { Logger } from '@aplos/engine/diag/log';
import { FakeClock, createGmailEmulator, SCOPE } from '@aplos/emulators';
import { PausedError } from '@aplos/engine/ports';
import { Governor } from '../../../../packages/engine/src/sync/governor';
import { createHttpClient } from '../../src/host/providers/shared/http';
import { resolveGoogleClient } from '../../src/host/providers/oauth/client';
import {
  createGoogleConnect,
  type GoogleConnectDeps,
} from '../../src/host/providers/oauth/connect';
import {
  reconnectAuthParams,
  testingRefreshLifetimeMs,
} from '../../src/host/providers/oauth/grant';
import { identityFromIdToken } from '../../src/host/providers/oauth/id-token';
import { decideCallback, openLoopback, sameSecret } from '../../src/host/providers/oauth/loopback';
import { challengeFor, verifierBytes } from '../../src/host/providers/oauth/pkce';
import { connectScopes, identityScopes } from '../../src/host/providers/oauth/scopes';
import type { GoogleTokenBundle, SecretVault } from '../../src/host/providers/oauth/token-source';

const clientId = 'flow-client.apps.googleusercontent.com';
const clientSecret = 'GOCSPX-flow-secret-never-shown';
const account = 'acct-flow';
const mailScope = SCOPE.gmailModify;
const oldBundle: GoogleTokenBundle = { clientId, refreshToken: '1//old-refresh-never-shown' };

// ---------- doubles ----------

/** No auto-advance: the callback arrives over a real socket, and an idle clock must not jump to the timeout. */
const manualClock = () => new FakeClock({ auto: false });

/** The port's clock over a fake one; the flow only reads the time and sleeps, and never arms a timer. */
function portClock(clock: FakeClock): Clock {
  return {
    now: () => clock.now(),
    sleep: (ms, signal) => clock.sleep(ms, signal),
    timer: () => assert.fail('the sign-in flow arms no timer'),
  };
}

interface MemoryVault extends SecretVault<GoogleTokenBundle> {
  entries: Map<string, GoogleTokenBundle>;
  writes: number;
  failWrites: boolean;
}

/** Like `main/vault.ts`: a refused write leaves the previous value in place. */
function memoryVault(initial?: GoogleTokenBundle): MemoryVault {
  const vault: MemoryVault = {
    entries: new Map(initial ? [[account, { ...initial }]] : []),
    writes: 0,
    failWrites: false,
    get: ref => vault.entries.get(ref),
    async set(ref, value) {
      if (vault.failWrites) throw new Error(`disk full while saving ${value.refreshToken}`);
      vault.writes += 1;
      vault.entries.set(ref, { ...value });
    },
  };
  return vault;
}

interface Recorder {
  governor: BoundGovernor;
  tickets: GovernedRequest[];
}

/** Pass-through governor: runs `fn` once with the caller's signal and records each ticket. */
function recordingGovernor(): Recorder {
  const tickets: GovernedRequest[] = [];
  const governor: BoundGovernor = {
    run(req, fn) {
      tickets.push(req);
      return fn({ signal: req.signal ?? new AbortController().signal });
    },
    observe() {},
    charge() {},
    batchSize: () => 1,
  };
  return { governor, tickets };
}

interface RandomLog {
  random: (size: number) => Uint8Array;
  sizes: number[];
}

function countingRandom(): RandomLog {
  const sizes: number[] = [];
  let next = 1;
  const random = (size: number) => {
    sizes.push(size);
    return Uint8Array.from({ length: size }, () => next++ % 256);
  };
  return { random, sizes };
}

const silentLog: Logger = {
  event: () => assert.fail('the sign-in flow logs nothing'),
  with: () => silentLog,
  enabled: () => false,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function idToken(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'RS256' })}.${part(claims)}.signature`;
}

function claims(clock: FakeClock, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: 'https://accounts.google.com',
    aud: clientId,
    sub: 'sub-1',
    email: 'Owner@Example.TEST',
    email_verified: true,
    name: 'Owner',
    exp: Math.floor(clock.now() / 1000) + 3600,
    ...extra,
  };
}

/** A browser that follows the consent URL straight to the loopback callback with a code and the echoed state. */
interface FakeBrowser {
  openExternal: (url: string) => Promise<void>;
  opened: URL[];
  statuses: number[];
}

type Callback = (consent: URL) => Array<Record<string, string>>;

function fakeBrowser(callback: Callback): FakeBrowser {
  const opened: URL[] = [];
  const statuses: number[] = [];
  const openExternal = async (url: string) => {
    const consent = new URL(url);
    opened.push(consent);
    for (const query of callback(consent)) {
      const target = new URL(consent.searchParams.get('redirect_uri')!);
      for (const [key, value] of Object.entries(query)) target.searchParams.set(key, value);
      statuses.push(await getStatus(target));
    }
  };
  return { openExternal, opened, statuses };
}

/** 0 when the listener is gone (connection refused). */
async function getStatus(url: URL): Promise<number> {
  try {
    const response = await fetch(url);
    await response.text();
    return response.status;
  } catch {
    return 0;
  }
}

const authCode = '4/0AflowCode-never-shown';
const echoState = (consent: URL) => consent.searchParams.get('state')!;
const withCode: Callback = consent => [{ code: authCode, state: echoState(consent) }];

interface Scripted {
  fetch: typeof fetch;
  forms: URLSearchParams[];
}

function tokenEndpoint(reply: (form: URLSearchParams) => Response | Promise<Response>): Scripted {
  const forms: URLSearchParams[] = [];
  const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
    const form = new URLSearchParams(String(init?.body ?? ''));
    forms.push(form);
    return reply(form);
  }) as typeof fetch;
  return { fetch: fetchFn, forms };
}

interface Rig {
  connect: ReturnType<typeof createGoogleConnect>;
  ctx: ConnectContext;
  abort: AbortController;
  vault: MemoryVault;
  clock: FakeClock;
  tickets: GovernedRequest[];
  random: RandomLog;
}

interface RigOptions {
  fetch: typeof fetch;
  openExternal: (url: string) => Promise<void> | void;
  clock?: FakeClock;
  vault?: MemoryVault;
  env?: Record<string, string | undefined>;
  deps?: Partial<GoogleConnectDeps>;
  /** Default: a pass-through recorder. */
  governor?: BoundGovernor;
}

function rig(options: RigOptions): Rig {
  const clock = options.clock ?? manualClock();
  const vault = options.vault ?? memoryVault();
  const recorder = recordingGovernor();
  const random = countingRandom();
  const env = options.env ?? {
    APLOS_GOOGLE_CLIENT_ID: clientId,
    APLOS_GOOGLE_CLIENT_SECRET: clientSecret,
  };
  const connect = createGoogleConnect({
    http: createHttpClient({ fetch: options.fetch, clock, userAgent: 'aplos-test' }),
    openExternal: options.openExternal,
    random: random.random,
    resolveClient: () => resolveGoogleClient({ env, bundled: {} }),
    vault,
    ...options.deps,
  });
  const abort = new AbortController();
  const ctx: ConnectContext = {
    accountId: account,
    governor: options.governor ?? recorder.governor,
    clock: portClock(clock),
    log: silentLog,
    signal: abort.signal,
  };
  return { connect, ctx, abort, vault, clock, tickets: recorder.tickets, random };
}

function tokenReply(clock: FakeClock, extra: Record<string, unknown> = {}): Response {
  return json({
    access_token: 'ya29.flow-access-never-shown',
    expires_in: 3599,
    refresh_token: '1//flow-refresh-never-shown',
    scope: `openid ${SCOPE.email} ${mailScope}`,
    id_token: idToken(claims(clock)),
    ...extra,
  });
}

/** A rig whose token endpoint answers `reply` and whose browser returns `authCode`. */
function scriptedRig(
  reply: (clock: FakeClock, form: URLSearchParams) => Response | Promise<Response>,
  options: Partial<RigOptions> = {},
): Rig & { forms: URLSearchParams[]; browser: FakeBrowser } {
  const clock = options.clock ?? manualClock();
  const endpoint = tokenEndpoint(form => reply(clock, form));
  const browser = fakeBrowser(withCode);
  const r = rig({ fetch: endpoint.fetch, openExternal: browser.openExternal, clock, ...options });
  return { ...r, forms: endpoint.forms, browser };
}

const newConnect: ConnectRequest = { mode: 'new' };

async function refusal(promise: Promise<unknown>): Promise<ProviderError> {
  const error = await promise.then(
    () => assert.fail('expected the connect to fail'),
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

function refused(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection({ port, host });
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(true));
  });
}

const portOf = (consent: URL) => Number(new URL(consent.searchParams.get('redirect_uri')!).port);

// ---------- the whole flow on the Gmail emulator ----------

function emulatorRig(options: {
  vault?: MemoryVault;
  as?: string;
  deps?: Partial<GoogleConnectDeps>;
}) {
  const revoked: string[] = [];
  const clock = manualClock();
  // The emulator waits out its latency on its own auto-advancing clock, so the flow's clock never moves by itself.
  const emulator = createGmailEmulator({
    clock: new FakeClock(),
    testingMode: true,
    requirePkceAndState: true,
    users: [],
  });
  emulator.oauth.addClient(clientId, clientSecret);
  emulator.addUser({ sub: 'sub-1', email: 'Owner@Example.TEST', name: 'Owner' });
  emulator.addUser({ sub: 'sub-2', email: 'other@example.test', name: 'Other' });
  const browser = fakeBrowser(consent => {
    const redirect = new URL(emulator.oauth.authorize(consent, { as: options.as }));
    return [Object.fromEntries(redirect.searchParams)];
  });
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith('/revoke'))
      revoked.push(new URLSearchParams(String(init?.body)).get('token')!);
    return emulator.fetch(url, init);
  }) as typeof fetch;
  const r = rig({ fetch: fetchFn, openExternal: browser.openExternal, clock, ...options });
  /** True when the emulator no longer honours the refresh token. Revokes a live one, so call it last. */
  const dead = (token: string) =>
    emulator.oauth.revokeToken(new URLSearchParams({ token })).status === 400;
  return { ...r, emulator, browser, revoked, dead };
}

test('new connect on the emulator: PKCE S256, loopback, governed exchange, identity, grant, vault', async () => {
  const r = emulatorRig({});
  const result = await r.connect(newConnect, r.ctx);
  const consent = r.browser.opened[0];
  assert.equal(r.browser.opened.length, 1);
  const q = consent.searchParams;
  assert.equal(q.get('client_id'), clientId);
  assert.equal(q.get('response_type'), 'code');
  assert.equal(q.get('code_challenge_method'), 'S256');
  assert.equal(q.get('access_type'), 'offline');
  assert.equal(q.get('prompt'), 'consent');
  assert.equal(q.get('login_hint'), null);
  assert.match(q.get('redirect_uri')!, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.deepEqual(q.get('scope')!.split(' '), [...identityScopes, mailScope]);
  assert.deepEqual(r.random.sizes.slice(0, 1), [verifierBytes]);
  assert.ok(verifierBytes >= 64);
  assert.ok(q.get('state')!.length >= 43);
  assert.equal(r.browser.statuses[0], 200);

  assert.deepEqual(result.identity, {
    subject: 'sub-1',
    address: 'owner@example.test',
    displayName: 'Owner',
  });
  assert.ok(result.grantedScopes.includes(mailScope));
  assert.equal(result.grant?.grantedAt, r.clock.now());
  assert.equal(result.grant?.client, clientId);
  assert.ok(result.grant!.refreshExpiresAt! < r.clock.now() + testingRefreshLifetimeMs);
  assert.equal(result.credentialRef, account);
  assert.equal(result.capabilities.filters, false);
  assert.equal(result.capabilities.threading, 'native');

  const stored = r.vault.entries.get(account)!;
  assert.deepEqual(Object.keys(stored).sort(), ['clientId', 'refreshToken']);
  assert.equal(stored.clientId, clientId);
  assert.ok(r.emulator.oauth.refreshTokenExpiresAt(stored.refreshToken) !== undefined);
  assert.deepEqual(
    r.tickets.map(t => [t.budget, t.kind, t.method, t.auth, t.lane, t.cost]),
    [
      ['oauth', 'write', 'oauth.token', false, 'interactive', 0],
      ['oauth', 'write', 'oauth.token', false, 'interactive', 1],
    ],
  );
  assert.equal(r.tickets[1].signal, r.ctx.signal);
  assert.ok(await refused(portOf(consent)), 'the listener closes after success');
});

test('the exchange sends the verifier behind the challenge, the same redirect_uri, and the client secret', async () => {
  const r = scriptedRig(clock => tokenReply(clock));
  await r.connect(newConnect, r.ctx);
  const consent = r.browser.opened[0].searchParams;
  const form = r.forms[0];
  assert.equal(form.get('grant_type'), 'authorization_code');
  assert.equal(form.get('code'), authCode);
  assert.equal(form.get('redirect_uri'), consent.get('redirect_uri'));
  assert.equal(challengeFor(form.get('code_verifier')!), consent.get('code_challenge'));
  assert.ok(form.get('code_verifier')!.length >= 86);
  assert.notEqual(form.get('code_verifier'), consent.get('state'));
  assert.equal(form.get('client_id'), clientId);
  assert.equal(form.get('client_secret'), clientSecret);
});

test('optional scopes are asked for only when the caller passes them; an unknown one is refused first', async () => {
  const settings = SCOPE.gmailSettingsBasic;
  const r = emulatorRig({ deps: { optionalScopes: () => [settings] } });
  const result = await r.connect(newConnect, r.ctx);
  assert.ok(r.browser.opened[0].searchParams.get('scope')!.split(' ').includes(settings));
  assert.equal(result.capabilities.filters, true);

  const bad = emulatorRig({ deps: { optionalScopes: () => ['https://mail.google.com/'] } });
  await assert.rejects(bad.connect(newConnect, bad.ctx), /Not an optional scope/);
  assert.equal(bad.browser.opened.length, 0);
  assert.throws(() => connectScopes([mailScope]), /Not an optional scope/);
});

test('reconnect: login_hint and the reconnect params, same sub accepted and the bundle replaced', async () => {
  const vault = memoryVault(oldBundle);
  const r = emulatorRig({ vault });
  const req: ConnectRequest = {
    mode: 'reconnect',
    loginHint: 'owner@example.test',
    expectedSubject: 'sub-1',
  };
  const result = await r.connect(req, r.ctx);
  const q = r.browser.opened[0].searchParams;
  for (const [key, value] of Object.entries(reconnectAuthParams('owner@example.test')))
    assert.equal(q.get(key), value);
  assert.equal(result.identity.subject, 'sub-1');
  assert.notEqual(vault.entries.get(account)?.refreshToken, oldBundle.refreshToken);
});

test('reconnect as a different Google account is refused with wrongAccount and stores nothing', async () => {
  const vault = memoryVault(oldBundle);
  const r = emulatorRig({ vault, as: 'other@example.test' });
  const req: ConnectRequest = {
    mode: 'reconnect',
    loginHint: 'owner@example.test',
    expectedSubject: 'sub-1',
  };
  const error = await refusal(r.connect(req, r.ctx));
  assert.equal(error.error.class, 'auth');
  assert.equal(error.error.reason, 'wrongAccount');
  assert.equal(
    error.message,
    'That is a different Google account. Sign in with the account you are reconnecting.',
  );
  assert.equal(vault.writes, 0);
  assert.deepEqual(vault.entries.get(account), oldBundle);
  assert.equal(r.revoked.length, 1, 'the other account’s grant is handed back');
  assert.ok(r.dead(r.revoked[0]));
});

test('a reconnect without the expected subject is refused before the browser opens', async () => {
  const r = scriptedRig(clock => tokenReply(clock));
  const error = await refusal(
    r.connect({ mode: 'grantPermissions', loginHint: 'a@b.test' }, r.ctx),
  );
  assert.equal(error.error.reason, 'noExpectedSubject');
  assert.equal(r.browser.opened.length, 0);
});

test('no client id: config noClient for the project, before any listener or browser', async () => {
  const r = scriptedRig(clock => tokenReply(clock), { env: {} });
  const error = await refusal(r.connect(newConnect, r.ctx));
  assert.equal(error.error.class, 'config');
  assert.equal(error.error.reason, 'noClient');
  assert.equal(error.scope, 'project');
  assert.equal(r.browser.opened.length, 0);
});

// ---------- the loopback listener ----------

test('openLoopback: bound to 127.0.0.1, one callback, then closed', async () => {
  const loopback = await openLoopback({
    state: 'the-state',
    clock: manualClock(),
    signal: new AbortController().signal,
  });
  assert.equal(loopback.address.address, '127.0.0.1');
  assert.equal(loopback.redirectUri, `http://127.0.0.1:${loopback.address.port}/`);
  const url = new URL(loopback.redirectUri);
  url.search = 'code=one&state=the-state';
  assert.equal(await getStatus(url), 200);
  assert.deepEqual(await loopback.outcome, { kind: 'code', code: 'one' });
  assert.ok(await refused(loopback.address.port));
  loopback.close();
});

test('the listener binds 127.0.0.1 only', async () => {
  let port = 0;
  let ipv6Refused = false;
  const r = scriptedRig(clock => tokenReply(clock), {
    openExternal: async url => {
      port = portOf(new URL(url));
      ipv6Refused = await refused(port, '::1');
      assert.equal(await refused(port), false);
      r.abort.abort();
    },
  });
  await refusal(r.connect(newConnect, r.ctx));
  assert.ok(port > 0);
  assert.ok(ipv6Refused, 'not reachable on ::1');
});

test('wrong or missing state, another path and a second request are answered 400 and ignored', async () => {
  const clock = manualClock();
  const endpoint = tokenEndpoint(() => tokenReply(clock));
  const browser = fakeBrowser((consent): Array<Record<string, string>> => {
    const state = echoState(consent);
    return [
      { code: 'injected-code', state: `${state}x` },
      { code: 'injected-code' },
      { code: authCode, state },
      { code: 'second-code', state },
    ];
  });
  const r = rig({ fetch: endpoint.fetch, openExternal: browser.openExternal, clock });
  await r.connect(newConnect, r.ctx);
  assert.deepEqual(browser.statuses.slice(0, 3), [400, 400, 200]);
  // The listener stops accepting the moment the valid callback lands: the next request finds it gone.
  assert.equal(browser.statuses[3], 0, 'a second request is refused');
  assert.deepEqual(
    endpoint.forms.map(f => f.get('code')),
    [authCode],
  );
});

test('decideCallback: settled, non-GET, other paths and bad state are 400; error and code are accepted', () => {
  const state = 'expected-state-value';
  assert.deepEqual(decideCallback('GET', `/?code=c&state=${state}`, state, true), { status: 400 });
  assert.deepEqual(decideCallback('POST', `/?code=c&state=${state}`, state, false), {
    status: 400,
  });
  assert.deepEqual(decideCallback('GET', `/x?code=c&state=${state}`, state, false), {
    status: 400,
  });
  assert.deepEqual(decideCallback('GET', `//evil/?code=c&state=${state}`, state, false), {
    status: 400,
  });
  assert.deepEqual(decideCallback('GET', '/?code=c&state=expected-state-valuf', state, false), {
    status: 400,
  });
  assert.deepEqual(decideCallback('GET', `/?code=c&state=${state}`, state, false), {
    status: 200,
    outcome: { kind: 'code', code: 'c' },
  });
  assert.deepEqual(decideCallback('GET', `/?error=access_denied&state=${state}`, state, false), {
    status: 200,
    outcome: { kind: 'error', error: 'access_denied' },
  });
  assert.equal(sameSecret('a', 'a'), true);
  assert.equal(sameSecret('a', 'ab'), false);
});

test('the wait times out after 5 minutes and closes the listener', async () => {
  let consent: URL | undefined;
  const r = scriptedRig(clock => tokenReply(clock), {
    openExternal: url => {
      consent = new URL(url);
    },
  });
  const outcome = r.connect(newConnect, r.ctx).then(
    () => 'resolved',
    (e: unknown) => e,
  );
  while (!consent) await new Promise(resolve => setImmediate(resolve));
  await r.clock.advance(5 * 60_000 - 1);
  const early = await Promise.race([
    outcome,
    new Promise(resolve => setImmediate(() => resolve('pending'))),
  ]);
  assert.equal(early, 'pending');
  await r.clock.advance(1);
  const error = await outcome;
  assert.ok(error instanceof ProviderError);
  assert.equal(error.error.class, 'cancelled');
  assert.equal(error.error.reason, 'timedOut');
  assert.ok(await refused(portOf(consent)));
});

test('abort while waiting for the browser ends the connect and closes the listener; aborted before start opens nothing', async () => {
  let consent: URL | undefined;
  const r = scriptedRig(clock => tokenReply(clock), {
    openExternal: url => {
      consent = new URL(url);
      r.abort.abort();
    },
  });
  const error = await refusal(r.connect(newConnect, r.ctx));
  assert.equal(error.error.class, 'cancelled');
  assert.equal(error.error.reason, 'aborted');
  assert.ok(await refused(portOf(consent!)));
  assert.equal(r.vault.writes, 0);

  const again = await refusal(r.connect(newConnect, r.ctx));
  assert.equal(again.error.reason, 'aborted');
  assert.equal(r.forms.length, 0);
});

test('abort during the code exchange cancels it and stores nothing', async () => {
  const r: Rig & { forms: URLSearchParams[] } = scriptedRig(
    () => new Promise<Response>(() => r.abort.abort()),
  );
  const error = await refusal(r.connect(newConnect, r.ctx));
  assert.equal(error.error.class, 'cancelled');
  assert.equal(r.forms.length, 1);
  assert.equal(r.vault.writes, 0);
});

test('Google’s access_denied redirect is cancelled; other redirect errors are auth with a sanitized reason', async () => {
  const deny = emulatorRig({});
  deny.emulator.oauth.setAdminPolicy('sub-1');
  const blocked = await refusal(deny.connect(newConnect, deny.ctx));
  assert.equal(blocked.error.class, 'auth');
  assert.equal(blocked.error.reason, 'admin_policy_enforced');

  const clock = manualClock();
  const browser = fakeBrowser(consent => [{ error: 'access_denied', state: echoState(consent) }]);
  const r = rig({
    fetch: tokenEndpoint(() => tokenReply(clock)).fetch,
    openExternal: browser.openExternal,
    clock,
  });
  const error = await refusal(r.connect(newConnect, r.ctx));
  assert.equal(error.error.class, 'cancelled');
  assert.equal(error.error.reason, 'access_denied');
  assert.ok(await refused(portOf(browser.opened[0])));

  const odd = fakeBrowser(consent => [{ error: '<script>x</script>', state: echoState(consent) }]);
  const r2 = rig({
    fetch: tokenEndpoint(() => tokenReply(clock)).fetch,
    openExternal: odd.openExternal,
    clock,
  });
  assert.equal((await refusal(r2.connect(newConnect, r2.ctx))).error.reason, 'unknown');
});

test('openExternal failing is browserFailed and closes the listener', async () => {
  let consent: URL | undefined;
  const r = scriptedRig(clock => tokenReply(clock), {
    openExternal: url => {
      consent = new URL(url);
      throw new Error(`no browser for ${url}`);
    },
  });
  const error = await refusal(r.connect(newConnect, r.ctx));
  assert.equal(error.error.reason, 'browserFailed');
  assert.ok(!error.message.includes('code_challenge'));
  assert.ok(await refused(portOf(consent!)));
});

// ---------- after the exchange ----------

test('a token response without a refresh token is a failed connect that stores nothing', async () => {
  const vault = memoryVault(oldBundle);
  const r = scriptedRig(clock => tokenReply(clock, { refresh_token: undefined }), { vault });
  const req: ConnectRequest = { mode: 'reconnect', expectedSubject: 'sub-1' };
  const error = await refusal(r.connect(req, r.ctx));
  assert.equal(error.error.reason, 'noRefreshToken');
  assert.equal(vault.writes, 0);
  assert.deepEqual(vault.entries.get(account), oldBundle);
});

test('a grant without the mail scope is permission missingRequiredScope and stores nothing', async () => {
  const r = emulatorRig({});
  r.emulator.oauth.setGrantedScopes('sub-1', [SCOPE.openid, SCOPE.email, SCOPE.profile]);
  const error = await refusal(r.connect(newConnect, r.ctx));
  assert.equal(error.error.class, 'permission');
  assert.equal(error.error.reason, 'missingRequiredScope');
  assert.deepEqual(error.error.missingScopes, [mailScope]);
  assert.equal(r.vault.writes, 0);
  assert.equal(r.revoked.length, 1, 'the partial grant is handed back');
  assert.ok(r.dead(r.revoked[0]));
});

test('a failed revoke is swallowed: the refusal still surfaces, without the token', async () => {
  const r = scriptedRig((clock, form) =>
    form.has('token')
      ? Promise.reject(new Error(`revoke failed for ${form.get('token')}`))
      : tokenReply(clock, { scope: 'openid' }),
  );
  const error = await refusal(r.connect(newConnect, r.ctx));
  assert.equal(error.error.reason, 'missingRequiredScope');
  assert.equal(r.forms.at(-1)?.get('token'), '1//flow-refresh-never-shown');
  assertNoSecrets(error, ['1//flow-refresh-never-shown']);
});

test('a bad id_token fails the connect and stores nothing', async () => {
  const r = scriptedRig(clock =>
    tokenReply(clock, { id_token: idToken(claims(clock, { aud: 'someone-else' })) }),
  );
  const error = await refusal(r.connect(newConnect, r.ctx));
  assert.equal(error.error.reason, 'invalidIdToken');
  assert.equal(error.error.providerMessage, 'id_token claim refused: aud');
  assert.equal(r.vault.writes, 0);
});

test('id_token claims: issuer, audience, expiry, sub, email and email_verified', () => {
  const clock = manualClock();
  const check = { clientId, now: clock.now() };
  const reason = (extra: Record<string, unknown>) => {
    try {
      identityFromIdToken(idToken(claims(clock, extra)), check);
      return 'accepted';
    } catch (error) {
      return (error as ProviderError).error.providerMessage;
    }
  };
  assert.equal(reason({ iss: 'accounts.google.com' }), 'accepted');
  assert.equal(reason({ email_verified: undefined }), 'accepted');
  assert.equal(reason({ iss: 'https://evil.example' }), 'id_token claim refused: iss');
  assert.equal(reason({ aud: [clientId] }), 'id_token claim refused: aud');
  assert.equal(reason({ exp: Math.floor(clock.now() / 1000) }), 'id_token claim refused: exp');
  assert.equal(reason({ sub: '' }), 'id_token claim refused: sub');
  assert.equal(reason({ email: undefined }), 'id_token claim refused: email');
  assert.equal(reason({ email_verified: false }), 'id_token claim refused: email_verified');
  assert.throws(() => identityFromIdToken('not-a-jwt', check), /did not identify/);
  assert.deepEqual(identityFromIdToken(idToken(claims(clock, { name: undefined })), check), {
    subject: 'sub-1',
    address: 'owner@example.test',
  });
});

test('a vault failure on reconnect fails it and leaves the old, still working bundle intact', async () => {
  const r = emulatorRig({});
  await r.connect(newConnect, r.ctx);
  const before = { ...r.vault.entries.get(account)! };
  r.vault.failWrites = true;
  const req: ConnectRequest = { mode: 'reconnect', expectedSubject: 'sub-1' };
  const error = await refusal(r.connect(req, r.ctx));
  assert.equal(error.error.class, 'transient');
  assert.equal(error.error.reason, 'vaultWriteFailed');
  assert.deepEqual(r.vault.entries.get(account), before);
  assert.equal(r.vault.writes, 1);
  assert.equal(r.dead(before.refreshToken), false, 'the old grant still works');
  assertNoSecrets(error, [before.refreshToken]);
});

test('a refused exchange is classified, and no code, verifier, secret or token reaches the error', async () => {
  let verifier = '';
  const r = scriptedRig((_clock, form) => {
    verifier = form.get('code_verifier')!;
    const echo = `bad code ${form.get('code')} verifier ${verifier} secret ${form.get('client_secret')}`;
    return json({ error: 'invalid_grant', error_description: echo }, 400);
  });
  const error = await refusal(r.connect(newConnect, r.ctx));
  assert.equal(error.error.class, 'auth');
  assert.equal(error.error.reason, 'invalid_grant');
  assert.equal(error.error.method, 'oauth.token');
  assert.equal(error.message, 'Google did not accept this sign-in. Try connecting again.');
  assertNoSecrets(error, [authCode, verifier, clientSecret]);
  assert.equal(r.vault.writes, 0);
});

test('no failure carries a secret: malformed body, transport error, token endpoint 500', async () => {
  const answers: Array<() => Response | Promise<Response>> = [
    () => new Response(`not json ${authCode}`, { status: 200 }),
    () => Promise.reject(new Error(`socket hang up ${authCode}`)),
    () => new Response(`<html>${clientSecret}</html>`, { status: 500 }),
  ];
  for (const answer of answers) {
    const r = scriptedRig(() => answer());
    const error = await refusal(r.connect(newConnect, r.ctx));
    assert.equal(error.error.class, 'transient');
    assertNoSecrets(error, [authCode, clientSecret]);
    assert.equal(r.vault.writes, 0);
  }
});

// ---------- scopes across reconnects ----------

const settingsScope = SCOPE.gmailSettingsBasic;
const optionalAll = [settingsScope, SCOPE.calendarList, SCOPE.calendarEvents];
const askedScopes = (r: { browser: FakeBrowser }) =>
  r.browser.opened[0].searchParams.get('scope')!.split(' ');

test('a reconnect asks again for the optional scopes the stored grant holds', async () => {
  const held = ['openid', SCOPE.email, mailScope, settingsScope, SCOPE.calendarEvents];
  const r = emulatorRig({ vault: memoryVault(oldBundle), deps: { grantedScopes: () => held } });
  const result = await r.connect({ mode: 'reconnect', expectedSubject: 'sub-1' }, r.ctx);
  assert.deepEqual(askedScopes(r), [
    ...identityScopes,
    mailScope,
    settingsScope,
    SCOPE.calendarEvents,
  ]);
  assert.ok(result.grantedScopes.includes(settingsScope));
  assert.equal(result.capabilities.filters, true);
});

test('grantPermissions asks for every optional scope, or the ones the caller names', async () => {
  const held = [mailScope];
  const all = emulatorRig({ vault: memoryVault(oldBundle), deps: { grantedScopes: () => held } });
  const req: ConnectRequest = { mode: 'grantPermissions', expectedSubject: 'sub-1' };
  const result = await all.connect(req, all.ctx);
  assert.deepEqual(askedScopes(all), [...identityScopes, mailScope, ...optionalAll]);
  for (const scope of optionalAll) assert.ok(result.grantedScopes.includes(scope));

  const named = emulatorRig({
    vault: memoryVault(oldBundle),
    deps: {
      grantedScopes: () => [mailScope, SCOPE.calendarList],
      optionalScopes: () => [settingsScope],
    },
  });
  await named.connect(req, named.ctx);
  assert.deepEqual(askedScopes(named), [
    ...identityScopes,
    mailScope,
    SCOPE.calendarList,
    settingsScope,
  ]);
});

// ---------- with the real governor ----------

function governed(clock: FakeClock) {
  const governor = new Governor({ clock, random: () => 0, role: 'primary' });
  return { governor, connectGovernor: governor.bindConnect(account) };
}

const tokenRefusal = (cls: string, reason: string) => ({
  class: cls,
  provider: 'oauth',
  method: 'oauth.token',
  reason,
});

test('a paused token endpoint is found before the browser opens, not after consent', async () => {
  const clock = manualClock();
  const { governor, connectGovernor } = governed(clock);
  governor.bind(account).observe('oauth', tokenRefusal('throttle', 'rateLimitExceeded'));
  const r = scriptedRig(c => tokenReply(c), { clock, governor: connectGovernor });
  const error = await r.connect(newConnect, r.ctx).then(
    () => assert.fail('expected a pause'),
    (e: unknown) => e,
  );
  assert.ok(error instanceof PausedError, String(error));
  assert.equal(r.browser.opened.length, 0);
  assert.equal(r.forms.length, 0);
});

test('an account blocked for reauth can still reconnect: connect ignores the auth block', async () => {
  const clock = manualClock();
  const { governor, connectGovernor } = governed(clock);
  governor
    .bind(account)
    .observe('gmail', { ...tokenRefusal('auth', 'invalid_grant'), provider: 'gmail' });
  assert.equal(governor.admission(account, 'gmail', 'interactive', 'read').ok, false);
  const r = scriptedRig(c => tokenReply(c), { clock, governor: connectGovernor });
  const result = await r.connect({ mode: 'reconnect', expectedSubject: 'sub-1' }, r.ctx);
  assert.equal(result.identity.subject, 'sub-1');
});

test('a failed code exchange or a declined consent leaves a connected account’s status unchanged', async () => {
  for (const reason of ['invalid_grant', 'access_denied']) {
    const clock = manualClock();
    const { governor, connectGovernor } = governed(clock);
    const r = scriptedRig(() => json({ error: reason, error_description: 'Bad Request' }, 400), {
      clock,
      governor: connectGovernor,
    });
    const error = await refusal(r.connect({ mode: 'reconnect', expectedSubject: 'sub-1' }, r.ctx));
    assert.equal(error.error.class, 'auth');
    assert.equal(governor.admission(account, 'gmail', 'interactive', 'read').ok, true, reason);
    assert.ok(
      governor.snapshot(account).every(snap => !snap.blocked),
      reason,
    );
  }
  const clock = manualClock();
  const { governor, connectGovernor } = governed(clock);
  const browser = fakeBrowser(consent => [{ error: 'access_denied', state: echoState(consent) }]);
  const fetchFn = tokenEndpoint(() => tokenReply(clock)).fetch;
  const r = rig({
    fetch: fetchFn,
    openExternal: browser.openExternal,
    clock,
    governor: connectGovernor,
  });
  await refusal(r.connect({ mode: 'reconnect', expectedSubject: 'sub-1' }, r.ctx));
  assert.equal(governor.admission(account, 'gmail', 'interactive', 'read').ok, true);
});

test('control: the same refused exchange on the non-connect binding would block the account', async () => {
  const clock = manualClock();
  const { governor } = governed(clock);
  const r = scriptedRig(() => json({ error: 'invalid_grant' }, 400), {
    clock,
    governor: governor.bind(account),
  });
  await refusal(r.connect(newConnect, r.ctx));
  assert.equal(governor.admission(account, 'gmail', 'interactive', 'read').ok, false);
});
