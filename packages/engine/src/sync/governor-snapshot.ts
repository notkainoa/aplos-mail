import type { GovernorSnapshot } from '../ports';
import { RESERVE_REFRESH_MS, dropUndefined, type Meter } from './governor-meter';
import {
  batchNow,
  effectiveTarget,
  inFlightLimit,
  ownPause,
  quietSteps,
  regrowStep,
  regrowSteps,
} from './governor-math';
import { SlidingWindow } from './window';

/** The persisted view of one meter; `auth` is its account's auth block, if any. */
export function describeMeter(
  m: Meter,
  now: number,
  auth: { reason: string; since: number } | undefined,
): GovernorSnapshot {
  const own = ownPause(m, now);
  const sending =
    m.sendBlockedUntil !== undefined && m.sendBlockedUntil > now
      ? { cls: 'send_limit' as const, reason: m.sendReason ?? '' }
      : undefined;
  const shown = auth
    ? { cls: 'auth' as const, reason: auth.reason }
    : m.stop
      ? { cls: 'config' as const, reason: m.stop.reason }
      : (own ?? sending);
  const blocked = auth
    ? { cls: 'auth' as const, since: auth.since }
    : m.stop
      ? { cls: 'config' as const, since: m.stop.since }
      : undefined;
  return dropUndefined<GovernorSnapshot>({
    budget: m.spec.id,
    target: effectiveTarget(m, now),
    inFlightLimit: inFlightLimit(m, now),
    batchSize: batchNow(m, now),
    windowSpent: m.reservedAt !== undefined ? m.reservedSpent : 0,
    windowAt: m.reservedAt ?? 0,
    cooldownUntil: m.cooldownUntil,
    cooldownStep: m.cooldownStep,
    dailyBlockUntil: m.blockUntil !== undefined && m.blockUntil > now ? m.blockUntil : undefined,
    sendBlockedUntil: sending ? m.sendBlockedUntil : undefined,
    blocked,
    cls: shown?.cls,
    reason: shown?.reason,
    lastRefusalAt: m.lastRefusalAt,
  });
}

export function changeKey(snap: GovernorSnapshot): string {
  return JSON.stringify(snap);
}

/** Seeds a meter's cooldown, AIMD, in-flight cap, batch size and stops from its persisted snapshot. */
export function restoreMeterState(m: Meter, snap: GovernorSnapshot, now: number): void {
  const roleMax = Math.max(m.spec.target.primary, m.spec.target.secondary);
  m.cooldownUntil = snap.cooldownUntil;
  m.cooldownStep = snap.cooldownStep ?? 0;
  m.cooldownReason = snap.cls === 'throttle' ? snap.reason : undefined;
  // AIMD and the in-flight cap only exist inside a quiet period, which the kept cooldown end marks.
  m.aimdTarget =
    snap.cooldownUntil !== undefined && snap.target < roleMax
      ? snap.target - regrowSteps(m, now) * regrowStep(m.spec)
      : undefined;
  m.capBase =
    snap.cooldownUntil !== undefined && snap.inFlightLimit < m.spec.inFlight
      ? snap.inFlightLimit - quietSteps(m, now)
      : undefined;
  if (m.spec.batch && Number.isFinite(snap.batchSize)) {
    m.batchBase = Math.min(m.spec.batch.max, Math.max(m.spec.batch.min, snap.batchSize));
    m.batchSince = now;
  }
  const blockCls = snap.cls === 'daily' || snap.cls === 'anti_abuse' ? snap.cls : undefined;
  m.blockUntil = snap.dailyBlockUntil;
  m.blockCls = blockCls ?? 'daily';
  m.blockReason = blockCls ? snap.reason : undefined;
  m.sendBlockedUntil = snap.sendBlockedUntil;
  m.sendReason = snap.cls === 'send_limit' ? snap.reason : undefined;
  m.lastRefusalAt = snap.lastRefusalAt;
}

/** Re-charges the persisted window spend into a fresh window. */
export function restoreWindow(m: Meter, snap: GovernorSnapshot, now: number): void {
  m.window = new SlidingWindow(m.spec.windowMs);
  if (snap.windowSpent > 0) {
    // Every unit the old process spent left by windowAt + RESERVE_REFRESH_MS (and by now), so a charge at the
    // earlier of the two outlives all of them.
    m.window.charge(Math.min(now, snap.windowAt + RESERVE_REFRESH_MS), snap.windowSpent);
  }
  m.reservedSpent = snap.windowSpent;
  m.reservedAt = snap.windowAt || undefined;
}
