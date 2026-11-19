import {
  gateNow,
  gateReading,
  ownerGate,
  type ClockGate,
  type ClockReading,
  type LeaseClaim,
  type Lease,
} from './lease';

/** The clock-gate state the host keeps per account (a part of its lease entry). */
export interface ClockedEntry {
  gate: ClockGate;
  /**
   * The gate as it stood before an owner's "Use this Mac" lifted its block (`ownerGate`), until a write measures the
   * clock again: a pin whose read or write then fails puts it back (`settleOwnerLift`), so the lift never outlives it.
   */
  ownerLift?: ClockGate;
}

/** The gate an owner's pin may use: a block lifted on one fresh ok reading, the gate before it kept to re-arm. */
export function ownerClock(entry: ClockedEntry, now: number): ClockReading {
  const before = gateNow(entry, now);
  entry.gate = ownerGate(before, now);
  if (entry.gate !== before) entry.ownerLift ??= before;
  return gateReading(entry.gate, now);
}

/**
 * After an owner's claim: a lift that no write has measured since (the pin's read or write failed, or it was never
 * sent) is undone, so the block's two-reading rule still guards the automatic claims that follow.
 */
export function settleOwnerLift(entry: ClockedEntry): void {
  if (entry.ownerLift) entry.gate = entry.ownerLift;
  entry.ownerLift = undefined;
}

/**
 * Who compacts after a write: the primary, everything its renewal supersedes; a device the clock gate blocks, or
 * whose clock no write has proven (`unmeasured`: its checks keep failing), only its own copies its claim supersedes
 * (nobody else trashes them, and it never trashes another device's copy). A healthy secondary leaves it to the
 * primary; a quit's dead claim never compacts.
 */
export function compactMode(
  entry: ClockedEntry & { retiring?: boolean },
  role: Lease['role'],
  entries: { value: LeaseClaim }[],
  now: number,
): { ownOnly: boolean } | undefined {
  if (entry.retiring) return undefined;
  if (gateReading(gateNow(entry, now), now) !== 'ok') return { ownOnly: true };
  if (!entries.some(e => e.value.holder)) return undefined;
  return role === 'primary' ? { ownOnly: false } : undefined;
}
