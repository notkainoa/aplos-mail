// The Integrator's binding conditions for wiring the sign-in into the Gmail adapter (#72 notes, a..e), the #69
// hardening, and the host construction. Each WIRE test fails on the code merged in #72.

import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { inspect } from 'node:util';
import type { BoundGovernor, ConnectRequest, GovernedRequest } from '@aplos/engine/ports';
import type { FakeClock } from '@aplos/emulators';
import { Governor } from '../../../../packages/engine/src/sync/governor';
import { NotInThisLaneError, createGoogleProvider } from '../../src/host/providers/google/adapter';
import { checkConsentUrl, googleAuthUrl } from '../../src/host/providers/oauth/flow';
import { createGoogleHostConnect } from '../../src/host/providers/oauth/host-connect';
import { loopbackHostAllowed, openLoopback } from '../../src/host/providers/oauth/loopback';
import { createHttpClient } from '../../src/host/providers/shared/http';
import { GoogleTokenSource } from '../../src/host/providers/oauth/token-source';
import {
  account,
  claims,
  clientId,
  clientSecret,
  emulatorRig,
  idToken,
  manualClock,
  memoryVault,
  newConnect,
  oldBundle,
  portOf,
  refusal,
  refused,
  scriptedRig,
  tokenReply,
  withCode,
  fakeBrowser,
  tokenEndpoint,
  type MemoryVault,
} from './flow-rig';

const newRefresh = '1//flow-refresh-never-shown';
const newAccess = 'ya29.flow-access-never-shown';

/** The tokens the connect handed to Google's revoke endpoint. */
const revokedIn = (forms: URLSearchParams[]) =>
  forms.filter(f => f.has('token')).map(f => f.get('token'));

/** Fails the test instead of hanging when `promise` does not settle in `ms` of real time. */
function within<T>(promise: Promise<T>, ms = 2_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`still pending after ${ms} ms`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** Pass-through governor whose `oauth.token` exchange aborts `controller` as it returns (a late cancel). */
function abortAfterExchange(controller: AbortController): BoundGovernor {
  return {
    async run(req: GovernedRequest, fn) {
      const out = await fn({ signal: req.signal ?? new AbortController().signal });
      if (req.method === 'oauth.token' && req.cost === 1) controller.abort();
      return out;
    },
    observe() {},
    charge() {},
    batchSize: () => 1,
  };
}

/** A governor that never forwards the cancel to the request (a stuck transport): the exchange lands after it. */
function deafGovernor(): BoundGovernor {
  return {
    run: (_req, fn) => fn({ signal: new AbortController().signal }),
    observe() {},
    charge() {},
    batchSize: () => 1,
  };
}

// ---------- (a) a reconnect without a subject is held to its address ----------

test('WIRE-a reconnect with only an address: the same address in another case is accepted', async () => {
  const vault = memoryVault(oldBundle);
  const r = emulatorRig({ vault });
  const req: ConnectRequest = { mode: 'reconnect', address: ' OWNER@example.test ' };
  const result = await r.connect(req, r.ctx);
  assert.equal(result.identity.address, 'owner@example.test');
  assert.notEqual(vault.entries.get(account)?.refreshToken, oldBundle.refreshToken);
});

test('WIRE-a reconnect with only an address: another account is wrongAccount, stores nothing, revoked', async () => {
  const vault = memoryVault(oldBundle);
  const r = emulatorRig({ vault, as: 'other@example.test' });
  const error = await refusal(
    r.connect({ mode: 'reconnect', address: 'owner@example.test' }, r.ctx),
  );
  assert.equal(error.error.reason, 'wrongAccount');
  assert.equal(vault.writes, 0);
  assert.deepEqual(vault.entries.get(account), oldBundle);
  assert.equal(r.revoked.length, 1);
});

test('WIRE-a an address match needs email_verified === true; a new connect that names an address is held to it', async () => {
  const unverified = scriptedRig(clock =>
    tokenReply(clock, { id_token: idToken(claims(clock, { email_verified: undefined })) }),
  );
  const req: ConnectRequest = { mode: 'reconnect', address: 'owner@example.test' };
  const error = await refusal(unverified.connect(req, unverified.ctx));
  assert.equal(error.error.reason, 'invalidIdToken');
  assert.equal(error.error.providerMessage, 'id_token claim refused: email_verified');
  assert.equal(unverified.vault.writes, 0);

  const other = scriptedRig(clock => tokenReply(clock));
  const retry = await refusal(
    other.connect({ mode: 'new', address: 'else@example.test' }, other.ctx),
  );
  assert.equal(retry.error.reason, 'wrongAccount');
  assert.equal(other.vault.writes, 0);
});

// ---------- (b) only a grant provably another user's is revoked; discardCredential ----------

const reconnectSub1: ConnectRequest = { mode: 'reconnect', expectedSubject: 'sub-1' };

test('WIRE-b a reconnect answered by another subject is revoked, even with a bad id_token or no refresh token', async () => {
  const foreign = scriptedRig(clock => tokenReply(clock));
  const wrong = await refusal(
    foreign.connect({ mode: 'reconnect', expectedSubject: 'sub-9' }, foreign.ctx),
  );
  assert.equal(wrong.error.reason, 'wrongAccount');
  assert.deepEqual(revokedIn(foreign.forms), [newRefresh]);

  const bad = scriptedRig(clock =>
    tokenReply(clock, { id_token: idToken(claims(clock, { sub: 'sub-9', aud: 'someone-else' })) }),
  );
  assert.equal((await refusal(bad.connect(reconnectSub1, bad.ctx))).error.reason, 'invalidIdToken');
  assert.deepEqual(revokedIn(bad.forms), [newRefresh]);

  const noRefresh = scriptedRig(clock =>
    tokenReply(clock, {
      refresh_token: undefined,
      id_token: idToken(claims(clock, { sub: 'sub-9' })),
    }),
  );
  const error = await refusal(noRefresh.connect(reconnectSub1, noRefresh.ctx));
  assert.equal(error.error.reason, 'noRefreshToken');
  assert.deepEqual(
    revokedIn(noRefresh.forms),
    [newAccess],
    'the access token takes its grant with it',
  );
});

test('WIRE-b a same-subject refusal makes no revoke call: bad id_token, no refresh token, missing scope', async () => {
  const replies = [
    (clock: FakeClock) =>
      tokenReply(clock, { id_token: idToken(claims(clock, { aud: 'someone-else' })) }),
    (clock: FakeClock) => tokenReply(clock, { refresh_token: undefined }),
    (clock: FakeClock) => tokenReply(clock, { scope: 'openid' }),
  ];
  for (const reply of replies) {
    const vault = memoryVault(oldBundle);
    const r = scriptedRig(reply, { vault });
    await refusal(r.connect(reconnectSub1, r.ctx));
    assert.deepEqual(revokedIn(r.forms), []);
    assert.deepEqual(vault.entries.get(account), oldBundle);
  }
});

test('WIRE-b a new connect is never revoked, not even for another address or a bad id_token', async () => {
  const replies = [
    (clock: FakeClock) => tokenReply(clock),
    (clock: FakeClock) =>
      tokenReply(clock, { id_token: idToken(claims(clock, { sub: 'sub-9', aud: 'x' })) }),
  ];
  for (const reply of replies) {
    const r = scriptedRig(reply);
    await refusal(r.connect({ mode: 'new', address: 'else@example.test' }, r.ctx));
    assert.deepEqual(revokedIn(r.forms), []);
    assert.equal(r.vault.writes, 0);
  }
});

test('WIRE-b a cancel as the exchange returns, or a vault failure, stores nothing and revokes nothing', async () => {
  const controller = new AbortController();
  const r = scriptedRig(clock => tokenReply(clock), { governor: abortAfterExchange(controller) });
  r.ctx.signal = controller.signal;
  const error = await refusal(r.connect(reconnectSub1, r.ctx));
  assert.equal(error.error.reason, 'aborted');
  assert.equal(r.vault.writes, 0);
  assert.deepEqual(revokedIn(r.forms), []);

  const vault = memoryVault(oldBundle);
  vault.failWrites = true;
  const failed = scriptedRig(clock => tokenReply(clock), { vault });
  const write = await refusal(failed.connect(reconnectSub1, failed.ctx));
  assert.equal(write.error.reason, 'vaultWriteFailed');
  assert.deepEqual(vault.entries.get(account), oldBundle);
  assert.deepEqual(revokedIn(failed.forms), []);
});

function hostConnect(
  vault: MemoryVault,
  fetchFn: typeof fetch,
  open: (url: string) => Promise<void>,
) {
  return createGoogleHostConnect({
    http: createHttpClient({ fetch: fetchFn, clock: manualClock(), userAgent: 'aplos-test' }),
    openExternal: open,
    clientInputs: () => ({
      env: { APLOS_GOOGLE_CLIENT_ID: clientId, APLOS_GOOGLE_CLIENT_SECRET: clientSecret },
      bundled: {},
    }),
    vault,
  });
}

test('WIRE-b the factory’s discardCredential deletes the vault entry; without the host there is none', async () => {
  const vault = memoryVault(oldBundle);
  vault.entries.set('acct-new', { clientId, refreshToken: '1//late' });
  const host = hostConnect(vault, fetch, async () => undefined);
  const factory = createGoogleProvider({ fetch, ...host });
  await factory.discardCredential!('acct-new');
  assert.deepEqual(vault.deletes, ['acct-new']);
  assert.equal(vault.entries.has('acct-new'), false);
  assert.deepEqual(vault.entries.get(account), oldBundle, 'another account’s bundle is untouched');
  await factory.discardCredential!('never-stored');

  const bare = createGoogleProvider({ fetch });
  assert.equal(bare.discardCredential, undefined, 'fails closed in the engine');
  await assert.rejects(bare.connect(newConnect, {} as never), NotInThisLaneError);
});

// ---------- (c) a cancel during the vault write ----------

test('WIRE-c a cancel during vault.set on a new connect deletes what it wrote', async () => {
  const vault = memoryVault();
  const r = scriptedRig(clock => tokenReply(clock), { vault });
  vault.duringSet = () => r.abort.abort();
  const error = await refusal(r.connect(newConnect, r.ctx));
  assert.equal(error.error.reason, 'aborted');
  assert.equal(vault.writes, 1);
  assert.equal(vault.entries.has(account), false);
  assert.deepEqual(revokedIn(r.forms), []);
});

test('WIRE-c a cancel during vault.set on a reconnect puts the old bundle back', async () => {
  const vault = memoryVault(oldBundle);
  const r = scriptedRig(clock => tokenReply(clock), { vault });
  vault.duringSet = () => {
    vault.duringSet = undefined;
    r.abort.abort();
  };
  const error = await refusal(r.connect({ mode: 'reconnect', expectedSubject: 'sub-1' }, r.ctx));
  assert.equal(error.error.reason, 'aborted');
  assert.deepEqual(vault.entries.get(account), oldBundle);
  assert.deepEqual(revokedIn(r.forms), []);
});

// ---------- (d) the consent URL and the loopback Host header ----------

test('WIRE-d only https://accounts.google.com reaches openExternal', () => {
  checkConsentUrl(`${googleAuthUrl}?client_id=x`);
  const bad = [
    'http://accounts.google.com/o/oauth2/v2/auth',
    'https://accounts.google.com.evil.test/o/oauth2/v2/auth',
    'https://evil.test/o/oauth2/v2/auth',
    'https://user@accounts.google.com/o/oauth2/v2/auth',
    'https://accounts.google.com:8443/o/oauth2/v2/auth',
    'javascript:alert(1)',
    'not a url',
  ];
  for (const url of bad) {
    assert.throws(
      () => checkConsentUrl(url),
      (e: unknown) => (e as { error: { reason: string } }).error.reason === 'badConsentUrl',
      url,
    );
  }
});

function getWithHost(port: number, path: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, headers: { host } }, res => {
      res.resume();
      res.once('end', () => resolve(res.statusCode ?? 0));
    });
    req.once('error', reject);
    req.end();
  });
}

test('WIRE-d the loopback refuses a callback whose Host is not 127.0.0.1 or localhost on its port', async () => {
  const loopback = await openLoopback({
    state: 'the-state',
    clock: manualClock(),
    signal: new AbortController().signal,
  });
  const { port } = loopback.address;
  const path = '/?code=one&state=the-state';
  assert.equal(await getWithHost(port, path, `evil.test:${port}`), 400);
  assert.equal(await getWithHost(port, path, '127.0.0.1:1'), 400);
  assert.equal(await getWithHost(port, path, `localhost:${port}`), 200);
  assert.deepEqual(await loopback.outcome, { kind: 'code', code: 'one' });
  assert.equal(loopbackHostAllowed(`127.0.0.1:${port}`, port), true);
  assert.equal(loopbackHostAllowed(`LOCALHOST:${port}`, port), true);
  assert.equal(loopbackHostAllowed(undefined, port), false);
  assert.equal(loopbackHostAllowed('127.0.0.1', port), false);
  loopback.close();
});

// ---------- (e) ConnectRequest.signal, end to end ----------

test('WIRE-e the request’s own signal ends the browser wait and closes the listener', async () => {
  const cancel = new AbortController();
  let consent: URL | undefined;
  const r = scriptedRig(clock => tokenReply(clock), {
    openExternal: url => {
      consent = new URL(url);
      cancel.abort();
    },
  });
  const error = await refusal(within(r.connect({ ...newConnect, signal: cancel.signal }, r.ctx)));
  assert.equal(error.error.reason, 'aborted');
  assert.ok(await refused(portOf(consent!)));
  assert.equal(r.forms.length, 0);
});

test('WIRE-e a browser launch that never returns is cut by the cancel', async () => {
  let consent: URL | undefined;
  const r = scriptedRig(clock => tokenReply(clock), {
    openExternal: url => {
      consent = new URL(url);
      setImmediate(() => r.abort.abort());
      return new Promise<void>(() => undefined);
    },
  });
  const error = await refusal(within(r.connect(newConnect, r.ctx)));
  assert.equal(error.error.reason, 'aborted');
  assert.ok(await refused(portOf(consent!)));
});

test('WIRE-e the request’s signal cancels a pending exchange; one that lands after the cancel stores nothing', async () => {
  const cancel = new AbortController();
  const pending = scriptedRig(() => new Promise<Response>(() => cancel.abort()));
  const cut = await refusal(
    within(pending.connect({ ...newConnect, signal: cancel.signal }, pending.ctx)),
  );
  assert.equal(cut.error.class, 'cancelled');
  assert.equal(pending.vault.writes, 0);

  const late = new AbortController();
  const r = scriptedRig(
    clock => {
      late.abort();
      return tokenReply(clock);
    },
    { governor: deafGovernor() },
  );
  const error = await refusal(within(r.connect({ ...newConnect, signal: late.signal }, r.ctx)));
  assert.equal(error.error.reason, 'aborted');
  assert.equal(r.vault.writes, 0);
  assert.deepEqual(revokedIn(r.forms), []);
});

// ---------- the #69 hardening ----------

test('WIRE-hardening every token-endpoint POST refuses redirects; an access token hides its value', async () => {
  const redirects: Array<RequestRedirect | undefined> = [];
  const clock = manualClock();
  const endpoint = tokenEndpoint(form => {
    if (form.has('token')) return new Response('', { status: 200 });
    return tokenReply(clock);
  });
  const recording = ((url: string | URL | Request, init?: RequestInit) => {
    redirects.push(init?.redirect);
    return endpoint.fetch(url, init);
  }) as typeof fetch;
  const r = scriptedRig(() => tokenReply(clock), { clock, fetch: recording });
  await refusal(r.connect({ mode: 'reconnect', expectedSubject: 'sub-9' }, r.ctx));
  assert.deepEqual(redirects, ['error', 'error'], 'the exchange and the revoke');

  const vault = memoryVault({ clientId, refreshToken: newRefresh });
  const source = new GoogleTokenSource({
    vault,
    http: createHttpClient({ fetch: recording, clock, userAgent: 'aplos-test' }),
    clock,
    client: () => ({ clientId, clientSecret }),
  });
  const token = await source.refresh(account, { signal: new AbortController().signal });
  assert.equal(redirects.at(-1), 'error');
  assert.equal(token.token, newAccess);
  const cached = source.cached(account)!;
  assert.equal(cached.token, newAccess);
  for (const view of [JSON.stringify(token), inspect(cached), JSON.stringify({ ...cached })])
    assert.ok(!view.includes(newAccess), view);
});

// ---------- the host construction ----------

test('WIRE-host createGoogleHostConnect runs every connect on governor.bindConnect(account)', async () => {
  const clock = manualClock();
  const governor = new Governor({ clock, random: () => 0, role: 'primary' });
  governor.bind(account).observe('gmail', {
    class: 'auth',
    provider: 'gmail',
    method: 'oauth.token',
    reason: 'invalid_grant',
  });
  const bound: string[] = [];
  const browser = fakeBrowser(withCode);
  const endpoint = tokenEndpoint(() => tokenReply(clock));
  const vault = memoryVault(oldBundle);
  const host = createGoogleHostConnect({
    http: createHttpClient({ fetch: endpoint.fetch, clock, userAgent: 'aplos-test' }),
    openExternal: browser.openExternal,
    clientInputs: () => ({ env: { APLOS_GOOGLE_CLIENT_ID: clientId }, bundled: {} }),
    vault,
    governor: {
      bindConnect: id => {
        bound.push(id);
        return governor.bindConnect(id);
      },
    },
  });
  const factory = createGoogleProvider({ fetch: endpoint.fetch, ...host });
  const ctx = {
    accountId: account,
    // The ordinary binding: its auth block would stop the reconnect that ends it.
    governor: governor.bind(account),
    clock: { now: () => clock.now(), sleep: clock.sleep.bind(clock), timer: () => assert.fail() },
    log: { event: () => undefined, with: () => ctx.log, enabled: () => false },
    signal: new AbortController().signal,
  };
  const result = await factory.connect({ mode: 'reconnect', expectedSubject: 'sub-1' }, ctx);
  assert.deepEqual(bound, [account]);
  assert.equal(result.credentialRef, account);
  assert.equal(vault.entries.get(account)?.refreshToken, newRefresh);
});
