/**
 * A sliding log of charged units. A charge made at `at` counts while `now - at < windowMs`, so it
 * stops counting exactly `windowMs` after it was made. Each charge may carry a lane tag, so a lane's
 * own spend can be capped separately from the window's total.
 */
export interface Charge {
  at: number;
  units: number;
  lane?: string;
}

export class SlidingWindow {
  private charges: Charge[] = [];
  private total = 0;
  private readonly byLane = new Map<string, number>();

  constructor(readonly windowMs: number) {}

  /** Records `units` charged at `at` (never earlier than the last charge) and returns the entry. */
  charge(at: number, units: number, lane?: string): Charge | undefined {
    if (units <= 0) return undefined;
    const charge: Charge = { at, units, lane };
    this.charges.push(charge);
    this.add(charge, units);
    return charge;
  }

  /**
   * Moves a charge to `at`, the moment the request actually left. Only ever forward, and `at` is the
   * current time, so moving the entry to the end keeps the log in time order.
   */
  restamp(charge: Charge, at: number): void {
    const index = this.charges.indexOf(charge);
    if (index < 0 || at <= charge.at) return;
    this.charges.splice(index, 1);
    charge.at = at;
    this.charges.push(charge);
  }

  /** Units in the window: all of them, or only those charged to `lane`. */
  used(now: number, lane?: string): number {
    this.prune(now);
    return lane === undefined ? this.total : (this.byLane.get(lane) ?? 0);
  }

  /**
   * The earliest time at or after `now` when `fits(total, own)` holds, where `total` is the window's
   * units and `own` the units charged to `lane`, as old charges age out.
   */
  fitsAt(now: number, fits: (total: number, own: number) => boolean, lane?: string): number {
    this.prune(now);
    let total = this.total;
    let own = lane === undefined ? 0 : (this.byLane.get(lane) ?? 0);
    if (fits(total, own)) return now;
    for (const charge of this.charges) {
      total -= charge.units;
      if (lane !== undefined && charge.lane === lane) own -= charge.units;
      if (fits(total, own)) return charge.at + this.windowMs;
    }
    return now;
  }

  private add(charge: Charge, units: number): void {
    this.total += units;
    if (charge.lane !== undefined)
      this.byLane.set(charge.lane, (this.byLane.get(charge.lane) ?? 0) + units);
  }

  private prune(now: number): void {
    // The system clock stepped back: a charge cannot be from the future, so it counts from now rather than keeping the
    // window full for the size of the jump.
    for (let i = this.charges.length - 1; i >= 0 && this.charges[i].at > now; i--)
      this.charges[i].at = now;
    let drop = 0;
    while (drop < this.charges.length && now - this.charges[drop].at >= this.windowMs) {
      this.add(this.charges[drop], -this.charges[drop].units);
      drop++;
    }
    if (drop) this.charges.splice(0, drop);
  }
}
