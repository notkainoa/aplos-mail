import test from 'node:test';
import assert from 'node:assert/strict';
import type { FaultHook } from '../src/kit/types';
import { SCOPE, nextPacificMidnight, type ThrottleShape } from '../src/gmail';
import { maxInFlight } from '../src/kit/scenario';
import { rawMessage, result, setup } from './gmail-helpers';

const QUOTA_TEXT =
  "Quota exceeded for quota metric 'Queries' and limit 'Queries per minute per user' of service 'gmail.googleapis.com' for consumer 'project_number:000000000000'.";

async function overLimit(shape: ThrottleShape) {
  const h = await setup({ unitsPerMinute: 1, throttleShape: shape });
  await h.api('/profile');
  return h.api('/profile');
}

test('rateLimitExceeded403 has the exact Google body', async () => {
  const refused = await overLimit('rateLimitExceeded403');
  assert.equal(refused.status, 403);
  assert.deepEqual(refused.json, {
    error: {
      code: 403,
      message: QUOTA_TEXT,
      errors: [{ message: QUOTA_TEXT, domain: 'usageLimits', reason: 'rateLimitExceeded' }],
      status: 'PERMISSION_DENIED',
    },
  });
});

test('userRateLimitExceeded403 has the exact Google body', async () => {
  const refused = await overLimit('userRateLimitExceeded403');
  assert.equal(refused.status, 403);
  assert.deepEqual(refused.json, {
    error: {
      code: 403,
      message: 'User-rate limit exceeded.',
      errors: [
        {
          message: 'User-rate limit exceeded.',
          domain: 'usageLimits',
          reason: 'userRateLimitExceeded',
        },
      ],
      status: 'PERMISSION_DENIED',
    },
  });
});

test('resourceExhausted429 has the exact Google body', async () => {
  const refused = await overLimit('resourceExhausted429');
  assert.equal(refused.status, 429);
  assert.deepEqual(refused.json, {
    error: {
      code: 429,
      message: QUOTA_TEXT,
      errors: [{ message: QUOTA_TEXT, domain: 'global', reason: 'rateLimitExceeded' }],
      status: 'RESOURCE_EXHAUSTED',
      details: [
        {
          '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
          reason: 'RATE_LIMIT_EXCEEDED',
          domain: 'googleapis.com',
        },
      ],
    },
  });
});

test('messageOnly is a 403 whose text alone names the per-minute quota: no status, no errors array, no reason', async () => {
  const refused = await overLimit('messageOnly');
  assert.equal(refused.status, 403);
  assert.deepEqual(
    Object.keys(refused.json.error).sort(),
    ['code', 'message'],
    'a client reading errors[0].reason finds nothing',
  );
  assert.match(refused.json.error.message, /per minute per user/);
});

test('Retry-After in seconds is the time until enough units leave the window', async () => {
  const h = await setup({ unitsPerMinute: 20, retryAfter: 'seconds' });
  await h.api('/messages'); // 5 units at t0
  await h.clock.advance(10_000);
  for (let i = 0; i < 3; i++) await h.api('/messages'); // 15 more, window now 20
  const refused = await h.api('/messages');
  assert.equal(refused.status, 403);
  assert.equal(
    refused.headers.get('retry-after'),
    '50',
    'the oldest 5 units leave at t0 + 60 s, 50 s from now',
  );
  await h.clock.advance(50_000);
  assert.equal((await h.api('/messages')).status, 200);
});

test('Retry-After as an HTTP date names the same instant', async () => {
  const h = await setup({ unitsPerMinute: 5, retryAfter: 'httpDate' });
  await h.api('/messages');
  await h.clock.advance(20_000);
  const refused = await h.api('/messages');
  const header = refused.headers.get('retry-after')!;
  assert.match(header, /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/);
  assert.equal(Date.parse(header), h.clock.now() + 40_000);
});

test('no Retry-After by default', async () => {
  const refused = await overLimit('rateLimitExceeded403');
  assert.equal(refused.headers.get('retry-after'), null);
});

test('more requests in flight than the concurrency cap get 429 "Too many concurrent requests"', async () => {
  const h = await setup({ concurrency: 3, latencyMs: 150 });
  const results = await Promise.all(Array.from({ length: 5 }, () => h.api('/profile')));
  const statuses = results.map(r => r.status);
  assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
  assert.equal(results[3].json.error.message, 'Too many concurrent requests for user.');
  assert.equal(results[3].json.error.errors[0].reason, 'rateLimitExceeded');
  assert.equal(results[3].json.error.status, 'RESOURCE_EXHAUSTED');
  const gmail = h.emu.log.filter(e => e.service === 'gmail');
  // Refused requests hold a slot for their latency too, so the fifth sees four ahead of it.
  assert.deepEqual(
    gmail.map(e => e.inFlight),
    [1, 2, 3, 4, 5],
  );
  assert.equal(h.emu.inFlight(), 0, 'slots are released when requests finish');
  assert.equal((await h.api('/profile')).status, 200);
});

test('refused requests hold an in-flight slot too, so a burst while throttled shows up and trips the cap', async () => {
  const h = await setup({ concurrency: 3, latencyMs: 150, unitsPerMinute: 1 });
  await h.api('/profile'); // spends the whole minute
  const burst = await Promise.all(Array.from({ length: 12 }, () => h.api('/profile')));
  const reasons = burst.map(r => r.json.error.message);
  assert.equal(
    reasons.filter(m => m === 'Too many concurrent requests for user.').length,
    9,
    'three refusals in flight, nine more turned away',
  );
  const gmail = h.emu.log.filter(e => e.service === 'gmail').slice(1);
  assert.equal(
    Math.max(...gmail.map(e => e.inFlight)),
    12,
    'the log shows the whole burst in flight',
  );
  assert.throws(() => maxInFlight(h.emu.log, 3), 'a "3 in flight" assertion catches the burst');
  assert.equal(h.emu.inFlight(), 0);
});

test('dailyLimitExceeded stops every call until midnight Pacific, across a DST change', async () => {
  // Sunday 2026-11-01 00:30 PDT. Clocks go back at 02:00, so this day is 25 hours long.
  const h = await setup({ start: Date.UTC(2026, 10, 1, 7, 30) });
  h.emu.setDailyLimit('dailyLimitExceeded');
  const resetsAt = Date.UTC(2026, 10, 2, 8, 0); // 2026-11-02 00:00 PST
  assert.equal(h.emu.dailyLimit()!.resetsAt, resetsAt);

  const refused = await h.api('/profile');
  assert.equal(refused.status, 403);
  assert.deepEqual(refused.json.error.errors, [
    { message: 'Daily Limit Exceeded', domain: 'usageLimits', reason: 'dailyLimitExceeded' },
  ]);
  assert.equal(h.emu.log.at(-1)!.units, 0);

  await h.clock.advanceTo(resetsAt - 1000);
  await h.renew();
  assert.equal(
    (await h.api('/profile')).status,
    403,
    'a fixed +24 h would already have reset; Pacific midnight has not come',
  );
  await h.clock.advanceTo(resetsAt);
  assert.equal((await h.api('/profile')).status, 200);
  assert.equal(h.emu.dailyLimit(), null);
});

test('quotaExceeded uses its own reason, and the next midnight is 23 hours away in spring', async () => {
  // Saturday 2026-03-07 12:00 PST; clocks go forward on the 8th, so the 8th has 23 hours.
  const h = await setup({ start: Date.UTC(2026, 2, 7, 20, 0) });
  h.emu.setDailyLimit('quotaExceeded');
  assert.equal(h.emu.dailyLimit()!.resetsAt, Date.UTC(2026, 2, 8, 8, 0));
  const refused = await h.api('/messages');
  assert.equal(refused.status, 403);
  assert.equal(refused.json.error.errors[0].reason, 'quotaExceeded');
  assert.equal(refused.json.error.errors[0].domain, 'usageLimits');
  h.emu.setDailyLimit(null);
  assert.equal((await h.api('/messages')).status, 200);
  // Midnight after that one is PDT: 07:00 UTC on the 9th.
  await h.clock.advanceTo(Date.UTC(2026, 2, 8, 12, 0));
  h.emu.setDailyLimit('dailyLimitExceeded');
  assert.equal(h.emu.dailyLimit()!.resetsAt, Date.UTC(2026, 2, 9, 7, 0));
});

test('sending above the daily limit gets 429 "Mail sending", and sent mail keeps its Message-ID', async () => {
  const h = await setup({ sendLimitPerDay: 2, unitsPerMinute: 100_000 });
  const send = (id: string) =>
    h.api('/messages/send', { method: 'POST', body: { raw: rawMessage({ messageId: id }) } });
  const first = await send('first@client.example.test');
  assert.equal(first.status, 200);
  assert.deepEqual(first.json.labelIds, ['SENT']);
  assert.equal((await send('second@client.example.test')).status, 200);

  const unitsBefore = h.emu.meter.unitsInWindow();
  const refused = await send('third@client.example.test');
  assert.equal(refused.status, 429);
  // 2026-10-27 09:00 PDT; sending works again at the next Pacific midnight.
  assert.equal(
    refused.json.error.message,
    'User-rate limit exceeded.  Retry after 2026-10-28T07:00:00.000Z (Mail sending)',
  );
  assert.equal(
    refused.headers.get('retry-after'),
    null,
    'no Retry-After header unless the setting asks for one',
  );
  assert.equal(refused.json.error.errors[0].reason, 'rateLimitExceeded');
  assert.equal(h.emu.meter.unitsInWindow(), unitsBefore, 'a refused send costs nothing');

  const sent = h.emu.mailbox.listMessages().filter(m => m.labelIds.includes('SENT'));
  assert.deepEqual(sent.map(m => m.messageId).sort(), [
    'first@client.example.test',
    'second@client.example.test',
  ]);
  const full = await h.api(`/messages/${first.json.id}?format=metadata&metadataHeaders=Message-ID`);
  assert.deepEqual(full.json.payload.headers, [
    { name: 'Message-ID', value: '<first@client.example.test>' },
  ]);

  // drafts.send counts too, and the limit resets at midnight Pacific.
  const draft = await h.api('/drafts', {
    method: 'POST',
    body: { message: { raw: rawMessage({}) } },
  });
  assert.equal(
    (await h.api('/drafts/send', { method: 'POST', body: { id: draft.json.id } })).status,
    429,
  );
  await h.clock.advanceTo(nextPacificMidnight(h.clock.now()));
  await h.renew();
  assert.equal(
    (await h.api('/drafts/send', { method: 'POST', body: { id: draft.json.id } })).status,
    200,
  );
});

test('upload endpoint accepts message/rfc822 and keeps the Message-ID', async () => {
  const h = await setup();
  const raw = Buffer.from(
    Buffer.from(rawMessage({ messageId: 'uploaded@client.example.test' }), 'base64url'),
  );
  const response = await h.emu.fetch(
    'https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media',
    {
      method: 'POST',
      headers: { authorization: `Bearer ${h.token}`, 'content-type': 'message/rfc822' },
      body: raw,
    },
  );
  const sent = await result(response);
  assert.equal(sent.status, 200);
  assert.equal(h.emu.mailbox.getMessage(sent.json.id)!.messageId, 'uploaded@client.example.test');
  const resumable = await h.emu.fetch(
    'https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=resumable',
    {
      method: 'POST',
      headers: { authorization: `Bearer ${h.token}` },
      body: raw,
    },
  );
  assert.equal(resumable.status, 400);
});

test('a token without gmail.modify is refused with insufficientPermissions', async () => {
  const h = await setup({ scopes: ['openid', SCOPE.calendarEvents] });
  const refused = await h.api('/profile');
  assert.equal(refused.status, 403);
  assert.equal(refused.json.error.status, 'PERMISSION_DENIED');
  assert.equal(refused.json.error.message, 'Request had insufficient authentication scopes.');
  assert.equal(refused.json.error.errors[0].reason, 'insufficientPermissions');
  assert.equal(refused.json.error.details[0].reason, 'ACCESS_TOKEN_SCOPE_INSUFFICIENT');
  assert.equal(h.emu.log.at(-1)!.units, 0);
});

test('filters and sendAs writes need gmail.settings.basic', async () => {
  const modifyOnly = await setup({ scopes: ['openid', SCOPE.gmailModify] });
  const body = { criteria: { from: 'news@example.test' }, action: { removeLabelIds: ['INBOX'] } };
  const refused = await modifyOnly.api('/settings/filters', { method: 'POST', body });
  assert.equal(refused.status, 403);
  assert.equal(refused.json.error.errors[0].reason, 'insufficientPermissions');
  assert.equal(
    (await modifyOnly.api('/settings/filters')).status,
    200,
    'reading filters is allowed with gmail.modify',
  );

  const settingsOnly = await setup({ scopes: ['openid', SCOPE.gmailSettingsBasic] });
  assert.equal((await settingsOnly.api('/settings/filters', { method: 'POST', body })).status, 200);
  assert.equal((await settingsOnly.api('/messages')).status, 403);
});

test('access tokens expire after 3599 s with a 401 authError', async () => {
  const h = await setup();
  await h.clock.advance(3598_000);
  assert.equal((await h.api('/profile')).status, 200);
  await h.clock.advance(1_000);
  const expired = await h.api('/profile');
  assert.equal(expired.status, 401);
  assert.equal(expired.json.error.status, 'UNAUTHENTICATED');
  assert.equal(expired.json.error.errors[0].reason, 'authError');
  await h.renew();
  assert.equal((await h.api('/profile')).status, 200);
  h.emu.oauth.expireAccessTokens();
  assert.equal((await h.api('/profile')).status, 401);
  const missing = await result(
    await h.emu.fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile'),
  );
  assert.equal(missing.status, 401);
});

test('origins the emulator does not serve are blocked, and Calendar is served by the same emulator', async () => {
  const h = await setup();
  await assert.rejects(h.emu.fetch('https://api.groq.com/openai/v1/models'), (error: unknown) => {
    assert.ok(error instanceof TypeError);
    assert.equal((error as Error).message, 'External network blocked: https://api.groq.com');
    return true;
  });
  await assert.rejects(
    h.emu.fetch('http://gmail.googleapis.com/gmail/v1/users/me/profile'),
    /External network blocked: http:\/\/gmail\.googleapis\.com/,
  );
  assert.deepEqual(h.emu.blockedOrigins, ['https://api.groq.com', 'http://gmail.googleapis.com']);

  const calendar = await result(
    await h.emu.fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList', {
      headers: { authorization: `Bearer ${h.token}` },
    }),
  );
  // Calendar is routed (this token lacks the calendar scope) and logged under its own service.
  assert.equal(calendar.status, 403);
  assert.equal(calendar.json.error.errors[0].reason, 'insufficientPermissions');
  assert.equal(h.emu.log.at(-1)!.service, 'gcal');
  assert.equal(h.emu.log.at(-1)!.apiMethod, 'calendar.calendarList.list');
});

test('request log holds no subjects, bodies, addresses, tokens or queries', async () => {
  const h = await setup({ threads: 25 });
  const secretQuery = 'zebra-cartography-secret';
  await h.api(`/messages?q=${secretQuery}`);
  const list = await h.api('/threads?maxResults=5');
  for (const t of list.json.threads) await h.api(`/threads/${t.id}?format=full`);
  await h.api('/messages/send', {
    method: 'POST',
    body: {
      raw: rawMessage({
        to: 'someone.private@example.test',
        subject: 'Private subject line',
        body: 'Private body words',
      }),
    },
  });
  await h.api('/settings/filters', {
    method: 'POST',
    body: {
      criteria: { from: 'filter.address@example.test' },
      action: { removeLabelIds: ['INBOX'] },
    },
  });
  await h.api(`/messages?q=${secretQuery}`);

  const logText = JSON.stringify(h.emu.log);
  const secrets: string[] = [
    secretQuery,
    h.token,
    h.refreshToken!,
    'someone.private',
    'Private subject',
    'Private body',
    'filter.address',
    'test.user',
    'example.test',
    'Bearer',
  ];
  for (const message of h.emu.mailbox.listMessages())
    secrets.push(message.subject, message.from, message.snippet.slice(0, 40), message.messageId);
  for (const secret of secrets.filter(Boolean))
    assert.ok(!logText.includes(secret), `log leaks ${secret}`);

  const allowed = new Set([
    'seq',
    'at',
    'service',
    'apiMethod',
    'httpMethod',
    'units',
    'status',
    'reason',
    'inFlight',
    'fault',
    'account',
    'batch',
  ]);
  for (const entry of h.emu.log)
    for (const key of Object.keys(entry))
      assert.ok(allowed.has(key), `unexpected log field ${key}`);
});

test('the fault hook can replace, drop, lose or corrupt an answer, and every one is logged', async () => {
  const plan: Record<string, ReturnType<FaultHook['intercept']>> = {};
  const seen: string[] = [];
  const faults: FaultHook = {
    intercept(request) {
      seen.push(`${request.service}:${request.apiMethod}:${request.cost}`);
      return plan[request.apiMethod];
    },
  };
  const h = await setup({ faults });
  seen.length = 0;

  plan['gmail.users.getProfile'] = {
    kind: 'respond',
    response: new Response(
      '{"error":{"code":503,"message":"x","errors":[{"reason":"backendError"}]}}',
      { status: 503 },
    ),
  };
  const replaced = await h.api('/profile');
  assert.equal(replaced.status, 503);
  assert.equal(h.emu.log.at(-1)!.fault, 'respond');
  assert.equal(h.emu.log.at(-1)!.reason, 'backendError');
  assert.equal(h.emu.log.at(-1)!.units, 0, 'a replaced answer is not charged by default');

  plan['gmail.users.getProfile'] = {
    kind: 'respond',
    response: new Response('{}', { status: 500 }),
    charge: true,
  };
  await h.api('/profile');
  assert.equal(h.emu.log.at(-1)!.units, 1);

  plan['gmail.users.getProfile'] = { kind: 'drop' };
  await assert.rejects(h.api('/profile'), TypeError);
  assert.equal(h.emu.log.at(-1)!.fault, 'drop');

  plan['gmail.users.messages.send'] = { kind: 'dropAfter' };
  await assert.rejects(
    h.api('/messages/send', {
      method: 'POST',
      body: { raw: rawMessage({ messageId: 'lost-reply@client.example.test' }) },
    }),
    TypeError,
  );
  assert.ok(
    h.emu.mailbox.listMessages().some(m => m.messageId === 'lost-reply@client.example.test'),
    'the write happened',
  );
  assert.equal(h.emu.log.at(-1)!.units, 100);
  assert.equal(h.emu.log.at(-1)!.status, 200);

  plan['gmail.users.labels.list'] = { kind: 'corrupt' };
  const corrupt = await h.api('/labels');
  assert.equal(corrupt.status, 200);
  assert.equal(corrupt.json, undefined, 'truncated JSON does not parse');
  assert.ok(corrupt.text.startsWith('{"labels"'));

  assert.ok(seen.includes('gmail:gmail.users.messages.send:100'));
});
