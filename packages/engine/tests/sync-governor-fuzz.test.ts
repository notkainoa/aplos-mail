/**
 * Adversarial fuzzer for the governor (plan 20 PV2 "verify adversarially") plus hand-written probes
 * of the shared HTTP helpers. Written by a reviewer, not the author: every named check is an
 * invariant from ARCH 6 / plan 20 / the port proposal, measured against an independent model of what
 * the fake provider asked for, never against the governor's own view of itself.
 *
 * Restarts are crashes: the next process sees only what the actor persisted from `onChange`
 * (port proposal 4: "persisted to governor_state by the actor").
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createHttpClient,
  HttpFailure,
} from '../../../apps/desktop/src/host/providers/shared/http';
import { nextPacificMidnight as sharedMidnight } from '../../../apps/desktop/src/host/providers/shared/pacific';
import { parseRetryAfter } from '../../../apps/desktop/src/host/providers/shared/retry-after';
import { LANES } from '../src/sync/budgets';
import { Governor, QUIET_MS, REGROW_INTERVAL_MS, TRANSIENT_TRIES } from '../src/sync/governor';
import { nextPacificMidnight as engineMidnight } from '../src/sync/pacific';
import type { ClassifiedError, ErrorClass } from '@aplos/contract';
import {
  PausedError,
  ProviderError,
  type GovernorSnapshot,
  type RequestIo,
  type RequestKind,
  type SyncLane as Lane,
} from '../src/ports';
import type { DeviceRole } from '../src/sync/governor';
import {
  ACCOUNT,
  FakeClock,
  MINUTE,
  deferred,
  maxWindow,
  refusal,
  req,
  seeded,
  settle,
  setup,
} from './sync-governor-helpers';

const COSTS = [1, 2, 5, 10, 20, 40, 50, 60, 100, 120];
const KINDS: RequestKind[] = ['read', 'read', 'read', 'idempotentWrite', 'write', 'send'];
const ROLE_TARGET: Record<DeviceRole, number> = { primary: 4_500, secondary: 1_500 };
const REGROW = 250;
const gmail = (snaps: GovernorSnapshot[]) => snaps.find(s => s.budget === 'gmail')!;

type Check =
  | '1-window-over-target'
  | '1b-target-above-aimd-bound'
  | '2-call-during-pause'
  | '3-send-or-write-twice'
  | '3b-sent-then-reported-paused'
  | '4-daily-lifted-early'
  | '5-second-retry-layer'
  | 'concurrency'
  | 'liveness';

interface Violation {
  check: Check;
  seed: number;
  detail: string;
}

function retryAfterHeader(rand: () => number, now: number): string | undefined {
  const r = rand();
  if (r < 0.4) return undefined;
  if (r < 0.6) return String(Math.floor(rand() * 900)); // delta-seconds
  if (r < 0.7) return (rand() * 120).toFixed(1); // decimal delta
  const at =
    r < 0.85 ? now - Math.floor(rand() * 3_600_000) : now + Math.floor(rand() * 2 * 3_600_000);
  if (rand() < 0.5) return new Date(at).toUTCString(); // IMF-fixdate
  // asctime form: "Sun Nov  6 08:49:37 1994"
  const d = new Date(at);
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()];
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][
    d.getUTCMonth()
  ];
  const p = (n: number) => String(n).padStart(2, '0');
  return `${day} ${mon} ${String(d.getUTCDate()).padStart(2, ' ')} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} ${d.getUTCFullYear()}`;
}

interface Gen {
  governor: Governor;
  alive: boolean;
  controllers: AbortController[];
  running: number;
}

async function fuzz(
  seed: number,
  steps = 400,
): Promise<{ violations: Violation[]; calls: number; pauses: number; restarts: number }> {
  const rand = seeded(seed);
  const pick = <T>(items: readonly T[]) => items[Math.floor(rand() * items.length)];
  const clock = new FakeClock({ auto: false });
  const violations: Violation[] = [];
  const trace: string[] = [];
  const t = (what: string) => {
    if (process.env.FUZZ_TRACE) trace.push(`${clock.now()} ${what}`);
  };
  const flag = (check: Check, detail: string) =>
    violations.push({
      check,
      seed,
      detail: process.env.FUZZ_TRACE ? `${detail}\n    ${trace.slice(-14).join('\n    ')}` : detail,
    });
  const calls: { at: number; units: number }[] = [];
  let role: DeviceRole = rand() < 0.5 ? 'primary' : 'secondary';
  let pauses = 0;
  let restarts = 0;
  let lastRestartAt = -Infinity;
  let pending = 0;
  const persisted = new Map<string, GovernorSnapshot>();

  // Independent model, built only from what the fake provider said.
  const model = { throttleUntil: 0, dailyUntil: 0, stopped: false, cap1Until: 0 };
  // AIMD bound: after a throttle the target may not exceed the halved value H until q + 10 min, then +250/min.
  let aimd: { H: number; q: number } | undefined;
  const aimdBound = (now: number) => {
    if (!aimd) return Infinity;
    if (now < aimd.q + QUIET_MS) return aimd.H;
    return aimd.H + REGROW * (Math.floor((now - aimd.q - QUIET_MS) / REGROW_INTERVAL_MS) + 1);
  };

  const makeGen = (): Gen => {
    const g: Gen = {
      governor: undefined as unknown as Governor,
      alive: true,
      controllers: [],
      running: 0,
    };
    g.governor = new Governor({
      clock,
      role,
      random: rand,
      logger: event => {
        if (event === 'governor.paused' && g.alive) pauses++;
      },
    });
    g.governor.onChange((account, snap) => {
      if (g.alive && account === ACCOUNT) persisted.set(snap.budget, { ...snap });
    });
    return g;
  };
  let gen = makeGen();
  gen.governor.setRole(ACCOUNT, role);

  /** Applies a provider throttle/daily/auth to the model; call BEFORE the governor sees it. */
  const learn = (g: Gen, error: ClassifiedError) => {
    const now = clock.now();
    if (error.class === 'throttle') {
      const govCooling = (gmail(g.governor.snapshot(ACCOUNT)).cooldownUntil ?? 0) > now;
      const ra = error.retryAfterMs ?? 0;
      model.throttleUntil = govCooling
        ? Math.max(model.throttleUntil, now + ra)
        : Math.max(model.throttleUntil, now + Math.max(ra, 60_000));
      if (error.concurrency)
        model.cap1Until = Math.max(model.cap1Until, model.throttleUntil + QUIET_MS);
    }
    if (error.class === 'daily') {
      const until =
        error.resumeAt !== undefined && error.resumeAt > now ? error.resumeAt : sharedMidnight(now);
      model.dailyUntil = Math.max(model.dailyUntil, until);
    }
    if (error.class === 'auth') model.stopped = true;
  };
  /** After the governor applied a throttle, record the AIMD bound it must respect from now on. */
  const afterThrottle = (g: Gen) => {
    const snap = gmail(g.governor.snapshot(ACCOUNT));
    aimd = { H: snap.target, q: snap.cooldownUntil ?? clock.now() };
  };

  const answer = (kind: RequestKind, now: number): ClassifiedError | 'unclassified' | undefined => {
    const roll = rand();
    if (roll < 0.88) return undefined;
    const base = { provider: 'google' as const, method: 'gmail.x' };
    if (roll < 0.905) {
      const header = retryAfterHeader(rand, now);
      return {
        ...base,
        class: 'throttle',
        reason: 'rateLimitExceeded',
        status: 429,
        retryAfterMs: parseRetryAfter(header, now),
        concurrency: rand() < 0.3,
      };
    }
    if (roll < 0.91)
      return {
        ...base,
        class: 'daily',
        reason: 'quotaExceeded',
        status: 403,
        resumeAt: rand() < 0.5 ? now + Math.floor(rand() * 7_200_000) + 1 : undefined,
      };
    if (roll < 0.912) return { ...base, class: 'auth', reason: 'invalid_grant', status: 400 };
    if (roll < 0.92 && kind === 'send')
      return { ...base, class: 'send_limit', reason: 'userRateLimitExceeded', status: 429 };
    if (roll < 0.96) return { ...base, class: 'transient', reason: 'backendError', status: 503 };
    if (roll < 0.97) return 'unclassified';
    return { ...base, class: 'permanent', reason: 'notFound', status: 404 };
  };

  /** The invariant checks at the moment the provider is called (1)-(5), and the in-flight count. */
  const checkCall = (
    g: Gen,
    kind: RequestKind,
    lane: Lane,
    cost: number,
    tries: number,
    lastFailure: ErrorClass | 'unclassified' | 'aborted' | undefined,
    now: number,
  ) => {
    // (2) and (4): never while a pause or stop is in force.
    if (now < model.throttleUntil || model.stopped)
      flag(
        '2-call-during-pause',
        `${kind}/${lane} at +${now - clock.jumps[0]?.from} throttleUntil ${model.throttleUntil} stopped ${model.stopped}`,
      );
    if (now < model.dailyUntil)
      flag('4-daily-lifted-early', `${kind}/${lane} at ${now}, daily until ${model.dailyUntil}`);
    if (!g.governor.admission(ACCOUNT, 'gmail', lane).ok)
      flag('2-call-during-pause', `governor itself reports a pause at ${now}`);
    // (3) and (5): one retry layer.
    if (tries > 1 && (kind === 'send' || kind === 'write'))
      flag('3-send-or-write-twice', `${kind} invoked ${tries} times`);
    if (
      tries > 1 &&
      !(
        (kind === 'read' || kind === 'idempotentWrite') &&
        (lastFailure === 'transient' || lastFailure === 'unclassified')
      )
    )
      flag('5-second-retry-layer', `${kind} re-invoked after ${lastFailure}`);
    if (tries > TRANSIENT_TRIES) flag('5-second-retry-layer', `${tries} tries`);
    // Concurrency.
    g.running++;
    if (g.running > 3) flag('concurrency', `${g.running} in flight`);
    if (now < model.cap1Until && g.running > 1)
      flag(
        'concurrency',
        `${g.running} in flight after a concurrency refusal, at ${now}, cap until ${model.cap1Until}`,
      );
    // (1): window at the provider, across restarts, against the target in force.
    calls.push({ at: now, units: cost });
    t(`call ${kind}/${lane} ${cost} gen${restarts}`);
    const used = calls.filter(c => now - c.at < MINUTE).reduce((s, c) => s + c.units, 0);
    const snap = gmail(g.governor.snapshot(ACCOUNT));
    if (used > snap.target)
      flag(
        '1-window-over-target',
        `${now - lastRestartAt < MINUTE ? '[within 60 s of a restart] ' : '[no recent restart] '}${used} units in the 60 s window at ${now}, target in force ${snap.target} (governor thinks ${g.governor.inspect(ACCOUNT, 'gmail').used}), restarts so far ${restarts}`,
      );
    if (used > ROLE_TARGET[role])
      flag('1-window-over-target', `${used} units over role target ${ROLE_TARGET[role]} (${role})`);
    const bound = Math.min(ROLE_TARGET[role], aimdBound(now));
    if (snap.target > bound)
      flag(
        '1b-target-above-aimd-bound',
        `target ${snap.target} > AIMD bound ${bound} at ${now} (H ${aimd?.H}, q ${aimd?.q}), role ${role}, restarts ${restarts}`,
      );
  };

  /** The provider refuses: the model learns it first, then the error reaches the governor. */
  const refuse = (g: Gen, kind: RequestKind, a: ClassifiedError): never => {
    learn(g, a);
    t(`fn answer ${kind} ${a.class} ra=${a.retryAfterMs} -> model ${JSON.stringify(model)}`);
    const err = new ProviderError(a);
    if (a.class === 'throttle')
      queueMicrotask(() => {
        if (g.alive) afterThrottle(g);
      });
    throw err;
  };

  const spawn = () => {
    const g = gen;
    const lane: Lane = pick(LANES);
    const kind = pick(KINDS);
    const cost = pick(COSTS);
    const controller = new AbortController();
    g.controllers.push(controller);
    let tries = 0;
    let lastFailure: ErrorClass | 'unclassified' | 'aborted' | undefined;
    let leftOnce = false;
    pending++;
    g.governor
      .run(ACCOUNT, req(lane, cost, { kind, signal: controller.signal }), async ({ signal }) => {
        const now = clock.now();
        tries++;
        if (!g.alive) {
          flag('2-call-during-pause', `dead process called fn at ${now}`);
          throw new Error('dead');
        }
        checkCall(g, kind, lane, cost, tries, lastFailure, now);
        const isWrite = kind === 'send' || kind === 'write';
        const honoursAbort = !isWrite || rand() < 0.5; // half the writes run through http.ts, which aborts the fetch
        try {
          leftOnce = true;
          await clock.sleep(50 + Math.floor(rand() * 2_000), honoursAbort ? signal : undefined);
        } catch (error) {
          lastFailure = 'aborted';
          // http.ts: an abort during the fetch is HttpFailure('aborted', written: true).
          throw new HttpFailure('aborted', true, { cause: error });
        } finally {
          g.running--;
        }
        if (!g.alive) throw new Error('dead');
        const a = answer(kind, clock.now());
        if (a === undefined) return;
        if (a === 'unclassified') {
          lastFailure = 'unclassified';
          throw new Error('socket hang up');
        }
        lastFailure = a.class as ErrorClass;
        refuse(g, kind, a);
      })
      .then(
        () => {},
        (error: unknown) => {
          if (
            g.alive &&
            leftOnce &&
            (kind === 'send' || kind === 'write') &&
            error instanceof PausedError
          )
            flag(
              '3b-sent-then-reported-paused',
              `${kind} reached the provider, run() rejected with PausedError(${error.cls}); SendPort re-queues it -> second send`,
            );
        },
      )
      .finally(() => {
        pending--;
      });
  };

  for (let step = 0; step < steps; step++) {
    await settle(1);
    const roll = rand();
    if (roll < 0.4) for (let n = 1 + Math.floor(rand() * 8); n > 0; n--) spawn();
    else if (roll < 0.45)
      for (let n = 0; n < 45; n++) spawn(); // a saturating burst
    else if (roll < 0.66) await clock.advance(Math.floor(rand() * 5_000));
    else if (roll < 0.72) await clock.advance(Math.floor(rand() * 20 * MINUTE));
    else if (roll < 0.74) await clock.advance(Math.floor(rand() * 26 * 3_600_000));
    else if (roll < 0.77) {
      const now = clock.now();
      const r = rand();
      const error: ClassifiedError =
        r < 0.75
          ? {
              class: 'throttle',
              provider: 'google',
              method: 'gmail.batch',
              reason: 'rateLimitExceeded',
              status: 429,
              retryAfterMs: parseRetryAfter(retryAfterHeader(rand, now), now),
              concurrency: rand() < 0.3,
            }
          : {
              class: 'daily',
              provider: 'google',
              method: 'gmail.batch',
              reason: 'dailyLimitExceeded',
              status: 403,
            };
      learn(gen, error);
      t(
        `observe ${error.class} ra=${error.retryAfterMs} conc=${error.concurrency} -> model ${JSON.stringify(model)}`,
      );
      gen.governor.observe(ACCOUNT, 'gmail', error);
      t(`  gov ${JSON.stringify(gmail(gen.governor.snapshot(ACCOUNT)))}`);
      if (error.class === 'throttle') afterThrottle(gen);
    } else if (roll < 0.81) {
      role = role === 'primary' ? 'secondary' : 'primary';
      t(`setRole ${role}`);
      gen.governor.setRole(ACCOUNT, role);
    } else if (roll < 0.85 && model.stopped) {
      model.stopped = false;
      gen.governor.clear(ACCOUNT, 'auth');
    } else if (roll < 0.88) {
      // Crash and restart: the new process sees only what onChange persisted.
      restarts++;
      lastRestartAt = clock.now();
      const old = gen;
      old.alive = false;
      for (const c of old.controllers) c.abort(new Error('crash'));
      old.running = 0;
      gen = makeGen();
      t(
        `restart, restore ${JSON.stringify([...persisted.values()].find(x => x.budget === 'gmail'))}`,
      );
      gen.governor.restore(ACCOUNT, [...persisted.values()]);
      gen.governor.setRole(ACCOUNT, role);
    } else if (gen.controllers.length) pick(gen.controllers).abort(new Error('caller'));
  }
  for (let i = 0; i < 200 && pending > 0; i++) {
    if (model.stopped) {
      model.stopped = false;
      gen.governor.clear(ACCOUNT, 'auth');
    }
    await clock.advance(3_600_000);
  }
  if (pending > 0) flag('liveness', `${pending} runs never settled`);
  return { violations, calls: calls.length, pauses, restarts };
}

const SEEDS = Number(process.env.FUZZ_SEEDS ?? 30);
const FIRST_SEED = Number(process.env.FUZZ_SEED ?? 1);
let results:
  Promise<{ violations: Violation[]; calls: number; pauses: number; restarts: number }> | undefined;
function allResults() {
  results ??= (async () => {
    const out = { violations: [] as Violation[], calls: 0, pauses: 0, restarts: 0 };
    for (let seed = FIRST_SEED; seed < FIRST_SEED + SEEDS; seed++) {
      const r = await fuzz(seed);
      out.violations.push(...r.violations);
      out.calls += r.calls;
      out.pauses += r.pauses;
      out.restarts += r.restarts;
    }
    return out;
  })();
  return results;
}

function report(violations: Violation[], check: Check) {
  const hits = violations.filter(v => v.check === check);
  if (process.env.FUZZ_DUMP)
    for (const v of hits) console.log(`DUMP ${check} seed ${v.seed}: ${v.detail.split('\n')[0]}`);
  const seeds = [...new Set(hits.map(v => v.seed))];
  return {
    count: hits.length,
    seeds: seeds.slice(0, 10),
    first: hits[0] && `seed ${hits[0].seed}: ${hits[0].detail}`,
  };
}

test('fuzz: the scenarios are strong enough to mean something', async () => {
  const r = await allResults();
  assert.ok(r.calls > 5_000, `${r.calls} calls`);
  assert.ok(r.pauses > 100, `${r.pauses} pauses`);
  assert.ok(r.restarts > 100, `${r.restarts} restarts`);
});

for (const check of [
  '1-window-over-target',
  '1b-target-above-aimd-bound',
  '2-call-during-pause',
  '3-send-or-write-twice',
  '3b-sent-then-reported-paused',
  '4-daily-lifted-early',
  '5-second-retry-layer',
  'concurrency',
  'liveness',
] as Check[]) {
  test(`fuzz invariant ${check}`, async () => {
    const r = await allResults();
    assert.deepEqual(report(r.violations, check), { count: 0, seeds: [], first: undefined });
  });
}

// ---------------------------------------------------------------- minimal reproductions

test('repro 1: a crash after a busy minute re-spends the window (persisted usedInWindow is stale)', async () => {
  const clock = new FakeClock({ auto: false });
  const persisted = new Map<string, GovernorSnapshot>();
  const a = new Governor({ clock, role: 'primary' });
  a.onChange((_acct, snap) => persisted.set(snap.budget, snap));
  a.snapshot(ACCOUNT); // the actor reads state at start; nothing changes yet
  const provider: { at: number; units: number }[] = [];
  // 37 backfill reads x 120 = 4,440 units within the first second, all admitted.
  await Promise.all(
    Array.from({ length: 37 }, () =>
      a.run(ACCOUNT, req('interactive', 120), async () => {
        provider.push({ at: clock.now(), units: 120 });
      }),
    ),
  );
  await clock.advance(1_000);
  // Crash. The actor only ever persisted what onChange gave it.
  const b = new Governor({ clock, role: 'primary' });
  b.restore(ACCOUNT, [...persisted.values()]);
  // Corrected after the fix: the restarted process now (rightly) waits for the old minute to pass,
  // so the clock must be driven for these runs to finish, and the check is the busiest 60 s window
  // over the whole run rather than the last 60 s before the end.
  let done = false;
  const second = Promise.all(
    Array.from({ length: 37 }, () =>
      b.run(ACCOUNT, req('interactive', 120), async () => {
        provider.push({ at: clock.now(), units: 120 });
      }),
    ),
  ).finally(() => {
    done = true;
  });
  for (let i = 0; i < 10 && !done; i++) {
    await settle();
    await clock.advance(30_000);
  }
  await second;
  const used = maxWindow(provider);
  assert.ok(
    used <= 4_500,
    `${used} units in one 60 s window after a restart (persisted windowSpent ${persisted.get('gmail')?.windowSpent ?? 'never persisted'})`,
  );
});

test('repro 3b: a throttle on a sibling aborts an in-flight send and reports it as PausedError, not uncertain', async () => {
  const { governor } = setup({ auto: false });
  const bytesLeft = deferred();
  const trigger = deferred();
  // Corrected after the fix: the send is no longer aborted, so the fake provider must answer it
  // (here after the sibling's pause began) or this test waits forever.
  const answered = deferred();
  let sendSignal: AbortSignal | undefined;
  // The send goes through http.ts, which ties fetch to the signal it is given.
  const send = governor.run(
    ACCOUNT,
    req('interactive', 100, { kind: 'send', method: 'gmail.messages.send' }),
    async ({ signal }) => {
      sendSignal = signal;
      bytesLeft.resolve();
      await new Promise<void>((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new HttpFailure('aborted', true)));
        void answered.promise.then(resolve);
      });
      return 'sent';
    },
  );
  const sibling = governor.run(ACCOUNT, req('incremental', 2), async () => {
    await trigger.promise;
    throw refusal('throttle', { status: 429 });
  });
  await bytesLeft.promise;
  trigger.resolve();
  await sibling.catch(() => {});
  assert.equal(sendSignal?.aborted, false, 'principle 4: a pause never aborts a started send');
  answered.resolve();
  const outcome = await send.catch(e => e);
  assert.ok(
    !(outcome instanceof PausedError),
    `send rejected with ${outcome?.name}; SendPort maps PausedError to queued -> resend`,
  );
  assert.equal(outcome, 'sent');
});

test('repro 2: a refusal answering an in-flight write whose signal was aborted is dropped, so the next call goes out', async () => {
  const { governor } = setup({ auto: false });
  const caller = new AbortController();
  const started = deferred();
  const answer = deferred();
  // The write's bytes have left; the user cancels; Google still answers 429 (or invalid_grant).
  const write = governor.run(
    ACCOUNT,
    req('opFlush', 5, { kind: 'write', method: 'gmail.messages.insert', signal: caller.signal }),
    async () => {
      started.resolve();
      await answer.promise;
      throw refusal('throttle', { status: 429, retryAfterMs: 120_000 });
    },
  );
  await started.promise;
  caller.abort(new Error('user cancelled'));
  answer.resolve();
  await write.catch(() => {});
  let calls = 0;
  await governor
    .run(ACCOUNT, req('incremental', 2), async () => {
      calls++;
    })
    .catch(() => {});
  assert.equal(calls, 0, 'Google asked for 120 s of quiet; the governor never applied it');
});

test('repro 1b: a role flip primary -> secondary -> primary forgets the AIMD halving', async () => {
  const { governor } = setup({ auto: false });
  governor.observe(ACCOUNT, 'gmail', refusal('throttle', { status: 429 }).error);
  assert.equal(gmail(governor.snapshot(ACCOUNT)).target, 2_250);
  governor.setRole(ACCOUNT, 'secondary');
  governor.setRole(ACCOUNT, 'primary');
  assert.equal(
    gmail(governor.snapshot(ACCOUNT)).target,
    2_250,
    'halved target survives a lease flip within the cooldown',
  );
});

test('repro 1b: restore double-counts AIMD regrowth', async () => {
  const { clock, governor } = setup({ auto: false });
  governor.observe(ACCOUNT, 'gmail', refusal('throttle', { status: 429 }).error);
  const q = gmail(governor.snapshot(ACCOUNT)).cooldownUntil!;
  await clock.advanceTo(q + QUIET_MS + 4 * MINUTE); // 5 regrowth steps: 2,250 + 1,250 = 3,500
  const before = governor.snapshot(ACCOUNT);
  assert.equal(gmail(before).target, 3_500);
  const after = new Governor({ clock, role: 'primary' });
  after.restore(ACCOUNT, before);
  assert.equal(
    gmail(after.snapshot(ACCOUNT)).target,
    3_500,
    'same instant, same target after a restart',
  );
});

test('by hand: a send_limit refusal does not stop the next send (no sendBlockedUntil)', async () => {
  const { governor } = setup({ auto: false });
  await assert.rejects(
    governor.run(ACCOUNT, req('interactive', 100, { kind: 'send' }), async () => {
      throw refusal('send_limit', { status: 429 });
    }),
  );
  let sends = 0;
  await governor
    .run(ACCOUNT, req('interactive', 100, { kind: 'send' }), async () => {
      sends++;
    })
    .catch(() => {});
  assert.equal(
    sends,
    0,
    'port proposal 4: send_limit sets sendBlockedUntil; admission(..., send) refuses until then',
  );
});

test('by hand: insufficientPermissions on one call stops the whole Gmail budget', async () => {
  const { governor } = setup({ auto: false });
  await assert.rejects(
    governor.run(
      ACCOUNT,
      req('interactive', 1, { method: 'gmail.users.settings.sendAs.list' }),
      async () => {
        throw refusal('permission', { reason: 'insufficientPermissions' });
      },
    ),
  );
  let reads = 0;
  await governor
    .run(ACCOUNT, req('incremental', 2, { method: 'gmail.users.history.list' }), async () => {
      reads++;
    })
    .catch(() => {});
  assert.equal(reads, 1, 'port proposal 4: permission -> none on the budget; capability recorded');
});

test('by hand: auth stop then daily: after resume the remaining daily stop is labelled throttle with no reason', async () => {
  const { governor } = setup({ auto: false });
  governor.observe(ACCOUNT, 'gmail', refusal('daily', { reason: 'dailyLimitExceeded' }).error);
  governor.observe(ACCOUNT, 'gmail', refusal('auth').error);
  governor.clear(ACCOUNT, 'auth');
  const adm = governor.admission(ACCOUNT, 'gmail', 'interactive');
  assert.ok(!adm.ok);
  assert.equal(adm.ok ? '' : `${adm.cls}/${adm.reason}`, 'daily/dailyLimitExceeded');
});

test('by hand: manual interactive call during throttle, daily and auth makes zero calls', async () => {
  for (const cls of ['throttle', 'daily', 'auth'] as const) {
    const { governor } = setup({ auto: false });
    governor.observe(ACCOUNT, 'gmail', refusal(cls).error);
    let calls = 0;
    for (let i = 0; i < 5; i++)
      await governor
        .run(ACCOUNT, req('interactive', 1), async () => {
          calls++;
        })
        .catch(() => {});
    assert.equal(calls, 0, cls);
  }
});

test('by hand: invalid_grant does not loop', async () => {
  const { governor } = setup();
  let calls = 0;
  for (let i = 0; i < 10; i++)
    await governor
      .run(ACCOUNT, req('incremental', 2), async () => {
        calls++;
        throw refusal('auth');
      })
      .catch(() => {});
  assert.equal(calls, 1);
});

test('by hand: concurrency refusal with three in flight, then cooldown: never two in flight', async () => {
  const { clock, governor } = setup({ auto: false });
  let running = 0;
  let peak = 0;
  let afterRefusal = false;
  const body =
    (fail: boolean) =>
    async ({ signal }: RequestIo) => {
      running++;
      if (afterRefusal) peak = Math.max(peak, running);
      try {
        await clock.sleep(500, signal);
      } finally {
        running--;
      }
      if (fail) {
        afterRefusal = true;
        throw refusal('throttle', { status: 429, concurrency: true });
      }
    };
  const runs = [
    governor.run(ACCOUNT, req('interactive', 1), body(true)),
    governor.run(ACCOUNT, req('interactive', 1), body(false)),
    governor.run(ACCOUNT, req('interactive', 1), body(false)),
  ];
  const settledFirst = Promise.allSettled(runs);
  await settle();
  await clock.advance(1_000);
  await settledFirst;
  await clock.advance(61_000);
  const more = Promise.allSettled(
    Array.from({ length: 10 }, (_, i) =>
      governor.run(ACCOUNT, req(i % 2 ? 'interactive' : 'backfill', 1), body(false)),
    ),
  );
  for (let i = 0; i < 20; i++) {
    await settle();
    await clock.advance(500);
  }
  await more;
  assert.equal(peak, 1);
});

test('by hand: Retry-After in the past is 0 (60 s step applies); far future is not capped', async () => {
  const now = Date.UTC(2026, 9, 27, 16);
  assert.equal(parseRetryAfter('Tue, 27 Oct 2026 15:00:00 GMT', now), 0);
  assert.equal(
    parseRetryAfter('Fri, 31 Dec 2100 00:00:00 GMT', now)! > 70 * 365 * 86_400_000,
    true,
  );
  const huge = parseRetryAfter('99999999999999999999', now)!;
  const { governor } = setup({ auto: false });
  governor.observe(ACCOUNT, 'gmail', refusal('throttle', { retryAfterMs: huge }).error);
  const until = gmail(governor.snapshot(ACCOUNT)).cooldownUntil!;
  assert.ok(
    Number.isFinite(new Date(until).getTime()),
    `cooldownUntil ${until} is not a valid Date`,
  );
});

test('by hand: both nextPacificMidnight copies agree with a brute-force scan around both 2026 DST days', () => {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const isMidnight = (t: number) => /, 00:00:00$/.test(fmt.format(t));
  const bad: string[] = [];
  for (const [y, m, d] of [
    [2026, 2, 7],
    [2026, 2, 8],
    [2026, 9, 31],
    [2026, 10, 1],
    [2026, 11, 31],
  ]) {
    for (let t = Date.UTC(y, m, d, 0); t < Date.UTC(y, m, d + 2, 0); t += 7 * 60_000 + 13_000) {
      // Brute force: the first whole minute after t that reads 00:00 in Pacific.
      let brute = Math.floor(t / 60_000) * 60_000 + 60_000;
      if (isMidnight(Math.floor(t / 60_000) * 60_000) && t % 60_000 !== 0)
        brute = Math.floor(t / 60_000) * 60_000 + 60_000;
      while (!isMidnight(brute)) brute += 60_000;
      for (const [name, fn] of [
        ['engine', engineMidnight],
        ['shared', sharedMidnight],
      ] as const) {
        const got = fn(t);
        if (got !== brute)
          bad.push(
            `${name} ${new Date(t).toISOString()} -> ${new Date(got).toISOString()} want ${new Date(brute).toISOString()}`,
          );
      }
    }
  }
  assert.deepEqual(bad.slice(0, 5), []);
});

test('by hand: http.ts makes exactly one fetch per request and never retries a 503', async () => {
  const clock = new FakeClock({ auto: false });
  let fetches = 0;
  const http = createHttpClient({
    clock,
    userAgent: 'x',
    fetch: (async () => {
      fetches++;
      return new Response('{}', { status: 503, headers: { 'retry-after': '5' } });
    }) as typeof fetch,
  });
  const res = await http.request('https://example.invalid/');
  assert.equal(fetches, 1);
  assert.equal(res.status, 503);
  assert.equal(res.retryAfterMs, 5_000);
});

test('by hand: http.ts does not swallow a caller abort when the fetch ignores its signal', async () => {
  const clock = new FakeClock({ auto: false });
  const http = createHttpClient({
    clock,
    userAgent: 'x',
    fetch: (() => new Promise<Response>(() => {})) as typeof fetch,
  });
  const controller = new AbortController();
  const pending = http.request('https://example.invalid/', { signal: controller.signal });
  await settle();
  controller.abort();
  const outcome = await Promise.race([
    pending.then(
      () => 'resolved',
      e => (e instanceof HttpFailure ? e.kind : 'other'),
    ),
    settle(10).then(() => 'still pending'),
  ]);
  assert.equal(outcome, 'aborted');
});

test('by hand: http.ts times out a body that stalls even if the stream ignores the signal', async () => {
  const clock = new FakeClock({ auto: false });
  const stalled = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode('{"a":'));
    },
  });
  const http = createHttpClient({
    clock,
    userAgent: 'x',
    timeoutMs: 1_000,
    fetch: (async () => new Response(stalled)) as typeof fetch,
  });
  // Corrected after the fix: the request now rejects during advance(), so its handler is attached
  // first; otherwise Node reports the (correct) timeout as an unhandled rejection.
  const pending = http.request('https://example.invalid/').then(
    () => 'resolved',
    e => (e instanceof HttpFailure ? e.kind : 'other'),
  );
  await settle();
  await clock.advance(2_000);
  const outcome = await Promise.race([pending, settle(10).then(() => 'still pending')]);
  assert.equal(outcome, 'timeout');
});

test('by hand: a queued prefetch (higher lane) is starved by backfill until backfill runs dry', async () => {
  const { clock, governor } = setup();
  const start = clock.now();
  let prefetchAt = -1;
  const backfill = Array.from({ length: 300 }, () =>
    governor.run(ACCOUNT, req('backfill', 120), async () => {
      await clock.sleep(200);
    }),
  );
  await clock.sleep(5_000);
  const prefetch = governor.run(ACCOUNT, req('prefetch', 120), async () => {
    prefetchAt = clock.now() - start;
  });
  await Promise.all([...backfill, prefetch]);
  assert.ok(
    prefetchAt < 2 * MINUTE,
    `prefetch waited ${prefetchAt / 1000} s behind 300 backfill reads (ARCH 4.1: prefetch outranks backfill)`,
  );
});
