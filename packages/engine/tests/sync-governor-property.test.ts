import test from 'node:test';
import assert from 'node:assert/strict';
import { LANES } from '../src/sync/budgets';
import { COOLDOWN_STEPS_MS, Governor, TRANSIENT_TRIES } from '../src/sync/governor';
import { nextPacificMidnight } from '../src/sync/pacific';
import type { ClassifiedError } from '@aplos/contract';
import type { RequestKind } from '../src/ports';
import { ACCOUNT, FakeClock, MINUTE, refusal, req, seeded, settle } from './sync-governor-helpers';

const COSTS = [1, 2, 5, 10, 20, 40, 60, 100, 120];
const KINDS: RequestKind[] = ['read', 'read', 'read', 'idempotentWrite', 'write', 'send'];

/** The fake provider wraps its refusal record in a plain Error, so the classifier option is exercised. */
const classifyCause = (error: unknown): ClassifiedError | undefined =>
  error instanceof Error &&
  typeof error.cause === 'object' &&
  error.cause !== null &&
  'class' in error.cause
    ? (error.cause as ClassifiedError)
    : undefined;

/**
 * One seeded run: random requests (costs, lanes, kinds), random provider answers (success,
 * throttle with and without Retry-After or concurrency, daily, auth, transient, permanent, send
 * limit), refusals observed inside batches, role flips, caller aborts and clock jumps. Returns the
 * invariant violations it saw.
 */
async function scenario(
  seed: number,
): Promise<{ violations: string[]; calls: number; pauses: number }> {
  const rand = seeded(seed);
  const pick = <T>(items: readonly T[]) => items[Math.floor(rand() * items.length)];
  const clock = new FakeClock({ auto: false });
  let pauses = 0;
  const governor = new Governor({
    clock,
    classify: classifyCause,
    logger: event => {
      if (event === 'governor.paused') pauses++;
    },
    role: rand() < 0.5 ? 'primary' : 'secondary',
    random: rand,
  });
  const violations: string[] = [];
  const calls: { at: number; units: number }[] = [];
  // Independent model of when calls are forbidden, built only from refusals the test itself produced.
  let quietUntil = 0;
  let stopped = false;
  let running = 0;
  let pending = 0;
  const controllers: AbortController[] = [];

  const forbid = (error: ClassifiedError, now: number) => {
    if (error.class === 'throttle') {
      // Corrected after review: a refusal answering a request sent before the cooldown began (now
      // seen more often, since a pause no longer aborts sends and writes) lengthens the pause only by
      // its Retry-After and does not restart the 60 s step, the same rule the review fuzzer models.
      const cooling = (governor.snapshot(ACCOUNT)[0].cooldownUntil ?? 0) > now;
      const wait = cooling
        ? (error.retryAfterMs ?? 0)
        : Math.max(error.retryAfterMs ?? 0, COOLDOWN_STEPS_MS[0]);
      quietUntil = Math.max(quietUntil, now + wait);
    }
    if (error.class === 'daily')
      quietUntil = Math.max(quietUntil, error.resumeAt ?? nextPacificMidnight(now));
    if (error.class === 'auth') stopped = true;
  };

  const answer = (now: number): ClassifiedError | undefined => {
    const roll = rand();
    if (roll < 0.82) return undefined;
    if (roll < 0.86)
      return refusal('throttle', {
        retryAfterMs: rand() < 0.3 ? Math.floor(rand() * 600_000) : undefined,
        concurrency: rand() < 0.3,
      }).error;
    if (roll < 0.87)
      return refusal('daily', {
        resumeAt: rand() < 0.5 ? now + Math.floor(rand() * 7_200_000) + 1 : undefined,
      }).error;
    if (roll < 0.875) return refusal('auth').error;
    if (roll < 0.95) return refusal('transient', { status: 503 }).error;
    if (roll < 0.98) return refusal('permanent', { status: 404 }).error;
    return refusal('send_limit', { status: 429 }).error;
  };

  const spawn = () => {
    const lane = pick(LANES);
    const kind = pick(KINDS);
    const cost = rand() < 0.03 ? 800 + Math.floor(rand() * 5_000) : pick(COSTS);
    const controller = new AbortController();
    controllers.push(controller);
    let tries = 0;
    pending++;
    governor
      .run(
        ACCOUNT,
        req(lane, cost, { kind, signal: rand() < 0.2 ? controller.signal : undefined }),
        async ({ signal }) => {
          const now = clock.now();
          tries++;
          if (!governor.admission(ACCOUNT, 'gmail', lane).ok)
            violations.push(`seed ${seed}: call at ${now} while the governor reports a pause`);
          if (now < quietUntil || stopped)
            violations.push(`seed ${seed}: call at ${now} inside a pause the provider asked for`);
          if (kind !== 'read' && kind !== 'idempotentWrite' && tries > 1)
            violations.push(`seed ${seed}: a ${kind} was sent twice`);
          if (tries > TRANSIENT_TRIES)
            violations.push(`seed ${seed}: more than ${TRANSIENT_TRIES} tries`);
          if (++running > 3) violations.push(`seed ${seed}: ${running} in flight`);
          calls.push({ at: now, units: cost });
          const target = governor.snapshot(ACCOUNT).find(s => s.budget === 'gmail')!.target;
          const window = calls.filter(c => now - c.at < MINUTE);
          const used = window.reduce((sum, c) => sum + c.units, 0);
          if (used > target && window.length > 1)
            violations.push(
              `seed ${seed}: ${used} units in the window at ${now}, target ${target}, governor used ${governor.inspect(ACCOUNT, 'gmail').used}, cost ${cost}, lane ${lane}, n ${window.length}`,
            );
          try {
            await clock.sleep(50 + Math.floor(rand() * 2_000), signal);
          } finally {
            running--;
          }
          const error = answer(clock.now());
          if (error) {
            forbid(error, clock.now());
            throw new Error('provider', { cause: error });
          }
        },
      )
      .then(
        () => {},
        () => {},
      )
      .finally(() => {
        pending--;
      });
  };

  for (let step = 0; step < 400; step++) {
    // Let admitted requests reach the provider before the driver acts again, as they would in real time.
    await settle(1);
    const roll = rand();
    if (roll < 0.45) for (let n = 1 + Math.floor(rand() * 4); n > 0; n--) spawn();
    else if (roll < 0.75) await clock.advance(Math.floor(rand() * 5_000));
    else if (roll < 0.85) await clock.advance(Math.floor(rand() * 3 * 3_600_000));
    else if (roll < 0.88) {
      const error =
        rand() < 0.8 ? refusal('throttle', { status: 429 }).error : refusal('daily').error;
      forbid(error, clock.now());
      governor.observe(ACCOUNT, 'gmail', error);
    } else if (roll < 0.91) governor.setRole(ACCOUNT, rand() < 0.5 ? 'primary' : 'secondary');
    else if (roll < 0.95 && stopped) {
      stopped = false;
      governor.clear(ACCOUNT, 'auth');
    } else if (controllers.length) pick(controllers).abort(new Error('caller'));
  }
  // Drain: everything still waiting must settle once time passes and any stop is lifted.
  for (let i = 0; i < 200 && pending > 0; i++) {
    if (stopped) {
      stopped = false;
      governor.clear(ACCOUNT, 'auth');
    }
    await clock.advance(3_600_000);
  }
  if (pending > 0) violations.push(`seed ${seed}: ${pending} requests never settled`);
  if (calls.length < 20)
    violations.push(`seed ${seed}: only ${calls.length} calls, the scenario is too weak`);
  return { violations, calls: calls.length, pauses };
}

test('property: no window above the target in force, and no call during a pause or stop', async () => {
  const violations: string[] = [];
  let calls = 0;
  let pauses = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const result = await scenario(seed);
    violations.push(...result.violations);
    calls += result.calls;
    pauses += result.pauses;
  }
  assert.deepEqual(violations.slice(0, 10), []);
  // The scenarios must actually exercise the governor: thousands of calls and many pauses.
  assert.ok(calls > 5_000, `${calls} calls`);
  assert.ok(pauses > 100, `${pauses} pauses`);
});
