import test from 'node:test';
import assert from 'node:assert/strict';
import { COOLDOWN_STEPS_MS } from '../src/sync/governor';
import { nextPacificMidnight } from '../src/sync/pacific';
import {
  PausedError,
  PROJECT,
  ProviderError,
  type GovernorSnapshot,
  type RequestIo,
} from '../src/ports';
import {
  ACCOUNT,
  MINUTE,
  deferred,
  maxWindow,
  refusal,
  req,
  settle,
  setup,
} from './sync-governor-helpers';

const gmail = (snaps: GovernorSnapshot[]) => snaps.find(s => s.budget === 'gmail')!;
const throwing = (error: unknown) => async () => {
  throw error;
};

test('throttle cooldowns escalate 60 s, 5 min, 15 min, 1 h, stay at 1 h, and reset after 10 quiet minutes', async () => {
  const { clock, governor } = setup({ auto: false });
  for (const expected of [...COOLDOWN_STEPS_MS, 3_600_000]) {
    const at = clock.now();
    await assert.rejects(
      governor.run(ACCOUNT, req('interactive', 10), throwing(refusal('throttle'))),
      ProviderError,
    );
    const snap = gmail(governor.snapshot(ACCOUNT));
    assert.equal(snap.cooldownUntil! - at, expected);
    await clock.advanceTo(snap.cooldownUntil!);
  }
  assert.equal(gmail(governor.snapshot(ACCOUNT)).cooldownStep, 5);
  await clock.advance(10 * MINUTE - 1);
  assert.equal(gmail(governor.snapshot(ACCOUNT)).cooldownStep, 5);
  await clock.advance(1);
  assert.equal(gmail(governor.snapshot(ACCOUNT)).cooldownStep, 0);
  const at = clock.now();
  await assert.rejects(
    governor.run(ACCOUNT, req('interactive', 10), throwing(refusal('throttle'))),
    ProviderError,
  );
  assert.equal(gmail(governor.snapshot(ACCOUNT)).cooldownUntil! - at, 60_000);
});

test('a Retry-After longer than the step wins; a shorter one does not shorten the step', async () => {
  const long = setup({ auto: false });
  await assert.rejects(
    long.governor.run(
      ACCOUNT,
      req('incremental', 2),
      throwing(refusal('throttle', { retryAfterMs: 120_000 })),
    ),
  );
  assert.equal(gmail(long.governor.snapshot(ACCOUNT)).cooldownUntil! - long.clock.now(), 120_000);

  const short = setup({ auto: false });
  await assert.rejects(
    short.governor.run(
      ACCOUNT,
      req('incremental', 2),
      throwing(refusal('throttle', { retryAfterMs: 5_000 })),
    ),
  );
  assert.equal(gmail(short.governor.snapshot(ACCOUNT)).cooldownUntil! - short.clock.now(), 60_000);
});

test('AIMD halves the target to a floor of 1,000 and regrows 250 a minute only after 10 quiet minutes', async () => {
  const { clock, governor } = setup({ auto: false });
  const targets: number[] = [];
  for (let i = 0; i < 3; i++) {
    await assert.rejects(
      governor.run(ACCOUNT, req('interactive', 10), throwing(refusal('throttle'))),
    );
    const snap = gmail(governor.snapshot(ACCOUNT));
    targets.push(snap.target);
    await clock.advanceTo(snap.cooldownUntil!);
  }
  assert.deepEqual(targets, [2_250, 1_125, 1_000]);
  // The cooldown's end stays in the snapshot as the start of the quiet period (what a restart regrows from).
  const quietSince = gmail(governor.snapshot(ACCOUNT)).cooldownUntil!;
  assert.equal(quietSince, clock.now());
  await clock.advance(10 * MINUTE - 1);
  assert.equal(gmail(governor.snapshot(ACCOUNT)).target, 1_000);
  await clock.advance(1);
  assert.equal(gmail(governor.snapshot(ACCOUNT)).target, 1_250);
  await clock.advance(MINUTE);
  assert.equal(gmail(governor.snapshot(ACCOUNT)).target, 1_500);
  await clock.advance(30 * MINUTE);
  assert.equal(gmail(governor.snapshot(ACCOUNT)).target, 4_500);
});

test('after a halving, new admissions stay under the halved target', async () => {
  const { clock, governor } = setup();
  await assert.rejects(
    governor.run(ACCOUNT, req('interactive', 10), throwing(refusal('throttle'))),
  );
  await clock.advanceTo(gmail(governor.snapshot(ACCOUNT)).cooldownUntil!);
  const calls: { at: number; units: number }[] = [];
  await Promise.all(
    Array.from({ length: 100 }, () =>
      governor.run(ACCOUNT, req('interactive', 40), async () => {
        calls.push({ at: clock.now(), units: 40 });
      }),
    ),
  );
  assert.ok(maxWindow(calls) <= 2_250, `peak ${maxWindow(calls)}`);
  assert.ok(maxWindow(calls) > 2_000);
});

test('a daily refusal stops every lane until the next Pacific midnight with no calls', async () => {
  const { clock, governor } = setup({ auto: false });
  let calls = 0;
  await assert.rejects(
    governor.run(ACCOUNT, req('backfill', 40), async () => {
      calls++;
      throw refusal('daily');
    }),
    ProviderError,
  );
  const midnight = Date.UTC(2026, 9, 28, 7, 0, 0); // 2026-10-28 00:00 PDT
  assert.equal(gmail(governor.snapshot(ACCOUNT)).dailyBlockUntil, midnight);
  for (const lane of [
    'interactive',
    'opFlush',
    'incremental',
    'prefetch',
    'backfill',
    'enrichment',
  ] as const) {
    const error = await governor
      .run(ACCOUNT, req(lane, 1), async () => {
        calls++;
      })
      .catch(e => e);
    assert.ok(error instanceof PausedError);
    assert.equal(error.until, midnight);
    assert.equal(error.cls, 'daily');
    assert.deepEqual(governor.admission(ACCOUNT, 'gmail', lane), {
      ok: false,
      until: midnight,
      cls: 'daily',
      reason: 'dailyLimitExceeded',
    });
  }
  await clock.advanceTo(midnight - 1);
  await assert.rejects(
    governor.run(ACCOUNT, req('interactive', 1), async () => {
      calls++;
    }),
    PausedError,
  );
  assert.equal(calls, 1);
  await clock.advanceTo(midnight);
  assert.deepEqual(governor.admission(ACCOUNT, 'gmail', 'interactive'), { ok: true });
  await governor.run(ACCOUNT, req('interactive', 1), async () => {
    calls++;
  });
  assert.equal(calls, 2);
});

test('a daily refusal with a stated reset time stops until then', async () => {
  const { clock, governor } = setup({ auto: false });
  const resumeAt = clock.now() + 2 * 3600_000;
  await assert.rejects(
    governor.run(ACCOUNT, req('backfill', 40), throwing(refusal('daily', { resumeAt }))),
  );
  assert.equal(gmail(governor.snapshot(ACCOUNT)).dailyBlockUntil, resumeAt);
});

test('Calendar anti-abuse refusals back off for hours', async () => {
  const { clock, governor } = setup({ auto: false });
  await assert.rejects(
    governor.run(
      ACCOUNT,
      req('incremental', 1, { budget: 'gcal' }),
      throwing(refusal('anti_abuse', { provider: 'gcal', reason: 'quotaExceeded' })),
    ),
  );
  const admission = governor.admission(ACCOUNT, 'gcal', 'interactive');
  assert.deepEqual(admission, {
    ok: false,
    until: clock.now() + 3 * 3600_000,
    cls: 'anti_abuse',
    reason: 'quotaExceeded',
  });
  assert.deepEqual(governor.admission(ACCOUNT, 'gmail', 'interactive'), { ok: true });
});

test('the next Pacific midnight, across both daylight-saving changes', () => {
  assert.equal(nextPacificMidnight(Date.UTC(2026, 9, 27, 16)), Date.UTC(2026, 9, 28, 7));
  assert.equal(nextPacificMidnight(Date.UTC(2026, 9, 28, 7)), Date.UTC(2026, 9, 29, 7)); // exactly midnight: the next one
  assert.equal(nextPacificMidnight(Date.UTC(2026, 10, 1, 3)), Date.UTC(2026, 10, 1, 7)); // Oct 31 20:00 PDT
  assert.equal(nextPacificMidnight(Date.UTC(2026, 10, 1, 12)), Date.UTC(2026, 10, 2, 8)); // Nov 1 04:00 PST
  assert.equal(nextPacificMidnight(Date.UTC(2026, 2, 7, 20)), Date.UTC(2026, 2, 8, 8)); // Mar 7 12:00 PST
  assert.equal(nextPacificMidnight(Date.UTC(2026, 2, 8, 19)), Date.UTC(2026, 2, 9, 7)); // Mar 8 12:00 PDT
});

// Corrected for the frozen F3 port: the limit grows back by 1 per 10 quiet minutes (BudgetSpec.inFlight), not all at once.
test('prov-gov-T18 a concurrency refusal drops in-flight to 1, then regrows one slot per 10 quiet minutes', async () => {
  const { clock, governor } = setup({ auto: false });
  await assert.rejects(
    governor.run(
      ACCOUNT,
      req('interactive', 10),
      throwing(
        refusal('throttle', { status: 429, reason: 'concurrentLimitExceeded', concurrency: true }),
      ),
    ),
  );
  const end = gmail(governor.snapshot(ACCOUNT)).cooldownUntil!;
  assert.equal(gmail(governor.snapshot(ACCOUNT)).inFlightLimit, 1);
  await clock.advanceTo(end);

  const measure = async () => {
    const gates = [deferred(), deferred(), deferred()];
    let running = 0;
    let peak = 0;
    const runs = gates.map(gate =>
      governor.run(ACCOUNT, req('interactive', 10), async () => {
        peak = Math.max(peak, ++running);
        await gate.promise;
        running--;
      }),
    );
    await settle();
    for (const gate of gates) {
      gate.resolve();
      await settle();
    }
    await Promise.all(runs);
    return peak;
  };
  assert.equal(await measure(), 1);
  await clock.advanceTo(end + 10 * MINUTE - 1);
  assert.equal(gmail(governor.snapshot(ACCOUNT)).inFlightLimit, 1);
  await clock.advanceTo(end + 10 * MINUTE);
  assert.equal(gmail(governor.snapshot(ACCOUNT)).inFlightLimit, 2);
  assert.equal(await measure(), 2);
  await clock.advanceTo(end + 20 * MINUTE);
  assert.equal(gmail(governor.snapshot(ACCOUNT)).inFlightLimit, 3);
  assert.equal(await measure(), 3);
});

test('a transient failure of a read is retried after 1 s and 2 s, three tries in total, each re-admitted', async () => {
  const { clock, governor, logs } = setup();
  const start = clock.now();
  const at: number[] = [];
  const error = await governor
    .run(ACCOUNT, req('incremental', 2), async () => {
      at.push(clock.now() - start);
      throw refusal('transient', { status: 503 });
    })
    .catch(e => e);
  assert.ok(error instanceof ProviderError);
  assert.equal(error.error.class, 'transient');
  assert.deepEqual(at, [0, 1_000, 3_000]);
  assert.equal(logs.filter(l => l.event === 'governor.admitted').length, 3);
  assert.equal(governor.inspect(ACCOUNT, 'gmail').used, 6);

  let tries = 0;
  const value = await governor.run(
    ACCOUNT,
    req('opFlush', 5, { kind: 'idempotentWrite' }),
    async () => {
      if (++tries < 3) throw new Error('socket hang up');
      return 'applied';
    },
  );
  assert.equal(value, 'applied');
  assert.equal(tries, 3);
});

test('a transient failure of a write or a send is never re-sent and comes back uncertain', async () => {
  const { governor } = setup();
  for (const kind of ['write', 'send'] as const) {
    let calls = 0;
    const known = await governor
      .run(ACCOUNT, req('interactive', 100, { kind, method: 'gmail.messages.send' }), async () => {
        calls++;
        throw refusal('transient', { status: 502 });
      })
      .catch(e => e);
    assert.equal(calls, 1);
    assert.ok(known instanceof ProviderError);
    assert.equal(known.error.uncertain, true);

    const original = new Error('timeout');
    const unknown = await governor
      .run(ACCOUNT, req('interactive', 100, { kind }), async () => {
        calls++;
        throw original;
      })
      .catch(e => e);
    assert.equal(calls, 2);
    assert.ok(unknown instanceof ProviderError);
    assert.equal(unknown.error.reason, 'unclassified');
    assert.equal(unknown.error.uncertain, true);
    assert.equal(unknown.cause, original);
  }
  // An adapter that knows the request never left can say so.
  const notSent = refusal('transient', { uncertain: false });
  assert.equal(
    await governor
      .run(ACCOUNT, req('interactive', 100, { kind: 'send' }), throwing(notSent))
      .catch(e => e),
    notSent,
  );
});

test('a send limit is rethrown, never retried, and pauses nothing', async () => {
  const { governor } = setup({ auto: false });
  let calls = 0;
  const limit = refusal('send_limit', { status: 429, method: 'gmail.messages.send' });
  assert.equal(
    await governor
      .run(ACCOUNT, req('interactive', 100, { kind: 'send' }), async () => {
        calls++;
        throw limit;
      })
      .catch(e => e),
    limit,
  );
  assert.equal(calls, 1);
  assert.deepEqual(governor.admission(ACCOUNT, 'gmail', 'backfill'), { ok: true });
  await governor.run(ACCOUNT, req('backfill', 10), async () => {
    calls++;
  });
  assert.equal(calls, 2);
});

// Corrected after review (finding 6): this test also stopped the budget on `permission`, but port
// proposal 4 says a permission refusal changes nothing on the budget; only the capability is recorded.
test('a permission refusal is rethrown and leaves the budget running', async () => {
  const { governor } = setup({ auto: false });
  let calls = 0;
  const refused = refusal('permission', { reason: 'insufficientPermissions' });
  assert.equal(
    await governor
      .run(ACCOUNT, req('interactive', 1), async () => {
        calls++;
        throw refused;
      })
      .catch(e => e),
    refused,
  );
  assert.deepEqual(governor.admission(ACCOUNT, 'gmail', 'interactive'), { ok: true });
  await governor.run(ACCOUNT, req('incremental', 2), async () => {
    calls++;
  });
  assert.equal(calls, 2);
});

test('auth and config failures stop the budget until clear', async () => {
  for (const cls of ['auth', 'config'] as const) {
    const { governor } = setup({ auto: false });
    let calls = 0;
    await assert.rejects(
      governor.run(ACCOUNT, req('incremental', 2), async () => {
        calls++;
        throw refusal(cls);
      }),
      ProviderError,
    );
    const paused = await governor
      .run(ACCOUNT, req('interactive', 2), async () => {
        calls++;
      })
      .catch(e => e);
    assert.ok(paused instanceof PausedError);
    assert.equal(paused.until, undefined);
    assert.equal(paused.account, cls === 'config' ? PROJECT : ACCOUNT);
    assert.equal(paused.cls, cls);
    assert.equal(calls, 1);
    assert.equal(governor.admission(ACCOUNT, 'gmail', 'interactive').ok, false);
    governor.clear(cls === 'config' ? PROJECT : ACCOUNT, cls);
    assert.deepEqual(governor.admission(ACCOUNT, 'gmail', 'interactive'), { ok: true });
    await governor.run(ACCOUNT, req('interactive', 2), async () => {
      calls++;
    });
    assert.equal(calls, 2);
  }
});

test('a pause aborts in-flight siblings and rejects queued requests without calling them', async () => {
  const { governor } = setup({ auto: false });
  const signals: AbortSignal[] = [];
  const untilAborted = async ({ signal }: RequestIo) => {
    signals.push(signal);
    await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  };
  const trigger = deferred();
  const siblings = [
    governor.run(ACCOUNT, req('interactive', 10), untilAborted),
    governor.run(ACCOUNT, req('backfill', 10), untilAborted),
  ];
  const failing = governor.run(ACCOUNT, req('interactive', 10), async () => {
    await trigger.promise;
    throw refusal('throttle');
  });
  let queuedCalls = 0;
  const queued = [
    governor.run(ACCOUNT, req('backfill', 10), async () => {
      queuedCalls++;
    }),
    governor.run(ACCOUNT, req('interactive', 10), async () => {
      queuedCalls++;
    }),
  ];
  await settle();
  assert.equal(governor.inspect(ACCOUNT, 'gmail').inFlight, 3);
  trigger.resolve();
  await assert.rejects(failing, ProviderError);
  for (const run of [...siblings, ...queued]) {
    const error = await run.catch(e => e);
    assert.ok(error instanceof PausedError, String(error));
    assert.equal(error.cls, 'throttle');
  }
  assert.equal(queuedCalls, 0);
  assert.ok(signals.every(s => s.aborted));
  assert.equal(governor.inspect(ACCOUNT, 'gmail').inFlight, 0);
});

test('observe applies a refusal found inside a successful batch', async () => {
  const { governor } = setup({ auto: false });
  governor.observe(ACCOUNT, 'gmail', refusal('throttle', { status: 429 }).error);
  let calls = 0;
  await assert.rejects(
    governor.run(ACCOUNT, req('interactive', 1), async () => {
      calls++;
    }),
    PausedError,
  );
  assert.equal(calls, 0);
  assert.equal(gmail(governor.snapshot(ACCOUNT)).target, 2_250);
});

test('restore with an active cooldown makes zero calls until it ends', async () => {
  const first = setup({ auto: false });
  await assert.rejects(
    first.governor.run(
      ACCOUNT,
      req('interactive', 300),
      throwing(refusal('throttle', { retryAfterMs: 300_000, concurrency: true })),
    ),
  );
  const saved = JSON.parse(JSON.stringify(first.governor.snapshot(ACCOUNT))) as GovernorSnapshot[];

  // A restart: a new governor on the same clock, seeded from governor_state.
  const second = setup({ clock: first.clock });
  second.clock.auto(false);
  second.governor.restore(ACCOUNT, saved);
  let calls = 0;
  for (let i = 0; i < 20; i++) {
    await assert.rejects(
      second.governor.run(ACCOUNT, req('interactive', 1), async () => {
        calls++;
      }),
      PausedError,
    );
    await second.clock.advance(14_000);
  }
  assert.equal(calls, 0);
  const restored = gmail(second.governor.snapshot(ACCOUNT));
  assert.equal(restored.target, 2_250);
  assert.equal(restored.inFlightLimit, 1);
  assert.equal(restored.cooldownStep, 1);
  await second.clock.advanceTo(saved[0].cooldownUntil!);
  await second.governor.run(ACCOUNT, req('interactive', 1), async () => {
    calls++;
  });
  assert.equal(calls, 1);
});

test('restore keeps an auth block until clear and re-charges the saved window', async () => {
  const { clock, governor } = setup({ auto: false });
  governor.restore(ACCOUNT, [
    {
      budget: 'gmail',
      target: 4_500,
      inFlightLimit: 3,
      batchSize: 10,
      windowSpent: 4_400,
      windowAt: clock.now(),
      cooldownStep: 0,
    },
  ]);
  let at = 0;
  const run = governor.run(ACCOUNT, req('interactive', 200), async () => {
    at = clock.now();
  });
  await clock.advance(MINUTE);
  await run;
  assert.equal(at, clock.now());

  governor.restore(ACCOUNT, [
    {
      budget: 'gmail',
      target: 4_500,
      inFlightLimit: 3,
      batchSize: 10,
      windowSpent: 0,
      windowAt: 0,
      cooldownStep: 0,
      blocked: { cls: 'auth', since: clock.now() },
      cls: 'auth',
      reason: 'invalid_grant',
    },
  ]);
  assert.equal(governor.admission(ACCOUNT, 'gmail', 'interactive').ok, false);
  // An auth block is the account's: the restored block covers every budget, token calls included.
  assert.equal(governor.admission(ACCOUNT, 'oauth', 'interactive').ok, false);
  governor.clear(ACCOUNT, 'auth');
  assert.equal(governor.admission(ACCOUNT, 'gmail', 'interactive').ok, true);
});

test('onChange reports pauses and target changes, not every request; logs carry only allowed fields', async () => {
  const { clock, governor, logs } = setup({ auto: false });
  const changes: GovernorSnapshot[] = [];
  const off = governor.onChange((account, snap) => {
    assert.equal(account, ACCOUNT);
    changes.push(snap);
  });
  // Corrected after review (finding 2): port proposal 4 persists windowSpent/windowAt so a restart
  // cannot re-spend the minute, so the first spend reserves a step of the window (one change);
  // requests inside that reservation change nothing.
  await governor.run(ACCOUNT, req('interactive', 10), async () => {});
  assert.equal(changes.length, 1);
  assert.equal(changes[0].windowSpent, 450);
  await governor.run(ACCOUNT, req('interactive', 10), async () => {});
  assert.equal(changes.length, 1);
  await assert.rejects(
    governor.run(ACCOUNT, req('interactive', 10), throwing(refusal('throttle'))),
  );
  assert.equal(changes.length, 2);
  assert.equal(changes[1].cls, 'throttle');
  assert.equal(changes[1].target, 2_250);
  await clock.advance(MINUTE);
  governor.admission(ACCOUNT, 'gmail', 'interactive');
  assert.equal(changes.length, 3);
  assert.equal(changes[2].cls, undefined);
  off();

  const allowed = new Set([
    'account',
    'budget',
    'lane',
    'method',
    'units',
    'waitMs',
    'cls',
    'reason',
    'status',
  ]);
  assert.deepEqual([...new Set(logs.map(l => l.event))].sort(), [
    'governor.admitted',
    'governor.paused',
    'governor.refused',
    'governor.resumed',
  ]);
  for (const entry of logs)
    for (const key of Object.keys(entry.fields)) assert.ok(allowed.has(key), key);
});

test('a pause that starts between admission and the call still stops the call', async () => {
  const { governor } = setup({ auto: false });
  let calls = 0;
  const admitted = governor.run(ACCOUNT, req('interactive', 1), async () => {
    calls++;
  });
  governor.observe(ACCOUNT, 'gmail', refusal('throttle').error);
  await assert.rejects(admitted, PausedError);
  assert.equal(calls, 0);
});

test('a request that leaves later than it was admitted is counted from when it left', async () => {
  const { clock, governor } = setup({ auto: false });
  const start = clock.now();
  const first = governor.run(ACCOUNT, req('interactive', 4_500), async () => {});
  void clock.advance(30_000); // time moves before the admitted request's turn comes
  await first;
  let at = 0;
  const second = governor.run(ACCOUNT, req('interactive', 1), async () => {
    at = clock.now();
  });
  await clock.advance(MINUTE - 1);
  assert.equal(at, 0);
  await clock.advance(1);
  await second;
  assert.equal(at, start + 30_000 + MINUTE);
});
