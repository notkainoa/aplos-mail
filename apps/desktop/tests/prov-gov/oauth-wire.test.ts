// The Integrator's binding conditions for wiring the sign-in into the Gmail adapter (#72 notes, a..e), the #69
// hardening, and the host construction. Each WIRE test fails on the code merged in #72.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnection } from 'node:net';
import { inspect } from 'node:util';
import type { BoundGovernor, ConnectRequest, GovernedRequest } from '@aplos/engine/ports';
import type { FakeClock } from '@aplos/emulators';
import { Governor } from '../../../../packages/engine/src/sync/governor';
import { NotInThisLaneError, createGoogleProvider } from '../../src/host/providers/google/adapter';
import { checkConsentUrl, googleAuthUrl } from '../../src/host/providers/oauth/flow';
import { createGoogleHostConnect } from '../../src/host/providers/oauth/host-connect';
import { revokeTimeoutMs } from '../../src/host/providers/oauth/connect';
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

test('WIRE-a reconnect with only an address: another account is wrongAccount, stores nothing, not revoked', async () => {
  const vault = memoryVault(oldBundle);
  const r = emulatorRig({ vault, as: 'other@example.test' });
  const error = await refusal(
    r.connect({ mode: 'reconnect', address: 'owner@example.test' }, r.ctx),
  );
  assert.equal(error.error.reason, 'wrongAccount');
  assert.equal(vault.writes, 0);
  assert.deepEqual(vault.entries.get(account), oldBundle);
  assert.equal(
    r.revoked.length,
    0,
    'a row without a subject may be the owner’s renamed or alias account',
  );
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
/** The composition root's answer for a sub no Aplos account has. */
const unknownSubjects = { deps: { knownSubject: async () => false } };

test('WIRE-b a reconnect answered by an unknown subject is revoked, even with a bad id_token or no refresh token', async () => {
  const foreign = scriptedRig(clock => tokenReply(clock), unknownSubjects);
  const wrong = await refusal(
    foreign.connect({ mode: 'reconnect', expectedSubject: 'sub-9' }, foreign.ctx),
  );
  assert.equal(wrong.error.reason, 'wrongAccount');
  assert.deepEqual(revokedIn(foreign.forms), [newRefresh]);

  const bad = scriptedRig(
    clock =>
      tokenReply(clock, {
        id_token: idToken(claims(clock, { sub: 'sub-9', aud: 'someone-else' })),
      }),
    unknownSubjects,
  );
  assert.equal((await refusal(bad.connect(reconnectSub1, bad.ctx))).error.reason, 'invalidIdToken');
  assert.deepEqual(revokedIn(bad.forms), [newRefresh]);

  const noRefresh = scriptedRig(
    clock =>
      tokenReply(clock, {
        refresh_token: undefined,
        id_token: idToken(claims(clock, { sub: 'sub-9' })),
      }),
    unknownSubjects,
  );
  const error = await refusal(noRefresh.connect(reconnectSub1, noRefresh.ctx));
  assert.equal(error.error.reason, 'noRefreshToken');
  assert.deepEqual(
    revokedIn(noRefresh.forms),
    [newAccess],
    'the access token takes its grant with it',
  );
});

test('WIRE-b another subject that is an Aplos account, or with no knownSubject at all, is not revoked', async () => {
  const asked: string[] = [];
  const signals: AbortSignal[] = [];
  const known = scriptedRig(clock => tokenReply(clock), {
    deps: {
      knownSubject: (sub, signal) => {
        asked.push(sub);
        signals.push(signal);
        return sub === 'sub-1';
      },
    },
  });
  const wrong = await refusal(
    known.connect({ mode: 'reconnect', expectedSubject: 'sub-9' }, known.ctx),
  );
  assert.equal(wrong.error.reason, 'wrongAccount');
  assert.deepEqual(asked, ['sub-1'], 'asked about the sub Google answered with');
  assert.ok(signals[0] instanceof AbortSignal, 'the lookup can stop with the attempt');
  assert.deepEqual(revokedIn(known.forms), [], 'that account’s stored grant could die with it');

  const defaulted = scriptedRig(clock => tokenReply(clock));
  await refusal(defaulted.connect({ mode: 'reconnect', expectedSubject: 'sub-9' }, defaulted.ctx));
  assert.deepEqual(revokedIn(defaulted.forms), [], 'default: every sub is known');

  const throwing = scriptedRig(clock => tokenReply(clock), {
    deps: { knownSubject: () => Promise.reject(new Error('store closed')) },
  });
  await refusal(throwing.connect({ mode: 'reconnect', expectedSubject: 'sub-9' }, throwing.ctx));
  assert.deepEqual(revokedIn(throwing.forms), [], 'a failed lookup counts as known');
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
  clock = manualClock(),
  extra: { accountIsCommitted?: (id: string) => boolean } = {},
) {
  return createGoogleHostConnect({
    accountIsCommitted: () => false,
    ...extra,
    http: createHttpClient({ fetch: fetchFn, clock, userAgent: 'aplos-test' }),
    openExternal: open,
    clientInputs: () => ({
      env: { APLOS_GOOGLE_CLIENT_ID: clientId, APLOS_GOOGLE_CLIENT_SECRET: clientSecret },
      bundled: {},
    }),
    vault,
  });
}

/** A host whose connects succeed, and a context for account `id`. */
function connectingHost(
  vault: MemoryVault,
  extra: { accountIsCommitted?: (id: string) => boolean } = {},
) {
  const clock = manualClock();
  const endpoint = tokenEndpoint(() => tokenReply(clock));
  const browser = fakeBrowser(withCode);
  const host = hostConnect(vault, endpoint.fetch, browser.openExternal, clock, extra);
  const base = scriptedRig(c => tokenReply(c), { clock }).ctx;
  const ctxFor = (id: string) => ({ ...base, accountId: id });
  return { host, ctxFor };
}

test('WIRE-b discardCredential deletes only a ref this host’s new connect minted, never a live or guessed one', async () => {
  const vault = memoryVault(oldBundle);
  const { host, ctxFor } = connectingHost(vault);
  const factory = createGoogleProvider({ fetch, ...host });
  const notOurs = async (ref: string) => {
    const error = await refusal(factory.discardCredential!(ref));
    assert.equal(error.error.reason, 'notThisHostsCredential', ref);
  };
  // The live bundle of a committed account, by its guessable ref, and malformed spellings of it.
  for (const ref of [account, `../${account}`, `x/${account}`, `x\\${account}`, '', 'a\u0000b'])
    await notOurs(ref);
  assert.deepEqual(vault.entries.get(account), oldBundle);

  // A reconnect's ref is the account's own, live one: never minted.
  await factory.connect({ mode: 'reconnect', expectedSubject: 'sub-1' }, ctxFor(account));
  await notOurs(account);
  assert.ok(vault.entries.has(account));

  const result = await factory.connect(newConnect, ctxFor('acct-new'));
  assert.equal(result.credentialRef, 'acct-new');
  await factory.discardCredential!('acct-new');
  assert.deepEqual(vault.deletes, ['acct-new']);
  assert.equal(vault.entries.has('acct-new'), false);
  assert.ok(vault.entries.has(account), 'another account’s bundle is untouched');
  await factory.discardCredential!('acct-new');

  const bare = createGoogleProvider({ fetch });
  assert.equal(bare.discardCredential, undefined, 'fails closed in the engine');
  await assert.rejects(bare.connect(newConnect, {} as never), NotInThisLaneError);
});

test('WIRE-b forgetAccount deletes a removed account’s bundle, never a committed one, and revokes nothing at Google', async () => {
  const vault = memoryVault(oldBundle);
  vault.entries.set('acct-other', { ...oldBundle });
  const committed = new Set([account, 'acct-other']);
  const forms: URLSearchParams[] = [];
  const host = createGoogleHostConnect({
    accountIsCommitted: id => committed.has(id),
    http: createHttpClient({
      fetch: async (_url, init) => {
        forms.push(new URLSearchParams(String(init?.body ?? '')));
        return new Response('{}');
      },
      clock: manualClock(),
      userAgent: 'aplos-test',
    }),
    openExternal: async () => undefined,
    clientInputs: () => ({ env: {}, bundled: {} }),
    vault,
  });
  const factory = createGoogleProvider({ fetch, ...host });
  // Still in the store: the removal did not commit, so the sign-in stays.
  const held = await refusal(factory.forgetAccount!(account));
  assert.equal(held.error.reason, 'accountStillHeld');
  assert.deepEqual(vault.entries.get(account), oldBundle);

  committed.delete(account);
  await factory.forgetAccount!(account);
  assert.equal(vault.entries.has(account), false);
  assert.ok(vault.entries.has('acct-other'), 'another account’s bundle is untouched');
  await factory.forgetAccount!(account); // a ref that is not stored is not an error
  assert.deepEqual(forms, [], 'no request reached Google');
  assert.equal(createGoogleProvider({ fetch }).forgetAccount, undefined);
});

/** A rig whose revoke endpoint never answers, and a wrong-account reconnect on it. */
function hangingRevoke() {
  const r = scriptedRig(
    (clock, form) =>
      form.has('token') ? new Promise<Response>(() => undefined) : tokenReply(clock),
    unknownSubjects,
  );
  const outcome = r.connect({ mode: 'reconnect', expectedSubject: 'sub-9' }, r.ctx);
  outcome.catch(() => undefined);
  const revoking = async () => {
    while (!r.forms.some(f => f.has('token'))) await new Promise(resolve => setImmediate(resolve));
  };
  return { r, outcome, revoking };
}

test('WIRE-b a revoke that hangs is cut by the cancel, and otherwise after 5 s', async () => {
  const cancelled = hangingRevoke();
  await within(cancelled.revoking());
  cancelled.r.abort.abort();
  assert.equal((await refusal(within(cancelled.outcome))).error.reason, 'wrongAccount');

  const slow = hangingRevoke();
  await within(slow.revoking());
  await slow.r.clock.advance(revokeTimeoutMs - 1);
  const early = await Promise.race([
    slow.outcome.then(
      () => 'settled',
      () => 'settled',
    ),
    new Promise(resolve => setImmediate(() => resolve('pending'))),
  ]);
  assert.equal(early, 'pending');
  await slow.r.clock.advance(1);
  assert.equal((await refusal(within(slow.outcome))).error.reason, 'wrongAccount');
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

test('WIRE-c a vault.set that rejects after a partial persist is undone; a cancel during it reports aborted', async () => {
  const fresh = memoryVault();
  fresh.failAfterWrite = true;
  const r = scriptedRig(clock => tokenReply(clock), { vault: fresh });
  assert.equal((await refusal(r.connect(newConnect, r.ctx))).error.reason, 'vaultWriteFailed');
  assert.equal(fresh.entries.has(account), false, 'the half-written entry is deleted');

  const vault = memoryVault(oldBundle);
  vault.failAfterWrite = true;
  const re = scriptedRig(clock => tokenReply(clock), { vault });
  vault.duringSet = () => {
    vault.duringSet = undefined;
    vault.failAfterWrite = false;
    re.abort.abort();
    throw new Error('persist failed');
  };
  const error = await refusal(re.connect(reconnectSub1, re.ctx));
  assert.equal(error.error.reason, 'aborted');
  assert.deepEqual(vault.entries.get(account), oldBundle, 'the old bundle is back');
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

/** A hand-written GET with exactly these `Host` lines (none, one or several); the status, or 0 with no answer. */
function rawGet(port: number, path: string, hosts: string[]): Promise<number> {
  return new Promise(resolve => {
    let reply = '';
    const socket = createConnection({ port, host: '127.0.0.1' }, () => {
      const lines = [`GET ${path} HTTP/1.1`, ...hosts.map(h => `Host: ${h}`), 'Connection: close'];
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    });
    socket.on('data', chunk => {
      reply += String(chunk);
    });
    socket.once('error', () => resolve(0));
    socket.once('close', () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(reply)?.[1] ?? 0)));
  });
}

test('WIRE-d the loopback refuses every Host but exactly 127.0.0.1:<port> or localhost:<port>', async () => {
  const loopback = await openLoopback({
    state: 'the-state',
    clock: manualClock(),
    signal: new AbortController().signal,
  });
  const { port } = loopback.address;
  const path = '/?code=one&state=the-state';
  const refusedHosts = [
    [`evil.test:${port}`],
    [`127.0.0.1.evil.com:${port}`],
    [`127.0.0.1.:${port}`],
    [`localhost.:${port}`],
    [`[::1]:${port}`],
    [`LOCALHOST:${port}`],
    [`127.0.0.1:${port + 1}`],
    ['127.0.0.1'],
    [],
    [`127.0.0.1:${port}`, `evil.test:${port}`],
    [`127.0.0.1:${port}`, `127.0.0.1:${port}`],
  ];
  for (const hosts of refusedHosts) {
    const status = await rawGet(port, path, hosts);
    assert.notEqual(status, 200, hosts.join(' + ') || '(no Host)');
    assert.notEqual(status, 0, 'the listener is still open');
  }
  assert.equal(await rawGet(port, path, [`localhost:${port}`]), 200);
  assert.deepEqual(await loopback.outcome, { kind: 'code', code: 'one' });
  assert.equal(loopbackHostAllowed(`127.0.0.1:${port}`, port), true);
  assert.equal(loopbackHostAllowed(`LOCALHOST:${port}`, port), false);
  assert.equal(loopbackHostAllowed(undefined, port), false);
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
  const r = scriptedRig(() => tokenReply(clock), { clock, fetch: recording, ...unknownSubjects });
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
    accountIsCommitted: () => false,
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

test('WIRE-b discardCredential refuses a minted ref once its account has a committed row', async () => {
  const vault = memoryVault(oldBundle);
  const committed = new Set<string>();
  const { host, ctxFor } = connectingHost(vault, { accountIsCommitted: id => committed.has(id) });
  const factory = createGoogleProvider({ fetch, ...host });
  await factory.connect(newConnect, ctxFor('acct-new'));
  committed.add('acct-new');
  const error = await refusal(factory.discardCredential!('acct-new'));
  assert.equal(error.error.reason, 'notThisHostsCredential');
  assert.ok(vault.entries.has('acct-new'), 'a committed account’s bundle stays');
  committed.delete('acct-new');
  await factory.discardCredential!('acct-new');
  assert.equal(vault.entries.has('acct-new'), false);
});

test('createGoogleHostConnect needs accountIsCommitted: leaving it out does not typecheck', () => {
  // @ts-expect-error accountIsCommitted is required; an optional check would be silently off.
  const missing: Parameters<typeof createGoogleHostConnect>[0] = {
    http: createHttpClient({ fetch, clock: manualClock(), userAgent: 'aplos-test' }),
    openExternal: async () => {},
    clientInputs: () => ({ env: {}, bundled: {} }),
    vault: memoryVault(oldBundle),
  };
  assert.ok(missing);
});
