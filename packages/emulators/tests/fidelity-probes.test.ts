/**
 * Blind fidelity probes for the Gmail and Google OAuth emulator.
 *
 * Each probe sends one request (or a short sequence) that real Gmail or Google OAuth answers in a
 * specific, documented or widely observed way, and asserts that exact answer. The probes were
 * written against Google's behaviour, not against the emulator's code: a failing probe is a
 * fidelity gap the emulator's author must fix or justify.
 *
 * Sources are cited per probe:
 *   [quota]    developers.google.com/workspace/gmail/api/reference/quota (proto-google.md §1.1)
 *   [errors]   developers.google.com/workspace/gmail/api/guides/handle-errors (proto-google.md §3)
 *   [ref]      Gmail REST v1 reference for the method named in the probe
 *   [batch]    developers.google.com/workspace/gmail/api/guides/batch (proto-google.md §2.1)
 *   [sending]  developers.google.com/workspace/gmail/api/guides/sending (proto-google.md §6)
 *   [native]   developers.google.com/identity/protocols/oauth2/native-app (proto-google.md §8.1)
 *   [rfc7636]  RFC 7636 §4.6 (PKCE verification at the token endpoint)
 *   [observed] behaviour widely reported from live Google responses; noted as such
 *
 * All data is synthetic (example.test).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { FakeClock } from '../src/kit/clock';
import { createGmailEmulator, SCOPE, type GmailEmulator } from '../src/gmail';
import { BASE, rawMessage, result, sendBatch, setup } from './gmail-helpers';

const DAY = 86400_000;
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REDIRECT = 'http://127.0.0.1:49152/probe/callback';
const VERIFIER = 'probe-verifier-'.padEnd(64, 'q');
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');

/** Reasons Google uses for the per-user per-minute refusal, in either of its two shapes. */
const RATE_REASONS = ['rateLimitExceeded', 'userRateLimitExceeded'];

/** A bare emulator with a registered desktop client, for OAuth probes that drive the flow by hand. */
function oauthFixture(options: Partial<Parameters<typeof createGmailEmulator>[0]> = {}) {
  const clock = new FakeClock();
  const emu = createGmailEmulator({ clock, latencyMs: 0, ...options });
  emu.oauth.addClient('probe-client', 'probe-secret');
  return { clock, emu };
}

function authUrl(params: Record<string, string> = {}): string {
  const base: Record<string, string> = {
    client_id: 'probe-client',
    redirect_uri: REDIRECT,
    response_type: 'code',
    scope: `openid email ${SCOPE.gmailModify}`,
    state: 'probe-state',
    code_challenge_method: 'S256',
    code_challenge: CHALLENGE,
  };
  const merged = { ...base, ...params };
  for (const [key, value] of Object.entries(merged)) if (value === '\u0000') delete merged[key];
  return `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams(merged)}`;
}

function codeFrom(emu: GmailEmulator, params: Record<string, string> = {}): string {
  const redirect = new URL(emu.oauth.authorize(authUrl(params)));
  const code = redirect.searchParams.get('code');
  assert.ok(code, `consent produced no code: ${redirect.searchParams.get('error')}`);
  return code;
}

async function tokenCall(emu: GmailEmulator, fields: Record<string, string>, withSecret = true) {
  const body = new URLSearchParams({
    client_id: 'probe-client',
    ...(withSecret ? { client_secret: 'probe-secret' } : {}),
    ...fields,
  });
  return result(
    await emu.fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    }),
  );
}

const reasonOf = (json: any): string | undefined => json?.error?.errors?.[0]?.reason;

// ---------------------------------------------------------------------------------------------
// Quota, concurrency and daily limits
// ---------------------------------------------------------------------------------------------

test('PROBE 01 per-user units: the call that would pass 6,000 units in 60 s is refused, and 60 s later it fits [quota]', async () => {
  const h = await setup({ threads: 1 });
  const id = (await h.api('/messages?maxResults=1')).json.messages[0].id; // 5
  for (let i = 0; i < 99; i++)
    assert.equal((await h.api(`/messages/${id}?format=full`)).status, 200, `full get ${i}`); // 5,945
  for (let i = 0; i < 11; i++)
    assert.equal((await h.api('/messages?maxResults=1')).status, 200, `list ${i}`); // 6,000
  assert.equal(h.emu.meter.unitsInWindow(), 6000, 'exactly 6,000 accepted');
  const refused = await h.api('/profile');
  assert.ok([403, 429].includes(refused.status), `status ${refused.status}`);
  assert.ok(RATE_REASONS.includes(reasonOf(refused.json)!), `reason ${reasonOf(refused.json)}`);
  await h.clock.advance(60_000);
  assert.equal((await h.api('/profile')).status, 200);
});

test('PROBE 02 per-user units: one user exhausting the window does not throttle another user of the same project [quota]', async () => {
  const h = await setup({ unitsPerMinute: 100 });
  const second = h.emu.addUser({
    sub: '200000000000000000002',
    email: 'second.probe@example.test',
    name: 'Second Probe',
  });
  const other = await h.emu.oauth.signIn({
    clientId: 'test-client',
    scopes: ['openid', 'email', SCOPE.gmailModify],
    as: second.email,
    fetch: h.emu.fetch,
  });
  for (let i = 0; i < 20; i++) await h.api('/messages'); // 100 units for the first user
  assert.ok([403, 429].includes((await h.api('/profile')).status), 'first user is throttled');
  const otherCall = await h.api('/profile', { token: other.accessToken });
  assert.equal(otherCall.status, 200, 'the limit is per user per project');
  assert.equal(otherCall.json.emailAddress, second.email);
});

test('PROBE 03 concurrency: 13 simultaneous requests from one user with default settings trip 429 "Too many concurrent requests for user" [errors]', async () => {
  const h = await setup({ latencyMs: 500 });
  const answers = await Promise.all(Array.from({ length: 13 }, () => h.api('/profile')));
  const refused = answers.filter(a => a.status === 429);
  assert.ok(refused.length >= 1, `statuses ${answers.map(a => a.status).join(',')}`);
  assert.equal(refused[0].json.error.message, 'Too many concurrent requests for user.');
  assert.equal(reasonOf(refused[0].json), 'rateLimitExceeded');
});

test('PROBE 04 daily stop: quotaExceeded persists until midnight Pacific, not for a fixed period [quota][errors]', async () => {
  // 2026-10-27 09:00 PDT; the next Pacific midnight is 2026-10-28 07:00 UTC.
  const h = await setup({ start: Date.UTC(2026, 9, 27, 16, 0) });
  h.emu.setDailyLimit('quotaExceeded');
  const midnight = Date.UTC(2026, 9, 28, 7, 0);
  const first = await h.api('/messages');
  assert.equal(first.status, 403);
  assert.equal(reasonOf(first.json), 'quotaExceeded');
  assert.equal(first.json.error.errors[0].domain, 'usageLimits');
  await h.clock.advanceTo(midnight - 60_000);
  await h.renew();
  const late = await h.api('/messages');
  assert.equal(late.status, 403, 'still refused one minute before midnight Pacific');
  assert.equal(reasonOf(late.json), 'quotaExceeded');
  await h.clock.advanceTo(midnight);
  assert.equal((await h.api('/messages')).status, 200, 'released at midnight Pacific');
});

test('PROBE 05 daily send limit: the next send is 429 rateLimitExceeded naming "Mail sending" [errors]', async () => {
  const h = await setup({ sendLimitPerDay: 1 });
  assert.equal(
    (await h.api('/messages/send', { method: 'POST', body: { raw: rawMessage({}) } })).status,
    200,
  );
  const refused = await h.api('/messages/send', { method: 'POST', body: { raw: rawMessage({}) } });
  assert.equal(refused.status, 429);
  assert.equal(reasonOf(refused.json), 'rateLimitExceeded');
  assert.match(refused.json.error.message, /User-rate limit exceeded/);
  assert.match(refused.json.error.message, /Mail sending/);
});

test('PROBE 06 daily send limit: the 429 text carries "Retry after <RFC 3339 time>" so a client can show when to retry [observed]', async () => {
  const h = await setup({ sendLimitPerDay: 1 });
  await h.api('/messages/send', { method: 'POST', body: { raw: rawMessage({}) } });
  const refused = await h.api('/messages/send', { method: 'POST', body: { raw: rawMessage({}) } });
  assert.equal(refused.status, 429);
  // Live Gmail: "User-rate limit exceeded.  Retry after 2026-10-28T07:00:00.000Z (Mail sending)".
  assert.match(
    refused.json.error.message,
    /Retry after \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/,
  );
});

// ---------------------------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------------------------

test('PROBE 07 threads.get format=raw is not a ThreadFormat value: 400 INVALID_ARGUMENT [ref threads.get]', async () => {
  const h = await setup({ threads: 1 });
  const threadId = (await h.api('/threads?maxResults=1')).json.threads[0].id;
  const refused = await h.api(`/threads/${threadId}?format=raw`);
  assert.equal(refused.status, 400);
  assert.equal(refused.json.error.status, 'INVALID_ARGUMENT');
  assert.ok(
    ['invalidArgument', 'invalid', 'badRequest'].includes(reasonOf(refused.json)!),
    `reason ${reasonOf(refused.json)}`,
  );
});

test('PROBE 08 messages.list maxResults=501 is capped silently at 500 with a nextPageToken [ref messages.list: "maximum allowed value is 500"; observed cap]', async () => {
  const h = await setup({ threads: 640, unitsPerMinute: 10_000_000 }); // some generated threads sit in Spam or Trash
  const page = await h.api('/messages?maxResults=501');
  assert.equal(page.status, 200);
  assert.equal(page.json.messages.length, 500);
  assert.ok(page.json.nextPageToken, 'more remain');
  const threads = await h.api('/threads?maxResults=1000');
  assert.equal(threads.status, 200);
  assert.equal(threads.json.threads.length, 500);
});

test('PROBE 09 history.list maxResults=501 is capped at 500 [ref history.list: default 100, max 500]', async () => {
  const h = await setup({ threads: 1, unitsPerMinute: 10_000_000 });
  const cursor = (await h.api('/profile')).json.historyId;
  for (let i = 0; i < 510; i++) h.emu.mailbox.addMessage({ subject: `Probe ${i}`, text: 'x' });
  const page = await h.api(`/history?startHistoryId=${cursor}&maxResults=501`);
  assert.equal(page.status, 200);
  assert.equal(page.json.history.length, 500);
  assert.ok(page.json.nextPageToken);
});

test('PROBE 10 history.list with an expired startHistoryId answers 404 notFound "Requested entity was not found." [ref history.list][errors]', async () => {
  const h = await setup({ threads: 3 });
  const cursor = (await h.api('/profile')).json.historyId;
  h.emu.mailbox.addMessage({ subject: 'after cursor', text: 'x' });
  h.emu.mailbox.expireHistory();
  const stale = await h.api(`/history?startHistoryId=${cursor}`);
  assert.equal(stale.status, 404);
  assert.equal(reasonOf(stale.json), 'notFound');
  assert.equal(stale.json.error.status, 'NOT_FOUND');
  assert.equal(stale.json.error.message, 'Requested entity was not found.');
});

test('PROBE 11 messages.batchModify with 1,001 existing ids is 400; 1,000 is 204 [ref batchModify: "up to 1000"]', async () => {
  const h = await setup({ unitsPerMinute: 10_000_000 });
  const ids: string[] = [];
  for (let i = 0; i < 1001; i++)
    ids.push(h.emu.mailbox.addMessage({ subject: `Bulk ${i}`, text: 'x', labelIds: ['INBOX'] }).id);
  const tooMany = await h.api('/messages/batchModify', {
    method: 'POST',
    body: { ids, removeLabelIds: ['INBOX'] },
  });
  assert.equal(tooMany.status, 400);
  assert.equal(tooMany.json.error.status, 'INVALID_ARGUMENT');
  const fits = await h.api('/messages/batchModify', {
    method: 'POST',
    body: { ids: ids.slice(0, 1000), removeLabelIds: ['INBOX'] },
  });
  assert.equal(fits.status, 204);
  assert.equal(fits.text, '', 'batchModify returns an empty body');
});

test('PROBE 12 a batch of 101 parts is refused as a whole with 400 [batch: "limited to 100 calls"]', async () => {
  const h = await setup({ unitsPerMinute: 10_000_000 });
  const refused = await sendBatch(
    h.emu,
    h.token,
    Array.from({ length: 101 }, () => ({ path: '/profile' })),
  );
  assert.equal(refused.status, 400);
  assert.equal(h.emu.meter.unitsInWindow(), 0, 'no part ran');
});

test('PROBE 13 a non-hex message id is 400 "Invalid id value"; a well-formed unknown id is 404 notFound [observed]', async () => {
  const h = await setup({ threads: 1 });
  const malformed = await h.api('/messages/not-a-gmail-id');
  assert.equal(malformed.status, 400);
  assert.equal(malformed.json.error.message, 'Invalid id value');
  assert.equal(reasonOf(malformed.json), 'invalidArgument');
  const unknown = await h.api('/messages/18f0000000000000');
  assert.equal(unknown.status, 404);
  assert.equal(reasonOf(unknown.json), 'notFound');
});

test('PROBE 14 messages.send without raw is 400 naming the raw/upload requirement [observed]', async () => {
  const h = await setup();
  const refused = await h.api('/messages/send', { method: 'POST', body: {} });
  assert.equal(refused.status, 400);
  assert.equal(
    refused.json.error.message,
    "'raw' RFC822 payload message string or uploading message via /upload/* URL required",
  );
  assert.equal(h.emu.mailbox.listMessages().filter(m => m.labelIds.includes('SENT')).length, 0);
});

test('PROBE 15 messages.send with no To, Cc or Bcc is 400 "Recipient address required" [observed]', async () => {
  const h = await setup();
  const noRecipient = Buffer.from(
    [
      'Subject: Nobody to send to',
      'Content-Type: text/plain; charset="UTF-8"',
      '',
      'Body only.',
    ].join('\r\n'),
  ).toString('base64url');
  const refused = await h.api('/messages/send', { method: 'POST', body: { raw: noRecipient } });
  assert.equal(refused.status, 400);
  assert.equal(refused.json.error.message, 'Recipient address required');
  assert.equal(reasonOf(refused.json), 'invalidArgument');
});

test('PROBE 16 labels.create with a reserved system name (INBOX) is refused with 400 "Invalid label name" [observed]', async () => {
  const h = await setup();
  const refused = await h.api('/labels', { method: 'POST', body: { name: 'INBOX' } });
  assert.equal(refused.status, 400);
  assert.equal(refused.json.error.message, 'Invalid label name');
});

test('PROBE 17 an explicit threadId with a different Subject does not join the thread [sending: "The Subject headers must match"]', async () => {
  const h = await setup();
  const first = await h.api('/messages/send', {
    method: 'POST',
    body: { raw: rawMessage({ subject: 'Picnic plan', messageId: 'p1@probe.example.test' }) },
  });
  const changed = await h.api('/messages/send', {
    method: 'POST',
    body: {
      threadId: first.json.threadId,
      raw: rawMessage({
        subject: 'Completely unrelated',
        messageId: 'p2@probe.example.test',
        extra: ['In-Reply-To: <p1@probe.example.test>', 'References: <p1@probe.example.test>'],
      }),
    },
  });
  assert.equal(changed.status, 200);
  assert.notEqual(changed.json.threadId, first.json.threadId);
});

// ---------------------------------------------------------------------------------------------
// Response shape and fields masks
// ---------------------------------------------------------------------------------------------

test('PROBE 18 fields mask: messages.list fields=messages/id returns nothing else, not even resultSizeEstimate or nextPageToken [ref system parameter fields]', async () => {
  const h = await setup({ threads: 30, unitsPerMinute: 10_000_000 });
  const masked = await h.api('/messages?maxResults=5&fields=messages/id');
  assert.equal(masked.status, 200);
  assert.deepEqual(Object.keys(masked.json), ['messages']);
  for (const message of masked.json.messages) assert.deepEqual(Object.keys(message), ['id']);
  const got = await h.api(`/messages/${masked.json.messages[0].id}?format=full&fields=id,labelIds`);
  assert.deepEqual(Object.keys(got.json).sort(), ['id', 'labelIds']);
});

test('PROBE 19 fields mask naming a field that does not exist is 400 "Invalid field selection" [observed: every googleapis.com JSON API]', async () => {
  const h = await setup({ threads: 1 });
  const top = await h.api('/profile?fields=emailAddres');
  assert.equal(top.status, 400);
  assert.match(top.json.error.message, /Invalid field selection emailAddres/);
  assert.equal(reasonOf(top.json), 'invalidParameter');
  const nested = await h.api('/messages?fields=messages(id,threadID)');
  assert.equal(nested.status, 400, 'a typo inside a sub-selection is caught too');
});

test('PROBE 20 int64 fields are JSON strings: profile.historyId, message.internalDate and history ids [ref: format int64/uint64 serialised as string]', async () => {
  const h = await setup({ threads: 2 });
  const profile = (await h.api('/profile')).json;
  assert.equal(typeof profile.historyId, 'string');
  const id = (await h.api('/messages?maxResults=1')).json.messages[0].id;
  const message = (await h.api(`/messages/${id}?format=minimal`)).json;
  assert.equal(typeof message.internalDate, 'string');
  assert.equal(typeof message.historyId, 'string');
  assert.equal(typeof message.sizeEstimate, 'number', 'int32 stays a number');
  h.emu.mailbox.addMessage({ subject: 'new', text: 'x' });
  const history = (await h.api(`/history?startHistoryId=${profile.historyId}`)).json;
  assert.equal(typeof history.historyId, 'string');
  assert.equal(typeof history.history[0].id, 'string');
});

test('PROBE 21 search: rfc822msgid: finds the message by Message-ID, as the 0.2.3 adapter relies on [ref Gmail search operators]', async () => {
  const h = await setup({ threads: 3 });
  const sent = await h.api('/messages/send', {
    method: 'POST',
    body: { raw: rawMessage({ messageId: 'needle-42@probe.example.test' }) },
  });
  const found = await h.api(
    `/messages?q=${encodeURIComponent('rfc822msgid:needle-42@probe.example.test')}&includeSpamTrash=true&maxResults=1`,
  );
  assert.equal(found.status, 200);
  assert.deepEqual(
    found.json.messages?.map((m: any) => m.id),
    [sent.json.id],
  );
});

test('PROBE 22 userId: the signed-in address works in place of "me"; another address is 403 "Delegation denied" [ref userId; observed]', async () => {
  const h = await setup();
  const own = await result(
    await h.emu.fetch(
      'https://gmail.googleapis.com/gmail/v1/users/test.user@example.test/profile',
      { headers: { authorization: `Bearer ${h.token}` } },
    ),
  );
  assert.equal(own.status, 200);
  const other = await result(
    await h.emu.fetch(
      'https://gmail.googleapis.com/gmail/v1/users/someone.else@example.test/profile',
      { headers: { authorization: `Bearer ${h.token}` } },
    ),
  );
  assert.equal(other.status, 403);
  assert.match(other.json.error.message, /^Delegation denied for /);
});

// ---------------------------------------------------------------------------------------------
// Auth and scopes on the Gmail API
// ---------------------------------------------------------------------------------------------

test('PROBE 23 an expired access token is 401 authError UNAUTHENTICATED with a WWW-Authenticate invalid_token challenge [errors][RFC 6750 §3]', async () => {
  const h = await setup();
  await h.clock.advance(3600_000);
  const expired = await h.api('/profile');
  assert.equal(expired.status, 401);
  assert.equal(reasonOf(expired.json), 'authError');
  assert.equal(expired.json.error.status, 'UNAUTHENTICATED');
  assert.match(expired.headers.get('www-authenticate') ?? '', /^Bearer .*error="invalid_token"/);
});

test('PROBE 24 no Authorization header is 401 with reason "required" ("Login Required."), distinct from an expired token [observed]', async () => {
  const h = await setup();
  const missing = await result(await h.emu.fetch(`${BASE}/profile`));
  assert.equal(missing.status, 401);
  assert.equal(reasonOf(missing.json), 'required');
  assert.equal(missing.json.error.status, 'UNAUTHENTICATED');
});

test('PROBE 25 filters.create without gmail.settings.basic is 403 insufficientPermissions [ref filters.create: only scope gmail.settings.basic]', async () => {
  const h = await setup({ scopes: ['openid', 'email', SCOPE.gmailModify] });
  const refused = await h.api('/settings/filters', {
    method: 'POST',
    body: { criteria: { from: 'news@example.test' }, action: { removeLabelIds: ['INBOX'] } },
  });
  assert.equal(refused.status, 403);
  assert.equal(reasonOf(refused.json), 'insufficientPermissions');
  assert.equal(refused.json.error.status, 'PERMISSION_DENIED');
  const list = await h.api('/settings/filters');
  assert.equal(list.json.filter, undefined, 'nothing was created');
});

test('PROBE 26 an origin the emulator does not serve is rejected with TypeError "External network blocked" [task rule]', async () => {
  const h = await setup();
  await assert.rejects(
    h.emu.fetch('https://people.googleapis.com/v1/people/me'),
    (error: unknown) =>
      error instanceof TypeError && /External network blocked/.test((error as Error).message),
  );
});

// ---------------------------------------------------------------------------------------------
// OAuth token endpoint
// ---------------------------------------------------------------------------------------------

test('PROBE 27 refresh 7 days after consent in Testing mode is 400 invalid_grant "Token has been expired or revoked." [native][proto-google §8.1]', async () => {
  const { emu, clock } = oauthFixture({ testingMode: true });
  const exchanged = await tokenCall(emu, {
    grant_type: 'authorization_code',
    code: codeFrom(emu),
    redirect_uri: REDIRECT,
    code_verifier: VERIFIER,
  });
  await clock.advance(7 * DAY + 1000);
  const dead = await tokenCall(emu, {
    grant_type: 'refresh_token',
    refresh_token: exchanged.json.refresh_token,
  });
  assert.equal(dead.status, 400);
  assert.equal(dead.json.error, 'invalid_grant');
  assert.equal(dead.json.error_description, 'Token has been expired or revoked.');
});

test('PROBE 28 a code exchange with the wrong PKCE verifier is 400 invalid_grant [rfc7636][native]', async () => {
  const { emu } = oauthFixture();
  const wrong = await tokenCall(emu, {
    grant_type: 'authorization_code',
    code: codeFrom(emu),
    redirect_uri: REDIRECT,
    code_verifier: 'w'.repeat(64),
  });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.json.error, 'invalid_grant');
  assert.equal(wrong.json.access_token, undefined);
});

test('PROBE 29 a reused authorization code is 400 invalid_grant [RFC 6749 §4.1.2][native]', async () => {
  const { emu } = oauthFixture();
  const code = codeFrom(emu);
  assert.equal(
    (
      await tokenCall(emu, {
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        code_verifier: VERIFIER,
      })
    ).status,
    200,
  );
  const again = await tokenCall(emu, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT,
    code_verifier: VERIFIER,
  });
  assert.equal(again.status, 400);
  assert.equal(again.json.error, 'invalid_grant');
});

test('PROBE 30 a code exchange with a different redirect_uri is 400 redirect_uri_mismatch [observed Google token endpoint]', async () => {
  const { emu } = oauthFixture();
  const mismatch = await tokenCall(emu, {
    grant_type: 'authorization_code',
    code: codeFrom(emu),
    redirect_uri: 'http://127.0.0.1:49153/elsewhere',
    code_verifier: VERIFIER,
  });
  assert.equal(mismatch.status, 400);
  assert.equal(mismatch.json.error, 'redirect_uri_mismatch');
});

test('PROBE 31 a desktop client that omits client_secret gets 400 invalid_request "client_secret is missing." [observed]', async () => {
  const { emu } = oauthFixture();
  const missing = await tokenCall(
    emu,
    {
      grant_type: 'authorization_code',
      code: codeFrom(emu),
      redirect_uri: REDIRECT,
      code_verifier: VERIFIER,
    },
    false,
  );
  assert.equal(missing.status, 400);
  assert.equal(missing.json.error, 'invalid_request');
  assert.equal(missing.json.error_description, 'client_secret is missing.');
});

test('PROBE 32 POST /revoke with the refresh token kills the refresh token and the access tokens issued from it [native "Revoking a token"]', async () => {
  const { emu } = oauthFixture();
  const exchanged = await tokenCall(emu, {
    grant_type: 'authorization_code',
    code: codeFrom(emu),
    redirect_uri: REDIRECT,
    code_verifier: VERIFIER,
  });
  const revoked = await emu.fetch('https://oauth2.googleapis.com/revoke', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: exchanged.json.refresh_token }),
  });
  assert.equal(revoked.status, 200);
  const refresh = await tokenCall(emu, {
    grant_type: 'refresh_token',
    refresh_token: exchanged.json.refresh_token,
  });
  assert.equal(refresh.status, 400);
  assert.equal(refresh.json.error, 'invalid_grant');
  const call = await emu.fetch(`${BASE}/profile`, {
    headers: { authorization: `Bearer ${exchanged.json.access_token}` },
  });
  assert.equal(call.status, 401, 'the access token died with its refresh token');
  const twice = await result(
    await emu.fetch('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: exchanged.json.refresh_token }),
    }),
  );
  assert.equal(twice.status, 400);
  assert.equal(twice.json.error, 'invalid_token');
});

test('PROBE 33 PKCE and state are recommended, not required: an authorization request without them still yields a code [native: code_challenge "Recommended", state "Recommended"]', async () => {
  const { emu } = oauthFixture();
  const response = await emu.fetch(
    authUrl({ code_challenge: '\u0000', code_challenge_method: '\u0000', state: '\u0000' }),
    { redirect: 'manual' },
  );
  assert.equal(response.status, 302);
  const location = new URL(response.headers.get('location')!);
  assert.equal(
    location.searchParams.get('error'),
    null,
    `error ${location.searchParams.get('error')}`,
  );
  assert.ok(location.searchParams.get('code'));
});
