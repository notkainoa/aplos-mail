import type { BudgetSpec } from '../ports';
import { MAX_TIME, QUIET_MS, REGROW_INTERVAL_MS, type Block, type Meter } from './governor-meter';

/** The HTTP batch size: halved on a throttle, then +growBy per quiet 10 minutes up to max (F3 `BudgetSpec.batch`). */
export function batchNow(m: Meter, now: number): number {
  const batch = m.spec.batch;
  if (!batch) return 1;
  const quiet = now < m.batchSince ? 0 : Math.floor((now - m.batchSince) / QUIET_MS);
  return Math.min(batch.max, m.batchBase + quiet * batch.growBy);
}

/** ARCH 6.2: Gmail regrows 250 a minute, 1/18 of its 4,500 primary target; other budgets in proportion. */
export function regrowStep(spec: BudgetSpec): number {
  return Math.max(1, Math.round(spec.target.primary / 18));
}

export function regrowSteps(m: Meter, now: number): number {
  if (m.cooldownUntil === undefined || now < m.cooldownUntil + QUIET_MS) return 0;
  return Math.floor((now - m.cooldownUntil - QUIET_MS) / REGROW_INTERVAL_MS) + 1;
}

/** Whole quiet 10-minute periods since the cooldown ended: the in-flight limit regrows by one per period. */
export function quietSteps(m: Meter, now: number): number {
  if (m.cooldownUntil === undefined || now < m.cooldownUntil) return 0;
  return Math.floor((now - m.cooldownUntil) / QUIET_MS);
}

/** The AIMD target with its regrowth so far, before the role's cap. */
export function aimdValue(m: Meter, now: number): number | undefined {
  if (m.aimdTarget === undefined) return undefined;
  return m.aimdTarget + regrowSteps(m, now) * regrowStep(m.spec);
}

export function inFlightLimit(m: Meter, now: number): number {
  if (m.capBase === undefined) return m.spec.inFlight;
  return Math.min(m.spec.inFlight, Math.max(1, m.capBase + quietSteps(m, now)));
}

export function effectiveTarget(m: Meter, now: number): number {
  return Math.min(m.spec.target[m.role], aimdValue(m, now) ?? Infinity);
}

/** When the target or the in-flight limit next changes on its own, while something waits. */
export function nextTargetChange(m: Meter, now: number): number {
  const q = m.cooldownUntil;
  if (q === undefined) return Infinity;
  let next = Infinity;
  if (m.aimdTarget !== undefined) {
    const start = q + QUIET_MS;
    next =
      now < start
        ? start
        : start + (Math.floor((now - start) / REGROW_INTERVAL_MS) + 1) * REGROW_INTERVAL_MS;
  }
  if (m.capBase !== undefined) {
    const cap = now < q ? q + QUIET_MS : q + (Math.floor((now - q) / QUIET_MS) + 1) * QUIET_MS;
    next = Math.min(next, cap);
  }
  return next;
}

/** A time-limited pause on this meter alone: the later of its cooldown and its daily or anti-abuse stop. */
export function ownPause(m: Meter, now: number): Block | undefined {
  const cooling = m.cooldownUntil !== undefined && m.cooldownUntil > now ? m.cooldownUntil : 0;
  const blocked = m.blockUntil !== undefined && m.blockUntil > now ? m.blockUntil : 0;
  if (!cooling && !blocked) return undefined;
  const base = { account: m.account, budget: m.spec.id };
  return blocked >= cooling
    ? { ...base, until: blocked, cls: m.blockCls ?? 'daily', reason: m.blockReason ?? '' }
    : { ...base, until: cooling, cls: 'throttle', reason: m.cooldownReason ?? '' };
}

/** `now + ms`, clamped to the latest instant a Date can hold. */
export function after(now: number, ms: number): number {
  return Math.min(MAX_TIME, now + ms);
}

/** A provider-stated time if it is still ahead, clamped like `after`. */
export function futureTime(now: number, time: number | undefined): number | undefined {
  return time !== undefined && time > now ? Math.min(MAX_TIME, time) : undefined;
}
