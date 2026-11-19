import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { FakeClock } from '../src/kit/clock';
import { SCOPE, createGmailEmulator, type GmailEmulator } from '../src/gmail';
import { result, setup } from './gmail-helpers';

const DAY = 86400_000;
const REDIRECT = 'http://127.0.0.1:53682/oauth/callback';

function fixture(options: Partial<Parameters<typeof createGmailEmulator>[0]> = {}) {
  const clock = new FakeClock();
  const emu = createGmailEmulator({ clock, latencyMs: 0, ...options });
  emu.oauth.addClient('desktop-client', 'desktop-secret');
  return { clock, emu };
}

function pkce() {
  const verifier = 'v'.repeat(43);
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

function authUrl(params: Record<string, string>): string {
  const base = {
    client_id: 'desktop-client',
    redirect_uri: REDIRECT,
    response_type: 'code',
    scope: `openid email profile ${SCOPE.gmailModify}`,
    state: 'st4te',
    code_challenge_method: 'S256',
    code_challenge: pkce().challenge,
  };
  return `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({ ...base, ...params })}`;
}

async function token(emu: GmailEmulator, fields: Record<string, string>) {
  return result(
    await emu.fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: 'desktop-client',
        client_secret: 'desktop-secret',
        ...fields,
      }),
    }),
  );
}

async function consent(
  emu: GmailEmulator,
  params: Record<string, string> = {},
  options?: { as?: string; deny?: boolean },
) {
  return new URL(emu.oauth.authorize(authUrl(params), options));
}

test('authorization: PKCE flow returns code and state, and the token response has Google fields', async () => {
  const { emu, clock } = fixture();
  const redirect = await consent(emu);
  assert.equal(redirect.origin + redirect.pathname, REDIRECT);
  assert.equal(redirect.searchParams.get('state'), 'st4te');
  assert.equal(
    redirect.searchParams.get('scope'),
    `openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile ${SCOPE.gmailModify}`,
  );

  const code = redirect.searchParams.get('code')!;
  const exchanged = await token(emu, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT,
    code_verifier: pkce().verifier,
  });
  assert.equal(exchanged.status, 200);
  const body = exchanged.json;
  assert.equal(body.expires_in, 3599);
  assert.equal(body.token_type, 'Bearer');
  assert.ok(body.access_token && body.refresh_token);
  assert.equal(body.refresh_token_expires_in, 7 * 86400, 'testing mode reports the seconds left');
  assert.equal(body.scope, redirect.searchParams.get('scope'));
  const claims = JSON.parse(Buffer.from(body.id_token.split('.')[1], 'base64url').toString());
  assert.equal(claims.email, 'test.user@example.test');
  assert.equal(claims.aud, 'desktop-client');
  assert.equal(emu.oauth.refreshTokenExpiresAt(body.refresh_token), clock.now() + 7 * DAY);

  const again = await token(emu, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT,
    code_verifier: pkce().verifier,
  });
  assert.equal(again.status, 400, 'a code works once');
  assert.equal(again.json.error, 'invalid_grant');
});

test('the authorization request is validated: client, loopback redirect with a port, response type, scope', async () => {
  const { emu } = fixture();
  const get = async (params: Record<string, string>) =>
    emu.fetch(authUrl(params), { redirect: 'manual' });

  const unknown = await get({ client_id: 'nobody' });
  assert.equal(unknown.status, 401);
  assert.throws(() => emu.oauth.authorize(authUrl({ client_id: 'nobody' })), /rejected/);
  for (const redirect_uri of [
    'https://example.test/cb',
    'http://127.0.0.1/cb',
    'http://192.168.0.2:8080/cb',
    'myapp://cb',
    'not a url',
  ]) {
    assert.equal((await get({ redirect_uri })).status, 400, redirect_uri);
  }
  for (const uri of ['http://localhost:8123/cb', 'http://[::1]:8123/cb'])
    assert.equal((await get({ redirect_uri: uri })).status, 302, uri);

  const errorOf = async (params: Record<string, string>) =>
    new URL((await get(params)).headers.get('location')!).searchParams.get('error');
  assert.equal(await errorOf({ response_type: 'token' }), 'unsupported_response_type');
  assert.equal(await errorOf({ code_challenge_method: 'S512' }), 'invalid_request');
  assert.equal(await errorOf({ scope: '' }), 'invalid_scope');
  // Google only recommends PKCE and state (native-app guide), so leaving them out still yields a code.
  assert.equal(await errorOf({ code_challenge: '', code_challenge_method: '' }), null);
  assert.equal(await errorOf({ state: '' }), null);
});

test("requirePkceAndState makes the emulator stricter than Google, for tests of the app's own sign-in", async () => {
  const { emu } = fixture({ requirePkceAndState: true });
  const errorOf = async (params: Record<string, string>) =>
    new URL(
      (await emu.fetch(authUrl(params), { redirect: 'manual' })).headers.get('location')!,
    ).searchParams.get('error');
  assert.equal(await errorOf({}), null);
  assert.equal(await errorOf({ code_challenge_method: 'plain' }), 'invalid_request');
  assert.equal(await errorOf({ code_challenge: '' }), 'invalid_request');
  assert.equal(await errorOf({ state: '' }), 'invalid_request');
});

test('PKCE is optional, and plain challenges are checked as sent', async () => {
  const { emu } = fixture();
  const none = (
    await consent(emu, { code_challenge: '', code_challenge_method: '' })
  ).searchParams.get('code')!;
  assert.equal(
    (await token(emu, { grant_type: 'authorization_code', code: none, redirect_uri: REDIRECT }))
      .status,
    200,
    'no challenge, no verifier needed',
  );
  const plain = (
    await consent(emu, { code_challenge: 'p'.repeat(43), code_challenge_method: 'plain' })
  ).searchParams.get('code')!;
  assert.equal(
    (
      await token(emu, {
        grant_type: 'authorization_code',
        code: plain,
        redirect_uri: REDIRECT,
        code_verifier: 'p'.repeat(43),
      })
    ).status,
    200,
  );
});

test('PKCE is verified at the token endpoint, and the client secret is enforced when registered', async () => {
  const { emu } = fixture();
  const code = (await consent(emu)).searchParams.get('code')!;
  const wrong = await token(emu, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT,
    code_verifier: 'x'.repeat(43),
  });
  assert.equal(wrong.json.error, 'invalid_grant');
  assert.equal(wrong.json.error_description, 'Invalid code verifier.');

  const code2 = (await consent(emu)).searchParams.get('code')!;
  const missing = await token(emu, {
    grant_type: 'authorization_code',
    code: code2,
    redirect_uri: REDIRECT,
  });
  assert.equal(missing.json.error_description, 'Missing code verifier.');

  const code3 = (await consent(emu)).searchParams.get('code')!;
  const wrongRedirect = await token(emu, {
    grant_type: 'authorization_code',
    code: code3,
    redirect_uri: 'http://127.0.0.1:1/other',
    code_verifier: pkce().verifier,
  });
  assert.equal(wrongRedirect.status, 400);
  assert.equal(
    wrongRedirect.json.error,
    'redirect_uri_mismatch',
    'a configuration fault, not a dead grant',
  );

  const code4 = (await consent(emu)).searchParams.get('code')!;
  const noSecret = await result(
    await emu.fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: 'desktop-client',
        code: code4,
        redirect_uri: REDIRECT,
        code_verifier: pkce().verifier,
      }),
    }),
  );
  assert.equal(noSecret.status, 400);
  assert.deepEqual(noSecret.json, {
    error: 'invalid_request',
    error_description: 'client_secret is missing.',
  });

  const code5 = (await consent(emu)).searchParams.get('code')!;
  const wrongSecret = await token(emu, {
    grant_type: 'authorization_code',
    code: code5,
    redirect_uri: REDIRECT,
    code_verifier: pkce().verifier,
    client_secret: 'not-the-secret',
  });
  assert.equal(wrongSecret.status, 401);
  assert.equal(wrongSecret.json.error, 'invalid_client');
});

test('login_hint picks the account; without a match the default test user signs in', async () => {
  const { emu } = fixture({
    users: [
      { sub: 's1', email: 'first@example.test', name: 'First Person' },
      { sub: 's2', email: 'second@example.test', name: 'Second Person' },
    ],
  });
  const info = async (redirect: URL) => {
    const exchanged = await token(emu, {
      grant_type: 'authorization_code',
      code: redirect.searchParams.get('code')!,
      redirect_uri: REDIRECT,
      code_verifier: pkce().verifier,
    });
    return result(
      await emu.fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { authorization: `Bearer ${exchanged.json.access_token}` },
      }),
    );
  };
  assert.deepEqual((await info(await consent(emu, { login_hint: 'second@example.test' }))).json, {
    sub: 's2',
    name: 'Second Person',
    email: 'second@example.test',
    email_verified: true,
  });
  assert.equal((await info(await consent(emu))).json.sub, 's1', 'no hint: the default user');
  assert.equal(
    (await info(await consent(emu, { login_hint: 'stranger@example.test' }))).json.sub,
    's1',
    'a hint that matches nobody: the default user',
  );
  assert.equal(
    (await info(await consent(emu, { login_hint: 's2' }))).json.sub,
    's2',
    'the sub works as a hint too',
  );
  const viaOtherHost = await emu.fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: {
      authorization: `Bearer ${(await token(emu, { grant_type: 'authorization_code', code: (await consent(emu)).searchParams.get('code')!, redirect_uri: REDIRECT, code_verifier: pkce().verifier })).json.access_token}`,
    },
  });
  assert.equal(viaOtherHost.status, 200);
});

test('in testing mode only listed test users may consent; cancel also gives access_denied', async () => {
  const { emu } = fixture({
    users: [
      { sub: 's1', email: 'listed@example.test', name: 'Listed' },
      { sub: 's2', email: 'unlisted@example.test', name: 'Unlisted', testUser: false },
    ],
  });
  assert.equal(
    (await consent(emu, { login_hint: 'listed@example.test' })).searchParams.get('error'),
    null,
  );
  const denied = await consent(emu, { login_hint: 'unlisted@example.test' });
  assert.equal(denied.searchParams.get('error'), 'access_denied');
  assert.equal(denied.searchParams.get('state'), 'st4te');
  assert.equal((await consent(emu, {}, { deny: true })).searchParams.get('error'), 'access_denied');
  assert.equal(
    (await consent(emu, {}, { as: 'nobody@example.test' })).searchParams.get('error'),
    'access_denied',
  );

  emu.oauth.testingMode = false;
  assert.ok(
    (await consent(emu, { login_hint: 'unlisted@example.test' })).searchParams.get('code'),
    'a published app accepts anyone',
  );
});

test('testing mode: the refresh token dies 7 days after consent, with Google invalid_grant text', async () => {
  const { emu, clock } = fixture();
  const exchanged = await token(emu, {
    grant_type: 'authorization_code',
    code: (await consent(emu)).searchParams.get('code')!,
    redirect_uri: REDIRECT,
    code_verifier: pkce().verifier,
  });
  const refresh = exchanged.json.refresh_token as string;
  const useRefresh = () => token(emu, { grant_type: 'refresh_token', refresh_token: refresh });

  await clock.advance(3 * DAY);
  const alive = await useRefresh();
  assert.equal(alive.status, 200);
  assert.equal(
    alive.json.refresh_token,
    undefined,
    'a refresh does not hand out a new refresh token',
  );
  assert.equal(alive.json.refresh_token_expires_in, 4 * 86400, 'the countdown keeps running');
  assert.equal(alive.json.expires_in, 3599);

  await clock.advanceTo(emu.oauth.refreshTokenExpiresAt(refresh)! - 1000);
  assert.equal((await useRefresh()).status, 200);
  await clock.advance(1000);
  const dead = await useRefresh();
  assert.equal(dead.status, 400);
  assert.deepEqual(dead.json, {
    error: 'invalid_grant',
    error_description: 'Token has been expired or revoked.',
  });
});

test('outside testing mode refresh tokens last, and no countdown is reported', async () => {
  const { emu, clock } = fixture({ testingMode: false });
  const exchanged = await token(emu, {
    grant_type: 'authorization_code',
    code: (await consent(emu)).searchParams.get('code')!,
    redirect_uri: REDIRECT,
    code_verifier: pkce().verifier,
  });
  assert.equal(exchanged.json.refresh_token_expires_in, undefined);
  await clock.advance(30 * DAY);
  assert.equal(
    (await token(emu, { grant_type: 'refresh_token', refresh_token: exchanged.json.refresh_token }))
      .status,
    200,
  );
});

test('partial grants: the token response lists only what the user ticked, and Gmail enforces it', async () => {
  const h = await setup({
    scopes: ['openid', 'email', SCOPE.gmailModify, SCOPE.gmailSettingsBasic, SCOPE.calendarEvents],
  });
  const { emu } = h;
  emu.oauth.setGrantedScopes('test.user@example.test', ['openid', 'email', SCOPE.calendarEvents]);
  const partial = await emu.oauth.signIn({
    clientId: 'test-client',
    scopes: ['openid', 'email', SCOPE.gmailModify, SCOPE.gmailSettingsBasic, SCOPE.calendarEvents],
    fetch: emu.fetch,
  });
  assert.equal(partial.scope, `openid ${SCOPE.email} ${SCOPE.calendarEvents}`);
  const refused = await h.api('/profile', { token: partial.accessToken });
  assert.equal(refused.status, 403);
  assert.equal(refused.json.error.errors[0].reason, 'insufficientPermissions');
  emu.oauth.setGrantedScopes('test.user@example.test', null);
  const full = await emu.oauth.signIn({
    clientId: 'test-client',
    scopes: [SCOPE.gmailModify],
    fetch: emu.fetch,
  });
  assert.equal((await h.api('/profile', { token: full.accessToken })).status, 200);
});

test('a repeat consent returns a refresh token again by default, and not when configured', async () => {
  const defaults = fixture();
  const exchange = async (emu: GmailEmulator, params: Record<string, string> = {}) =>
    (
      await token(emu, {
        grant_type: 'authorization_code',
        code: (await consent(emu, params)).searchParams.get('code')!,
        redirect_uri: REDIRECT,
        code_verifier: pkce().verifier,
      })
    ).json;
  assert.ok((await exchange(defaults.emu)).refresh_token);
  assert.ok((await exchange(defaults.emu)).refresh_token);

  const strict = fixture({ repeatConsentIssuesRefreshToken: false });
  assert.ok((await exchange(strict.emu)).refresh_token, 'the first consent always issues one');
  assert.equal((await exchange(strict.emu)).refresh_token, undefined);
  assert.ok(
    (await exchange(strict.emu, { prompt: 'consent' })).refresh_token,
    'prompt=consent forces a new one',
  );
});

test('admin policy: consent and refresh answer admin_policy_enforced', async () => {
  const { emu } = fixture();
  const exchanged = await token(emu, {
    grant_type: 'authorization_code',
    code: (await consent(emu)).searchParams.get('code')!,
    redirect_uri: REDIRECT,
    code_verifier: pkce().verifier,
  });
  emu.oauth.setAdminPolicy('test.user@example.test');
  const refused = await token(emu, {
    grant_type: 'refresh_token',
    refresh_token: exchanged.json.refresh_token,
  });
  assert.equal(refused.status, 400);
  assert.equal(refused.json.error, 'admin_policy_enforced');
  assert.equal((await consent(emu)).searchParams.get('error'), 'admin_policy_enforced');
  emu.oauth.setAdminPolicy('test.user@example.test', false);
  assert.equal(
    (await token(emu, { grant_type: 'refresh_token', refresh_token: exchanged.json.refresh_token }))
      .status,
    200,
  );
});

test('revoking a user kills refresh tokens and access tokens; the revoke endpoint does the same for one grant', async () => {
  const h = await setup();
  assert.equal((await h.api('/profile')).status, 200);
  h.emu.oauth.revoke('test.user@example.test');
  assert.equal((await h.api('/profile')).status, 401);
  await h.renew();
  const dead = await result(
    await h.emu.fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: h.refreshToken!,
        client_id: 'test-client',
      }),
    }),
  );
  assert.equal(dead.json.error, 'invalid_grant');

  const second = await setup();
  const revoked = await second.emu.fetch('https://oauth2.googleapis.com/revoke', {
    method: 'POST',
    body: new URLSearchParams({ token: second.refreshToken! }),
  });
  assert.equal(revoked.status, 200);
  assert.equal(
    (await second.api('/profile')).status,
    401,
    'the access token of that grant stops working too',
  );
  const unknown = await second.emu.fetch('https://oauth2.googleapis.com/revoke', {
    method: 'POST',
    body: new URLSearchParams({ token: 'unknown' }),
  });
  assert.equal(unknown.status, 400);
  const twice = await second.emu.fetch('https://oauth2.googleapis.com/revoke', {
    method: 'POST',
    body: new URLSearchParams({ token: second.refreshToken! }),
  });
  assert.equal(twice.status, 400, 'a token that is already revoked is refused');
});

test('unknown grant types are rejected', async () => {
  const h = await setup();
  const response = await result(
    await h.emu.fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      body: new URLSearchParams({ grant_type: 'password', client_id: 'test-client' }),
    }),
  );
  assert.equal(response.json.error, 'unsupported_grant_type');
});

test('oauth requests are logged without tokens or codes', async () => {
  const h = await setup();
  const text = JSON.stringify(h.emu.log);
  assert.ok(h.emu.log.some(e => e.apiMethod === 'oauth.token'));
  assert.ok(!text.includes(h.token) && !text.includes(h.refreshToken!) && !text.includes('4/emu'));
});
