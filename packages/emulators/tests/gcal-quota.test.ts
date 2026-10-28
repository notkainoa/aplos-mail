import assert from 'node:assert/strict';
import test from 'node:test';
import { SCOPE } from '../src/gmail';
import { CAL, CAL_SCOPES, setupCal, timed } from './gcal-helpers';

test('every request costs one unit and the log names service gcal and the API method', async () => {
  const t = await setupCal();
  t.emu.calendar.seed();
  await t.call('/users/me/calendarList');
  await t.call(t.events('primary', undefined, { maxResults: 5 }));
  const entries = t.emu.log.filter(e => e.service === 'gcal');
  assert.deepEqual(
    entries.map(e => e.apiMethod),
    ['calendar.calendarList.list', 'calendar.events.list'],
  );
  assert.deepEqual(
    entries.map(e => e.units),
    [1, 1],
  );
  assert.deepEqual(
    entries.map(e => e.status),
    [200, 200],
  );
  assert.equal(t.emu.calendar.meter.unitsInWindow(), 2);
});

test('the 601st request inside a sliding minute is refused, and the window slides', async () => {
  const t = await setupCal();
  for (let i = 0; i < 600; i++) {
    const ok = await t.call('/users/me/calendarList?maxResults=1');
    assert.equal(ok.status, 200, `request ${i + 1}`);
    if (i % 100 === 99) await t.clock.advance(1000); // spread over ~6 s
  }
  const refused = await t.call('/users/me/calendarList');
  assert.equal(refused.status, 403);
  assert.equal(refused.json.error.errors[0].reason, 'rateLimitExceeded');
  assert.equal(refused.json.error.errors[0].domain, 'usageLimits');
  assert.equal(t.emu.log.at(-1)!.units, 0);
  assert.equal(t.emu.calendar.meter.peakWindow(), 600);
  // The oldest charges leave the window 60 s after they were made.
  await t.clock.advance(60_000);
  assert.equal((await t.call('/users/me/calendarList')).status, 200);
});

test('600 per minute is the default and can be changed live', async () => {
  const t = await setupCal({ calendar: { requestsPerMinute: 3 } });
  assert.equal(t.emu.calendar.settings.requestsPerMinute, 3);
  for (let i = 0; i < 3; i++) assert.equal((await t.call('/users/me/calendarList')).status, 200);
  assert.equal((await t.call('/users/me/calendarList')).status, 403);
  t.emu.calendar.settings.requestsPerMinute = 4;
  assert.equal((await t.call('/users/me/calendarList')).status, 200);
  const defaults = await setupCal();
  assert.equal(defaults.emu.calendar.settings.requestsPerMinute, 600);
});

test('refusal shapes: rateLimitExceeded, userRateLimitExceeded, 429 and message-only', async () => {
  const t = await setupCal({ calendar: { requestsPerMinute: 1 } });
  await t.call('/users/me/calendarList');
  const seen: Record<string, unknown> = {};
  for (const shape of [
    'rateLimitExceeded403',
    'userRateLimitExceeded403',
    'resourceExhausted429',
    'messageOnly',
  ] as const) {
    t.emu.calendar.settings.throttleShape = shape;
    const r = await t.call('/users/me/calendarList');
    seen[shape] = [r.status, r.json.error.errors?.[0]?.reason, r.json.error.errors?.[0]?.domain];
  }
  assert.deepEqual(seen, {
    rateLimitExceeded403: [403, 'rateLimitExceeded', 'usageLimits'],
    userRateLimitExceeded403: [403, 'userRateLimitExceeded', 'usageLimits'],
    resourceExhausted429: [429, 'rateLimitExceeded', 'global'],
    messageOnly: [403, undefined, undefined],
  });
});

test('Retry-After follows the setting, in seconds or as an HTTP date, and is absent by default', async () => {
  const t = await setupCal({ calendar: { requestsPerMinute: 1 } });
  await t.call('/users/me/calendarList');
  assert.equal((await t.call('/users/me/calendarList')).headers.get('retry-after'), null);
  t.emu.calendar.settings.retryAfter = 'seconds';
  assert.equal((await t.call('/users/me/calendarList')).headers.get('retry-after'), '60');
  t.emu.calendar.settings.retryAfter = 'httpDate';
  const date = (await t.call('/users/me/calendarList')).headers.get('retry-after')!;
  assert.equal(new Date(date).getTime(), Math.ceil((t.clock.now() + 60_000) / 1000) * 1000);
});

test('refused requests are free unless chargeRefused is set', async () => {
  const free = await setupCal({ calendar: { requestsPerMinute: 1 } });
  await free.call('/users/me/calendarList');
  await free.call('/users/me/calendarList');
  await free.call('/users/me/calendarList');
  assert.equal(free.emu.calendar.meter.unitsInWindow(), 1);
  const charged = await setupCal({ calendar: { requestsPerMinute: 1, chargeRefused: true } });
  await charged.call('/users/me/calendarList');
  await charged.call('/users/me/calendarList');
  await charged.call('/users/me/calendarList');
  assert.equal(charged.emu.calendar.meter.unitsInWindow(), 3);
});

test('the Calendar budget and the Gmail budget are separate', async () => {
  const t = await setupCal({ calendar: { requestsPerMinute: 1 }, unitsPerMinute: 5 });
  await t.call('/users/me/calendarList');
  assert.equal((await t.call('/users/me/calendarList')).status, 403);
  // Gmail still works: Calendar's refusal spent none of its units.
  const profile = await t.h.api('/profile', { token: undefined });
  assert.equal(profile.status, 403); // this token has no Gmail scope, but the refusal is a scope one, not a rate one
  assert.equal(profile.json.error.errors[0].reason, 'insufficientPermissions');
  assert.equal(t.emu.meter.unitsInWindow(), 0);
});

test('anti-abuse: every write answers 403 quotaExceeded, reads keep working', async () => {
  const t = await setupCal();
  t.emu.calendar.seed();
  t.emu.setCalendarAbuse(true);
  const body = timed('Plan', '2026-11-03T10:00:00', '2026-11-03T11:00:00');
  const insert = await t.call(t.events('primary'), { method: 'POST', body });
  assert.equal(insert.status, 403);
  assert.equal(insert.json.error.errors[0].reason, 'quotaExceeded');
  assert.equal(insert.json.error.errors[0].domain, 'usageLimits');
  assert.equal(insert.json.error.message, 'Calendar usage limits exceeded.');
  for (const [method, suffix] of [
    ['PUT', 'abcde'],
    ['PATCH', 'abcde'],
    ['DELETE', 'abcde'],
  ] as const) {
    const r = await t.call(t.events('primary', suffix), {
      method,
      body: method === 'DELETE' ? undefined : {},
    });
    assert.equal(r.json.error.errors[0].reason, 'quotaExceeded', method);
  }
  assert.equal((await t.call(t.events('primary'))).status, 200);
  assert.equal(t.emu.log.filter(e => e.reason === 'quotaExceeded').length, 4);
  assert.ok(t.emu.log.filter(e => e.reason === 'quotaExceeded').every(e => e.units === 0));
  t.emu.setCalendarAbuse(false);
  assert.equal((await t.call(t.events('primary'), { method: 'POST', body })).status, 200);
});

test('anti-abuse lasts for the configured clock time and then ends by itself', async () => {
  const t = await setupCal({ calendar: { abuseDurationMs: 6 * 3600_000 } });
  const body = timed('Plan', '2026-11-03T10:00:00', '2026-11-03T11:00:00');
  t.emu.setCalendarAbuse(true);
  assert.equal(t.emu.calendar.abuse()!.until, t.clock.now() + 6 * 3600_000);
  await t.clock.advance(5 * 3600_000);
  await t.h.renew(); // the one-hour access token has expired
  assert.equal((await t.call(t.events('primary'), { method: 'POST', body })).status, 403);
  await t.clock.advance(3600_000);
  await t.h.renew();
  assert.equal(t.emu.calendar.abuse(), null);
  assert.equal((await t.call(t.events('primary'), { method: 'POST', body })).status, 200);
  // An explicit duration overrides the setting.
  t.emu.setCalendarAbuse(true, { forMs: 1000 });
  await t.clock.advance(1000);
  assert.equal((await t.call(t.events('primary'), { method: 'POST', body })).status, 200);
});

test('scopes: calendarList reads need the calendar-list scope, events need calendar.events', async () => {
  const listOnly = await setupCal({ scopes: ['openid', SCOPE.calendarList] });
  assert.equal((await listOnly.call('/users/me/calendarList')).status, 200);
  const denied = await listOnly.call(listOnly.events('primary'));
  assert.equal(denied.status, 403);
  assert.equal(denied.json.error.errors[0].reason, 'insufficientPermissions');
  assert.equal(denied.json.error.details[0].metadata.service, 'calendar-json.googleapis.com');
  assert.equal(listOnly.emu.log.at(-1)!.units, 0);

  const eventsOnly = await setupCal({ scopes: ['openid', SCOPE.calendarEvents] });
  assert.equal((await eventsOnly.call(eventsOnly.events('primary'))).status, 200);
  const noList = await eventsOnly.call('/users/me/calendarList');
  assert.equal(noList.json.error.errors[0].reason, 'insufficientPermissions');

  const readOnly = await setupCal({ scopes: ['openid', SCOPE.calendarEventsReadonly] });
  assert.equal((await readOnly.call(readOnly.events('primary'))).status, 200);
  const write = await readOnly.call(readOnly.events('primary'), {
    method: 'POST',
    body: timed('x', '2026-11-03T10:00:00', '2026-11-03T11:00:00'),
  });
  assert.equal(write.json.error.errors[0].reason, 'insufficientPermissions');
  assert.ok(CAL_SCOPES.length);
});

test('a missing or bad token is 401 and costs nothing', async () => {
  const t = await setupCal();
  const none = await t.h.emu.fetch(`${CAL}/users/me/calendarList`);
  assert.equal(none.status, 401);
  assert.equal((await t.call('/users/me/calendarList', { token: 'nope' })).status, 401);
  assert.equal(t.emu.calendar.meter.unitsInWindow(), 0);
});

test('unknown Calendar paths are 404 and still logged as gcal', async () => {
  const t = await setupCal();
  const r = await t.call('/users/me/settings');
  assert.equal(r.status, 404);
  assert.equal(t.emu.log.at(-1)!.service, 'gcal');
  assert.equal(t.emu.log.at(-1)!.apiMethod, 'unrouted');
});

test('the shared fault hook sees Calendar requests as service gcal and can answer for them', async () => {
  const seen: string[] = [];
  const t = await setupCal({
    faults: {
      intercept(request) {
        if (request.service === 'gcal')
          seen.push(`${request.service}:${request.apiMethod}:${request.cost}`);
        if (request.apiMethod === 'calendar.events.list') {
          return {
            kind: 'respond',
            response: new Response(
              JSON.stringify({
                error: {
                  code: 503,
                  message: 'Backend Error',
                  errors: [{ reason: 'backendError', domain: 'global' }],
                },
              }),
              { status: 503 },
            ),
          };
        }
        return undefined;
      },
    },
  });
  assert.equal((await t.call('/users/me/calendarList')).status, 200);
  const failed = await t.call(t.events('primary'));
  assert.equal(failed.status, 503);
  assert.deepEqual(seen, ['gcal:calendar.calendarList.list:1', 'gcal:calendar.events.list:1']);
  assert.equal(t.emu.log.at(-1)!.fault, 'respond');
  assert.equal(t.emu.log.at(-1)!.reason, 'backendError');
});
