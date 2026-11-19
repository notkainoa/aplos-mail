import { FakeClock } from '../../emulators/src/kit/clock';
import { gmailBudget } from '../src/sync/budgets';
import {
  Governor,
  type GovernorLogEvent,
  type GovernorLogFields,
  type GovernorOptions,
} from '../src/sync/governor';
import type { ClassifiedError } from '@aplos/contract';
import { ProviderError, type GovernedRequest, type SyncLane } from '../src/ports';

export { FakeClock };

export const ACCOUNT = 'acct-1';
export const MINUTE = 60_000;

export interface LogEntry {
  event: GovernorLogEvent;
  fields: GovernorLogFields;
  at: number;
}

export function setup(
  options: Partial<GovernorOptions> & { auto?: boolean; clock?: FakeClock } = {},
) {
  const clock = options.clock ?? new FakeClock({ auto: options.auto ?? true });
  const logs: LogEntry[] = [];
  const governor = new Governor({
    role: 'primary',
    random: () => 0,
    ...options,
    clock,
    logger: (event, fields) => logs.push({ event, fields, at: clock.now() }),
  });
  return { clock, governor, logs };
}

export function req(
  lane: SyncLane,
  cost: number,
  extra: Partial<GovernedRequest> = {},
): GovernedRequest {
  return { budget: 'gmail', lane, cost, kind: 'read', method: 'gmail.threads.get', ...extra };
}

export function refusal(
  cls: ClassifiedError['class'],
  extra: Partial<ClassifiedError> = {},
  scope?: 'account' | 'project',
): ProviderError {
  return new ProviderError(
    {
      class: cls,
      provider: 'google',
      method: 'gmail.threads.get',
      reason: reasonFor(cls),
      status: 403,
      ...extra,
    },
    scope,
  );
}

function reasonFor(cls: ClassifiedError['class']): string {
  switch (cls) {
    case 'throttle':
      return 'rateLimitExceeded';
    case 'daily':
      return 'dailyLimitExceeded';
    case 'auth':
      return 'invalid_grant';
    case 'send_limit':
      return 'userRateLimitExceeded';
    case 'transient':
      return 'backendError';
    default:
      return cls;
  }
}

/** Max units in any window of `windowMs` ending at a call, over a list of (time, units) calls. */
export function maxWindow(
  calls: readonly { at: number; units: number }[],
  windowMs = MINUTE,
): number {
  let max = 0;
  for (const call of calls) {
    let sum = 0;
    for (const other of calls)
      if (other.at <= call.at && call.at - other.at < windowMs) sum += other.units;
    max = Math.max(max, sum);
  }
  return max;
}

/** A deterministic PRNG (mulberry32). */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A promise with its resolvers exposed. */
export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let promise callbacks run. */
export async function settle(turns = 5): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise<void>(resolve => setImmediate(resolve));
}

export { gmailBudget };
