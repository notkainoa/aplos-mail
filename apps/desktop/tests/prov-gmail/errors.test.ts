/**
 * prov-gmail refusals on the Gmail emulator: every throttle shape the emulator can produce is classified `throttle`
 * after exactly one request, `quotaExceeded` stops until Pacific midnight after one request, `invalid_grant` ends in
 * `auth` with no further calls, a re-plan during a pause sends nothing, and the log carries codes, never content.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { gmailLog, rig, type Rig } from './harness';

const windowDone = (r: Rig) => () => r.store.states.get('window:inbox')?.phase === 'done';

async function replanMany(r: Rig, times: number): Promise<void> {
  for (let i = 0; i < times; i++) await r.drive({ trigger: 'manual', maxSteps: 3 });
}

test('prov-gmail-T30 D1 a manual re-plan during a throttle pause, a daily stop or an auth block makes zero requests', async () => {
  for (const cls of ['throttle', 'daily', 'auth'] as const) {
    const r = await rig({ threads: 120 });
    await r.drive({ maxSteps: 2 });
    r.governor.apply({
      class: cls,
      provider: 'gmail',
      method: 'gmail.messages.get',
      reason: 'test',
      resumeAt: r.clock.now() + 3_600_000,
    });
    const before = r.fetches.length;
    const logBefore = r.emu.log.length;
    await replanMany(r, 100);
    assert.equal(r.fetches.length, before, `${cls}: no fetch`);
    assert.equal(
      r.emu.log.length,
      logBefore,
      `${cls}: the emulator saw nothing (token endpoint included)`,
    );
    const last = r.store.commits.at(-1)!.result;
    assert.equal(last.done, false);
    assert.equal(last.costUnits, 0);
  }
});

test('prov-gmail-T23 D6 quotaExceeded makes one request, then a stop until the next midnight in Los Angeles', async () => {
  const r = await rig({ threads: 120 });
  r.emu.setDailyLimit('quotaExceeded');
  await r.drive({ maxSteps: 5 });
  assert.equal(gmailLog(r.emu).length, 1, 'exactly one request reached Gmail');
  const { error, scope } = r.governor.errors[0];
  assert.equal(error.class, 'daily');
  assert.equal(error.reason, 'quotaExceeded');
  assert.equal(error.status, 403);
  assert.equal(scope, 'account');
  // The fake clock starts 2026-10-27 09:00 PDT; the next Pacific midnight is 07:00 UTC on the 28th.
  assert.equal(error.resumeAt, Date.UTC(2026, 9, 28, 7, 0, 0));
  await r.clock.advance(10 * 3_600_000);
  await replanMany(r, 100);
  assert.equal(gmailLog(r.emu).length, 1, 'still one request ten hours and 100 manual syncs later');
  await r.clock.advanceTo(error.resumeAt! + 1);
  await r.drive({ trigger: 'resume', maxSteps: 1 });
  const after = gmailLog(r.emu, error.resumeAt!);
  assert.ok(
    after.length >= 1 && after.every(e => e.status === 200),
    'after the reset Gmail answers again',
  );
});

test('prov-gmail-T24 D6 dailyLimitExceeded stops every account of the project the same way', async () => {
  const r = await rig({ threads: 120 });
  r.emu.setDailyLimit('dailyLimitExceeded');
  await r.drive({ maxSteps: 5 });
  assert.equal(gmailLog(r.emu).length, 1);
  const { error, scope } = r.governor.errors[0];
  assert.equal(error.class, 'daily');
  assert.equal(error.reason, 'dailyLimitExceeded');
  assert.equal(scope, 'project');
  assert.equal(error.resumeAt, Date.UTC(2026, 9, 28, 7, 0, 0));
});

test('prov-gmail-T26 D4 invalid_grant ends in an auth classification and no further calls, token endpoint included', async () => {
  const r = await rig({ threads: 120 });
  await r.drive({ maxSteps: 2 });
  r.emu.oauth.revoke(r.account.address);
  const since = r.emu.log.length;
  await r.drive({ trigger: 'poll', until: windowDone(r), maxSteps: 5 });
  const after = r.emu.log.slice(since);
  assert.deepEqual(
    after.map(e => [e.service, e.status]),
    [
      ['gmail', 401],
      ['oauth', 400],
    ],
    'one Gmail 401, one forced refresh refused, nothing else',
  );
  assert.equal(after[1].apiMethod, 'oauth.token');
  const last = r.governor.errors.at(-1)!.error;
  assert.equal(last.class, 'auth');
  assert.equal(last.reason, 'invalid_grant');
  assert.equal(last.provider, 'oauth');
  await r.clock.advance(24 * 3_600_000);
  await replanMany(r, 100);
  assert.equal(
    r.emu.log.length,
    since + 2,
    'zero Gmail and zero token calls over the next 24 hours',
  );
});

test('prov-gmail-T20/T69 D6 every per-minute refusal the emulator produces is a throttle after exactly one request', async () => {
  const shapes = [
    'rateLimitExceeded403',
    'userRateLimitExceeded403',
    'resourceExhausted429',
    'messageOnly',
  ] as const;
  for (const throttleShape of shapes) {
    // A 100-unit quota and a governor that does not know it: the second batch is refused.
    const r = await rig({ threads: 120, emulator: { unitsPerMinute: 100, throttleShape } });
    await r.drive({ maxSteps: 5 });
    // A refused batch is one HTTP request even when several of its parts carry the refusal.
    const refusedRequests = (since = 0) =>
      new Set(
        r.emu.log
          .filter(e => e.at >= since && (e.status === 403 || e.status === 429))
          .map(e => e.batch ?? e.seq),
      ).size;
    assert.equal(refusedRequests(), 1, `${throttleShape}: one refused request, no retry`);
    const { error } = r.governor.errors[0];
    assert.equal(error.class, 'throttle', throttleShape);
    assert.equal(
      error.reason,
      throttleShape === 'userRateLimitExceeded403' ? 'userRateLimitExceeded' : 'rateLimitExceeded',
    );
    assert.equal(
      r.store.commits.at(-1)!.result.done,
      false,
      'the step stops and hands back what it has',
    );
    const logged = r.emu.log.length;
    await replanMany(r, 10);
    assert.equal(r.emu.log.length, logged, 'the pause holds: nothing more reaches Gmail');
    assert.equal(refusedRequests(), 1);
  }
});

test('prov-gmail-T20 D6 the concurrency 429 is a throttle that asks for one in flight', async () => {
  const r = await rig({ threads: 20, emulator: { concurrency: 0 } });
  await r.drive({ maxSteps: 3 });
  const { error } = r.governor.errors[0];
  assert.equal(error.class, 'throttle');
  assert.equal(error.concurrency, true);
  assert.equal(r.emu.log.filter(e => e.status === 429).length, 1);
});

test('prov-gmail-T20 D6 Retry-After from the emulator sets the pause, in seconds and as an HTTP date', async () => {
  for (const retryAfter of ['seconds', 'httpDate'] as const) {
    const r = await rig({ threads: 120, emulator: { unitsPerMinute: 100, retryAfter } });
    await r.drive({ maxSteps: 5 });
    const { error } = r.governor.errors[0];
    assert.equal(error.class, 'throttle');
    assert.ok(
      error.retryAfterMs! > 0 && error.retryAfterMs! <= 61_000,
      `${retryAfter}: ${error.retryAfterMs} ms`,
    );
  }
});

test('prov-gmail-T66/T67 log lines carry status, reason, method, units and class, and no content', async () => {
  const r = await rig({ threads: 200, emulator: { throttleShape: 'messageOnly' } });
  await r.drive({ until: windowDone(r), maxSteps: 100 });
  const searchText = 'subject:Notes';
  await r.adapter.search!({ text: searchText, limit: 25 }, r.ctx());
  // Now a refusal: squeeze the quota under what the governor believes.
  r.emu.settings.unitsPerMinute = 1;
  await r.clock.advance(61_000);
  await r.drive({ trigger: 'manual', scopes: ['history'], maxSteps: 2 });

  const lines = r.log.lines;
  const requests = lines.filter(l => l.event === 'sync.gmail.request');
  const refused = lines.filter(l => l.event === 'sync.gmail.request_refused');
  assert.ok(requests.length > 10);
  assert.ok(refused.length >= 1);
  for (const l of requests) {
    assert.equal(typeof l.fields.method, 'string');
    assert.equal(typeof l.fields.status, 'number');
    assert.equal(typeof l.fields.units, 'number');
  }
  for (const l of refused) {
    const e = l.fields.error as Record<string, unknown>;
    assert.equal(typeof e.status, 'number');
    assert.equal(typeof e.reason, 'string');
    assert.equal(typeof e.method, 'string');
    assert.equal(typeof e.class, 'string');
    assert.equal(typeof l.fields.units, 'number');
    assert.ok(String(e.providerMessage ?? '').length <= 300);
  }

  const text = JSON.stringify(lines);
  const canaries = new Set<string>([
    r.tokens.access,
    r.tokens.refreshToken,
    searchText,
    r.account.address,
  ]);
  for (const m of r.emu.mailbox.listMessages()) {
    canaries.add(m.subject);
    canaries.add(m.messageId);
    if (m.snippet.length > 12) canaries.add(m.snippet.slice(0, 40));
    for (const address of `${m.from} ${m.to}`.match(/[\w.+-]+@[\w.-]+/g) ?? [])
      canaries.add(address);
  }
  canaries.delete('');
  for (const canary of canaries)
    assert.ok(
      !text.includes(canary),
      'a subject, address, snippet, token or query reached the log',
    );
  assert.ok(canaries.size > 100, `scanned ${canaries.size} canaries`);
});
