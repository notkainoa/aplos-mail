import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderError, type ConnectRequest } from '@aplos/engine/ports';
import { FakeClock, SCOPE } from '@aplos/emulators';
import { PausedError } from '@aplos/engine/ports';
import { Governor } from '../../../../packages/engine/src/sync/governor';
import {
  reconnectAuthParams,
  testingRefreshLifetimeMs,
} from '../../src/host/providers/oauth/grant';
import { identityFromIdToken } from '../../src/host/providers/oauth/id-token';
import { decideCallback, openLoopback, sameSecret } from '../../src/host/providers/oauth/loopback';
import { challengeFor, verifierBytes } from '../../src/host/providers/oauth/pkce';
import {
  connectScopes,
  explicitScopes,
  googleScopeManifest,
  googleScopeParam,
  identityScopes,
  scopesForFeatures,
} from '../../src/host/providers/oauth/scopes';
import { googleCapabilities } from '../../src/host/providers/oauth/connect';
import {
  clientId,
  clientSecret,
  account,
  mailScope,
  oldBundle,
  manualClock,
  memoryVault,
  json,
  idToken,
  claims,
  type FakeBrowser,
  fakeBrowser,
  getStatus,
  authCode,
  echoState,
  tokenEndpoint,
  type Rig,
  rig,
  tokenReply,
  scriptedRig,
  newConnect,
  refusal,
  assertNoSecrets,
  refused,
  portOf,
  emulatorRig,
} from './flow-rig';

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
  const r = emulatorRig({
    vault,
    as: 'other@example.test',
    deps: { knownSubject: () => false },
  });
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
  assert.equal(
    r.revoked.length,
    0,
    'a new connect’s user may be an account Aplos holds: never revoked',
  );
});

test('a failed revoke is swallowed: the refusal still surfaces, without the token', async () => {
  const r = scriptedRig(
    (clock, form) =>
      form.has('token')
        ? Promise.reject(new Error(`revoke failed for ${form.get('token')}`))
        : tokenReply(clock),
    { deps: { knownSubject: () => false } },
  );
  const error = await refusal(r.connect({ mode: 'reconnect', expectedSubject: 'sub-9' }, r.ctx));
  assert.equal(error.error.reason, 'wrongAccount');
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
  assert.equal(reason({ email_verified: undefined }), 'id_token claim refused: email_verified');
  assert.equal(reason({ email_verified: 'true' }), 'id_token claim refused: email_verified');
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
const eventsReadonly = SCOPE.calendarEventsReadonly;
const eventsWrite = SCOPE.calendarEvents;
/** Every optional scope a flow may ask in round 1: the deferred `calendar.events` write scope is never one. */
const optionalAll = [settingsScope, SCOPE.calendarList, eventsReadonly];
const askedScopes = (r: { browser: FakeBrowser }) =>
  r.browser.opened[0].searchParams.get('scope')!.split(' ');

test('the calendar capability needs the list scope plus an events scope; each alone reads false', () => {
  assert.equal(googleCapabilities([mailScope]).calendar, false);
  assert.equal(googleCapabilities([mailScope, SCOPE.calendarList]).calendar, false);
  assert.equal(googleCapabilities([mailScope, eventsReadonly]).calendar, false);
  assert.equal(googleCapabilities([mailScope, SCOPE.calendarList, eventsReadonly]).calendar, true);
  // A held write scope covers reads (least privilege asks the read-only pair, but grants can hold either).
  assert.equal(googleCapabilities([mailScope, SCOPE.calendarList, eventsWrite]).calendar, true);
});

test('scopesForFeatures names the optional scopes of a feature', () => {
  assert.deepEqual(scopesForFeatures('calendarList', 'calendarEvents'), [
    SCOPE.calendarList,
    eventsReadonly,
  ]);
  assert.deepEqual(scopesForFeatures('calendarEventsWrite'), [eventsWrite]);
  assert.deepEqual(scopesForFeatures('filters'), [settingsScope]);
  assert.deepEqual(scopesForFeatures('mail'), []);
});

test('an optionalScopes answer of undefined keeps the mode default', async () => {
  const none = emulatorRig({ deps: { optionalScopes: () => undefined } });
  const result = await none.connect(newConnect, none.ctx);
  assert.deepEqual(askedScopes(none), [...identityScopes, mailScope]);
  assert.equal(result.capabilities.calendar, false);

  // The composition's choice: calendar scopes on a new sign-in (the onboarding copy says so).
  const cal = emulatorRig({
    deps: {
      optionalScopes: req =>
        req.mode === 'new' ? scopesForFeatures('calendarList', 'calendarEvents') : undefined,
    },
  });
  const granted = await cal.connect(newConnect, cal.ctx);
  assert.deepEqual(askedScopes(cal), [
    ...identityScopes,
    mailScope,
    SCOPE.calendarList,
    eventsReadonly,
  ]);
  assert.equal(granted.capabilities.calendar, true);
});

test('grantPermissions asks every requestable optional scope — never the deferred write scope', async () => {
  const r = emulatorRig({
    vault: memoryVault(oldBundle),
    deps: { grantedScopes: () => [mailScope], optionalScopes: () => undefined },
  });
  const result = await r.connect({ mode: 'grantPermissions', expectedSubject: 'sub-1' }, r.ctx);
  assert.deepEqual(askedScopes(r), [...identityScopes, mailScope, ...optionalAll]);
  assert.ok(!askedScopes(r).includes(eventsWrite));
  assert.equal(result.capabilities.calendar, true);
  assert.equal(result.capabilities.filters, true);
});

test('a reconnect asks again for the optional scopes the stored grant holds', async () => {
  // A HELD deferred scope (calendar.events) is still re-asked — it is never newly requested, never dropped.
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

test('grantPermissions asks for every requestable scope, or the ones the caller names', async () => {
  const held = [mailScope];
  const all = emulatorRig({ vault: memoryVault(oldBundle), deps: { grantedScopes: () => held } });
  const req: ConnectRequest = { mode: 'grantPermissions', expectedSubject: 'sub-1' };
  const result = await all.connect(req, all.ctx);
  assert.deepEqual(askedScopes(all), [...identityScopes, mailScope, ...optionalAll]);
  assert.ok(!askedScopes(all).includes(eventsWrite));
  for (const scope of optionalAll) assert.ok(result.grantedScopes.includes(scope));

  // A grant that somehow already holds the deferred write scope keeps it (never silently dropped), but the
  // re-grant still does not newly ask for it.
  const holdsWrite = emulatorRig({
    vault: memoryVault(oldBundle),
    deps: { grantedScopes: () => [mailScope, eventsWrite] },
  });
  await holdsWrite.connect(req, holdsWrite.ctx);
  assert.deepEqual(askedScopes(holdsWrite), [
    ...identityScopes,
    mailScope,
    eventsWrite,
    ...optionalAll,
  ]);

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

test('Enable editing: an explicit re-grant adds the write scope and the calendar list, and nothing else', async () => {
  const held = [mailScope, eventsReadonly, SCOPE.calendarList];
  const r = emulatorRig({
    vault: memoryVault(oldBundle),
    deps: { grantedScopes: () => held, optionalScopes: () => undefined },
  });
  const result = await r.connect(
    { mode: 'grantPermissions', expectedSubject: 'sub-1', enable: 'calendarWrite' },
    r.ctx,
  );
  // Held scopes are kept; the opt-in adds the write scope only. Gmail filters (not held, not asked for) stay out.
  assert.deepEqual(askedScopes(r), [
    ...identityScopes,
    mailScope,
    SCOPE.calendarList,
    eventsReadonly,
    eventsWrite,
  ]);
  assert.ok(!askedScopes(r).includes(settingsScope));
  assert.ok(result.grantedScopes.includes(eventsWrite));
  assert.equal(result.capabilities.calendar, true);
  assert.equal(result.capabilities.filters, false);
});

test('the write scope is asked for by nothing but the explicit opt-in on a re-grant', async () => {
  const held = [mailScope, SCOPE.calendarList, eventsReadonly];
  const attempts: { label: string; req: ConnectRequest }[] = [
    { label: 'new', req: { mode: 'new', enable: 'calendarWrite' } },
    {
      label: 'reconnect',
      req: { mode: 'reconnect', expectedSubject: 'sub-1', enable: 'calendarWrite' },
    },
    { label: 'plain re-grant', req: { mode: 'grantPermissions', expectedSubject: 'sub-1' } },
  ];
  for (const { label, req } of attempts) {
    const r = emulatorRig({
      vault: memoryVault(oldBundle),
      deps: { grantedScopes: () => held, optionalScopes: () => undefined },
    });
    await r.connect(req, r.ctx);
    assert.ok(!askedScopes(r).includes(eventsWrite), `${label} must not ask for the write scope`);
  }
});

test('an opt-in this build does not know is refused before Google is asked', async () => {
  const r = emulatorRig({
    vault: memoryVault(oldBundle),
    deps: { grantedScopes: () => [mailScope] },
  });
  const req = {
    mode: 'grantPermissions',
    expectedSubject: 'sub-1',
    enable: 'everything',
  } as unknown as ConnectRequest;
  await assert.rejects(r.connect(req, r.ctx), /Not a known opt-in/);
  assert.equal(r.browser.opened.length, 0);
});

test('the write scope stays deferred in the manifest and is explicit-only', () => {
  const entry = googleScopeManifest.find(e => e.scope === eventsWrite);
  assert.equal(entry?.deferred, true);
  assert.equal(entry?.required, false);
  assert.ok(!googleScopeParam().split(' ').includes(eventsWrite));
  assert.deepEqual(explicitScopes('calendarWrite'), [SCOPE.calendarList, eventsWrite]);
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
