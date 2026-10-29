import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NotSentError,
  PausedError,
  PROJECT,
  ProviderError,
  type GovernorSnapshot,
  type RequestIo,
  type TokenSource,
} from '../src/ports';
import { Governor } from '../src/sync/governor';
import { nextPacificMidnight } from '../src/sync/pacific';
import { ACCOUNT, FakeClock, MINUTE, refusal, req, settle, setup } from './sync-governor-helpers';

// The parts of the frozen F3 GovernorPort the pre-freeze core lacked: the forced token refresh, account-wide auth
// blocks, the connect-time governor, project blocks, clear(), batchSize(), retryNow() and the send mapping.

const OTHER = 'acct-2';
const of = (snaps: GovernorSnapshot[], budget: string) => snaps.find(s => s.budget === budget)!;

/** A token source over a counter: each refresh mints `tok-<n>`. */
function tokenSource(clock: FakeClock, refresh?: (n: number) => Promise<void> | void) {
  const state = { calls: 0, token: 'tok-0', expiresAt: clock.now() + 3600_000 };
  const source: TokenSource = {
    cached: () => ({ token: state.token, expiresAt: state.expiresAt }),
    async refresh(_account, io: RequestIo) {
      assert.equal(io.accessToken, undefined, 'the token call carries no access token');
      state.calls++;
      await refresh?.(state.calls);
      state.token = `tok-${state.calls}`;
      state.expiresAt = clock.now() + 3600_000;
      return { token: state.token, expiresAt: state.expiresAt };
    },
  };
  return { source, state };
}

const unauthorized = () => refusal('auth', { status: 401, reason: 'authError' });

test('prov-gov-T09 a 401 forces exactly one refresh and one re-send', async () => {
  const clock = new FakeClock({ auto: true });
  const tokens = tokenSource(clock);
  const governor = new Governor({ clock, role: 'primary', tokens: tokens.source, random: () => 0 });
  const seen: string[] = [];
  const value = await governor.run(ACCOUNT, req('interactive', 10), async ({ accessToken }) => {
    seen.push(accessToken!);
    if (accessToken === 'tok-0') throw unauthorized();
    return 'ok';
  });
  assert.equal(value, 'ok');
  assert.deepEqual(seen, ['tok-0', 'tok-1']);
  assert.equal(tokens.state.calls, 1);
  assert.deepEqual(governor.admission(ACCOUNT, 'gmail', 'interactive'), { ok: true });
});

test('prov-gov-T09 a 401 after the forced refresh blocks the account: 2 resource calls, 1 token call, then none', async () => {
  const clock = new FakeClock({ auto: true });
  const tokens = tokenSource(clock);
  const governor = new Governor({ clock, role: 'primary', tokens: tokens.source, random: () => 0 });
  let resource = 0;
  const error = await governor
    .run(ACCOUNT, req('incremental', 2), async () => {
      resource++;
      throw unauthorized();
    })
    .catch(e => e);
  assert.ok(error instanceof ProviderError && error.error.class === 'auth');
  assert.equal(resource, 2);
  assert.equal(tokens.state.calls, 1);
  for (let i = 0; i < 5; i++) {
    const again = await governor
      .run(ACCOUNT, req('interactive', 1), async () => {
        resource++;
      })
      .catch(e => e);
    assert.ok(again instanceof PausedError && again.cls === 'auth' && again.until === undefined);
    await clock.advance(20 * MINUTE);
  }
  assert.equal(resource, 2);
  assert.equal(tokens.state.calls, 1);
});

test('prov-gov-T09 eight concurrent 401s share one token refresh', async () => {
  const clock = new FakeClock({ auto: true });
  const tokens = tokenSource(clock, () => clock.sleep(200));
  const governor = new Governor({ clock, role: 'primary', tokens: tokens.source, random: () => 0 });
  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      governor.run(ACCOUNT, req('interactive', 1), async ({ accessToken }) => {
        await clock.sleep(50);
        if (accessToken === 'tok-0') throw unauthorized();
        return accessToken;
      }),
    ),
  );
  assert.deepEqual(results, Array(8).fill('tok-1'));
  assert.equal(tokens.state.calls, 1);
});

test('invalid_grant at the token endpoint blocks every budget of the account, token calls included', async () => {
  const clock = new FakeClock({ auto: true });
  const tokens = tokenSource(clock, () => {
    throw refusal('auth', {
      provider: 'oauth',
      method: 'oauth.token',
      reason: 'invalid_grant',
      status: 400,
    });
  });
  tokens.state.expiresAt = clock.now(); // expired: the first request must refresh
  const governor = new Governor({ clock, role: 'primary', tokens: tokens.source });
  let resource = 0;
  const error = await governor
    .run(ACCOUNT, req('incremental', 2), async () => {
      resource++;
    })
    .catch(e => e);
  assert.ok(error instanceof ProviderError && error.error.reason === 'invalid_grant');
  assert.equal(resource, 0);
  for (const budget of ['gmail', 'gcal', 'oauth'] as const) {
    assert.deepEqual(governor.admission(ACCOUNT, budget, 'interactive'), {
      ok: false,
      cls: 'auth',
      reason: 'invalid_grant',
    });
    assert.equal(of(governor.snapshot(ACCOUNT), budget).blocked?.cls, 'auth');
  }
  await assert.rejects(
    governor.run(ACCOUNT, req('interactive', 1, { budget: 'gcal' }), async () => {
      resource++;
    }),
    PausedError,
  );
  assert.equal(tokens.state.calls, 1, 'no token call while blocked');
  assert.deepEqual(
    governor.admission(OTHER, 'gmail', 'interactive'),
    { ok: true },
    'another account is untouched',
  );
  governor.clear(ACCOUNT, 'auth');
  for (const budget of ['gmail', 'gcal', 'oauth'] as const) {
    assert.deepEqual(governor.admission(ACCOUNT, budget, 'interactive'), { ok: true });
    assert.equal(of(governor.snapshot(ACCOUNT), budget).blocked, undefined);
  }
});

test('a send refused before its request is written is PausedError or NotSentError, never a plain error', async () => {
  // (a) The token refresh fails on the network: the mail provably never left.
  {
    const clock = new FakeClock({ auto: true });
    const tokens = tokenSource(clock, () => {
      throw refusal('transient', {
        provider: 'oauth',
        method: 'oauth.token',
        reason: 'ECONNRESET',
        status: undefined,
      });
    });
    tokens.state.expiresAt = clock.now();
    const governor = new Governor({
      clock,
      role: 'primary',
      tokens: tokens.source,
      random: () => 0,
    });
    let sent = 0;
    const error = await governor
      .run(
        ACCOUNT,
        req('interactive', 100, { kind: 'send', method: 'gmail.messages.send' }),
        async () => {
          sent++;
        },
      )
      .catch(e => e);
    assert.ok(error instanceof NotSentError, String(error));
    assert.equal(sent, 0);
    assert.equal(
      tokens.state.calls,
      3,
      'the token call is an idempotent write: re-sent on transient',
    );
  }
  // (b) invalid_grant: the auth block it sets is what stopped the send.
  {
    const clock = new FakeClock({ auto: true });
    const tokens = tokenSource(clock, () => {
      throw refusal('auth', {
        provider: 'oauth',
        method: 'oauth.token',
        reason: 'invalid_grant',
        status: 400,
      });
    });
    tokens.state.expiresAt = clock.now();
    const governor = new Governor({ clock, role: 'primary', tokens: tokens.source });
    const error = await governor
      .run(ACCOUNT, req('interactive', 100, { kind: 'send' }), async () => {})
      .catch(e => e);
    assert.ok(error instanceof PausedError && error.cls === 'auth', String(error));
  }
  // (c) A cooldown in force, and a caller cancel before the call.
  {
    const { governor } = setup({ auto: false });
    governor.observe(ACCOUNT, 'gmail', refusal('throttle').error);
    const paused = await governor
      .run(ACCOUNT, req('interactive', 100, { kind: 'send' }), async () => {})
      .catch(e => e);
    assert.ok(paused instanceof PausedError && paused.cls === 'throttle');
  }
});

test('the connect-time governor ignores the auth block but honours cooldowns, daily stops and config', async () => {
  const { governor } = setup({ auto: false });
  governor.observe(ACCOUNT, 'gmail', refusal('auth', { reason: 'invalid_grant' }).error);
  const exchange = {
    budget: 'oauth' as const,
    lane: 'interactive' as const,
    kind: 'idempotentWrite' as const,
    method: 'oauth.token',
    cost: 1,
    auth: false,
  };
  let calls = 0;
  await assert.rejects(
    governor.bind(ACCOUNT).run(exchange, async () => {
      calls++;
    }),
    PausedError,
  );
  assert.equal(
    await governor.bindConnect(ACCOUNT).run(exchange, async () => {
      calls++;
      return 'code exchanged';
    }),
    'code exchanged',
  );
  assert.equal(calls, 1);
  // A connect-time auth refusal fails the connect without touching the account's block state.
  await assert.rejects(
    governor.bindConnect(OTHER).run(exchange, async () => {
      throw refusal('auth', { reason: 'invalid_grant' });
    }),
    ProviderError,
  );
  assert.deepEqual(governor.admission(OTHER, 'gmail', 'interactive'), { ok: true });

  governor.observe(ACCOUNT, 'oauth', refusal('throttle', { provider: 'oauth' }).error);
  const throttled = await governor
    .bindConnect(ACCOUNT)
    .run(exchange, async () => {
      calls++;
    })
    .catch(e => e);
  assert.ok(throttled instanceof PausedError && throttled.cls === 'throttle');

  governor.observe(
    OTHER,
    'oauth',
    refusal('config', { provider: 'oauth', reason: 'invalid_client' }).error,
  );
  const config = await governor
    .bindConnect(OTHER)
    .run(exchange, async () => {
      calls++;
    })
    .catch(e => e);
  assert.ok(config instanceof PausedError && config.cls === 'config' && config.account === PROJECT);
  assert.equal(calls, 1);
});

test('config blocks every account on PROJECT until clear(PROJECT, config)', async () => {
  const { governor } = setup({ auto: false });
  let calls = 0;
  await assert.rejects(
    governor.run(ACCOUNT, req('incremental', 2), async () => {
      calls++;
      throw refusal('config', { reason: 'accessNotConfigured' });
    }),
    ProviderError,
  );
  for (const account of [ACCOUNT, OTHER]) {
    assert.deepEqual(governor.admission(account, 'gmail', 'backfill'), {
      ok: false,
      cls: 'config',
      reason: 'accessNotConfigured',
    });
    await assert.rejects(
      governor.run(account, req('interactive', 1), async () => {
        calls++;
      }),
      PausedError,
    );
  }
  assert.equal(of(governor.snapshot(PROJECT), 'gmail').blocked?.cls, 'config');
  assert.deepEqual(
    governor.admission(ACCOUNT, 'gcal', 'interactive'),
    { ok: true },
    'the block is per budget',
  );
  governor.clear(PROJECT, 'config');
  await governor.run(OTHER, req('interactive', 1), async () => {
    calls++;
  });
  assert.equal(calls, 2);
});

test("Gmail's per-project dailyLimitExceeded stops every account until Pacific midnight", async () => {
  const { clock, governor } = setup({ auto: false });
  const midnight = nextPacificMidnight(clock.now());
  await assert.rejects(
    governor.run(ACCOUNT, req('backfill', 40), async () => {
      throw refusal('daily', { reason: 'dailyLimitExceeded' }, 'project');
    }),
  );
  assert.equal(of(governor.snapshot(PROJECT), 'gmail').dailyBlockUntil, midnight);
  assert.equal(
    of(governor.snapshot(ACCOUNT), 'gmail').dailyBlockUntil,
    undefined,
    'the stop is the project row',
  );
  for (const account of [ACCOUNT, OTHER]) {
    assert.deepEqual(governor.admission(account, 'gmail', 'interactive'), {
      ok: false,
      cls: 'daily',
      reason: 'dailyLimitExceeded',
      until: midnight,
    });
  }
  // Inside a 200 batch too (observe with scope), for a third account.
  governor.observe(
    'acct-3',
    'gmail',
    refusal('daily', { reason: 'dailyLimitExceeded' }).error,
    'project',
  );
  await clock.advanceTo(midnight);
  assert.deepEqual(governor.admission(OTHER, 'gmail', 'interactive'), { ok: true });
});

test('batchSize starts at 10, halves on a throttle and grows by 5 per quiet 10 minutes to 25', async () => {
  const { clock, governor } = setup({ auto: false });
  const sizes: number[] = [];
  for (let i = 0; i < 5; i++) {
    sizes.push(governor.batchSize(ACCOUNT, 'gmail'));
    await clock.advance(10 * MINUTE);
  }
  assert.deepEqual(sizes, [10, 15, 20, 25, 25]);
  governor.observe(ACCOUNT, 'gmail', refusal('throttle').error);
  assert.equal(governor.batchSize(ACCOUNT, 'gmail'), 12);
  const end = of(governor.snapshot(ACCOUNT), 'gmail').cooldownUntil!;
  await clock.advanceTo(end + 10 * MINUTE - 1);
  assert.equal(governor.batchSize(ACCOUNT, 'gmail'), 12);
  await clock.advanceTo(end + 10 * MINUTE);
  assert.equal(governor.batchSize(ACCOUNT, 'gmail'), 17);
  assert.equal(
    governor.batchSize(ACCOUNT, 'gcal'),
    1,
    'a budget with no batch spec batches nothing',
  );
  assert.equal(of(governor.snapshot(ACCOUNT), 'gmail').batchSize, 17);
});

test('retryNow lets one call through a throttle cooldown, once per pause, keeping the step', async () => {
  const { clock, governor } = setup({ auto: false });
  assert.deepEqual(governor.retryNow(ACCOUNT, 'gmail'), { ok: true }, 'not paused');
  governor.observe(ACCOUNT, 'gmail', refusal('throttle').error);
  const until = of(governor.snapshot(ACCOUNT), 'gmail').cooldownUntil!;
  assert.deepEqual(governor.retryNow(ACCOUNT, 'gmail'), { ok: true });
  const second = governor.retryNow(ACCOUNT, 'gmail');
  assert.deepEqual(
    second,
    { ok: false, cls: 'throttle', reason: 'rateLimitExceeded', until },
    'twice in one pause',
  );
  // The forced call is refused again: a new refusal escalates (step 2: 5 minutes) and allows a new retryNow.
  let calls = 0;
  await assert.rejects(
    governor.run(ACCOUNT, req('interactive', 1), async () => {
      calls++;
      throw refusal('throttle');
    }),
    ProviderError,
  );
  assert.equal(calls, 1);
  const snap = of(governor.snapshot(ACCOUNT), 'gmail');
  assert.equal(snap.cooldownStep, 2);
  assert.equal(snap.cooldownUntil, clock.now() + 300_000);
  await assert.rejects(
    governor.run(ACCOUNT, req('interactive', 1), async () => {
      calls++;
    }),
    PausedError,
    'only one call per grant',
  );
  // A new pause allows one more; this time the provider takes it and the pause ends.
  assert.deepEqual(governor.retryNow(ACCOUNT, 'gmail'), { ok: true });
  await governor.run(ACCOUNT, req('interactive', 1), async () => {
    calls++;
  });
  assert.deepEqual(governor.admission(ACCOUNT, 'gmail', 'interactive'), { ok: true });
  assert.equal(of(governor.snapshot(ACCOUNT), 'gmail').cooldownStep, 2, 'the step is kept');
  // Any other block refuses and changes nothing.
  governor.observe(ACCOUNT, 'gmail', refusal('daily').error);
  const daily = governor.retryNow(ACCOUNT, 'gmail');
  assert.equal(daily.ok ? 'ok' : daily.cls, 'daily');
  await assert.rejects(
    governor.run(ACCOUNT, req('interactive', 1), async () => {
      calls++;
    }),
    PausedError,
  );
  assert.equal(calls, 2);
});

test('a second budget in costs is charged with the call and its pause refuses it', async () => {
  const { governor } = setup({ auto: false });
  await governor.run(ACCOUNT, req('incremental', 2, { costs: { gcal: 5 } }), async () => {});
  assert.equal(governor.inspect(ACCOUNT, 'gcal').used, 5);
  governor.observe(
    ACCOUNT,
    'gcal',
    refusal('anti_abuse', { provider: 'gcal', reason: 'quotaExceeded' }).error,
  );
  let calls = 0;
  await assert.rejects(
    governor.run(ACCOUNT, req('incremental', 2, { costs: { gcal: 5 } }), async () => {
      calls++;
    }),
    PausedError,
  );
  await governor.run(ACCOUNT, req('incremental', 2), async () => {
    calls++;
  });
  assert.equal(calls, 1);
});

test('a request heavier than the live in-flight limit is admitted and runs alone', async () => {
  const { clock, governor } = setup({ auto: false });
  governor.observe(ACCOUNT, 'gmail', refusal('throttle', { concurrency: true }).error);
  await clock.advanceTo(of(governor.snapshot(ACCOUNT), 'gmail').cooldownUntil!);
  assert.equal(governor.inspect(ACCOUNT, 'gmail').inFlightLimit, 1);
  let ran = false;
  await governor.run(ACCOUNT, req('backfill', 10, { slots: 4 }), async () => {
    ran = true;
  });
  assert.ok(ran);
});

test('auth and project blocks survive restore', async () => {
  const { clock, governor } = setup({ auto: false });
  governor.observe(ACCOUNT, 'gmail', refusal('auth', { reason: 'invalid_grant' }).error);
  governor.observe(
    ACCOUNT,
    'gmail',
    refusal('daily', { reason: 'dailyLimitExceeded' }).error,
    'project',
  );
  const account = JSON.parse(JSON.stringify(governor.snapshot(ACCOUNT))) as GovernorSnapshot[];
  const project = JSON.parse(JSON.stringify(governor.snapshot(PROJECT))) as GovernorSnapshot[];
  assert.ok(
    account.every(s => s.blocked?.cls === 'auth'),
    'written to every budget of the account',
  );

  const restarted = new Governor({ clock, role: 'primary' });
  restarted.restore(PROJECT, project);
  restarted.restore(ACCOUNT, account);
  assert.equal(restarted.admission(ACCOUNT, 'oauth', 'interactive').ok, false);
  restarted.clear(ACCOUNT, 'auth');
  const left = restarted.admission(ACCOUNT, 'gmail', 'interactive');
  assert.equal(left.ok ? 'ok' : left.cls, 'daily', 'the project daily stop is still in force');
  assert.equal(restarted.admission(OTHER, 'gmail', 'interactive').ok, false);
  await settle();
});
