/**
 * The per-user quota meter: a sliding 60 s window of units. A request is refused when its cost
 * would take the window above the limit; units fall out of the window exactly 60 s after they
 * were charged. Also keeps a per-minute series and the highest 60 s total ever seen, so a test can
 * assert that a client never went above its own budget.
 */
export const WINDOW_MS = 60_000;

interface Charge {
  at: number;
  units: number;
}

export interface MinuteUnits {
  /** Start of the clock minute, in milliseconds since the epoch. */
  minuteStart: number;
  units: number;
}

export interface MeterVerdict {
  allowed: boolean;
  /** Time until enough units fall out of the window for this request to fit. */
  retryAfterMs: number;
}

export class UnitMeter {
  private readonly charges = new Map<string, Charge[]>();
  private readonly minutes = new Map<string, Map<number, number>>();
  private readonly peaks = new Map<string, number>();

  unitsInWindow(account: string, now: number): number {
    return this.live(account, now).reduce((sum, c) => sum + c.units, 0);
  }

  check(account: string, cost: number, now: number, limit: number): MeterVerdict {
    const live = this.live(account, now);
    const used = live.reduce((sum, c) => sum + c.units, 0);
    if (used + cost <= limit) return { allowed: true, retryAfterMs: 0 };
    // Walk the charges oldest first until enough of them have expired.
    let excess = used + cost - limit;
    let waitUntil = now + WINDOW_MS;
    for (const charge of live) {
      excess -= charge.units;
      waitUntil = charge.at + WINDOW_MS;
      if (excess <= 0) break;
    }
    return { allowed: false, retryAfterMs: Math.max(0, waitUntil - now) };
  }

  /** Adds units to the window. `accepted` units also show in the per-minute series. */
  charge(account: string, units: number, now: number, accepted = true): void {
    const live = this.live(account, now);
    live.push({ at: now, units });
    const total = live.reduce((sum, c) => sum + c.units, 0);
    this.peaks.set(account, Math.max(this.peaks.get(account) ?? 0, total));
    if (accepted) {
      const series = this.minutes.get(account) ?? new Map<number, number>();
      const minuteStart = Math.floor(now / 60_000) * 60_000;
      series.set(minuteStart, (series.get(minuteStart) ?? 0) + units);
      this.minutes.set(account, series);
    }
  }

  /** Units accepted in each clock minute that saw traffic, oldest first. */
  perMinuteSeries(account: string): MinuteUnits[] {
    const series = this.minutes.get(account);
    if (!series) return [];
    return [...series.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([minuteStart, units]) => ({ minuteStart, units }));
  }

  /** The highest total the 60 s window ever held. */
  peakWindow(account: string): number {
    return this.peaks.get(account) ?? 0;
  }

  /** Forgets everything charged so far (the window, series and peak). */
  reset(): void {
    this.charges.clear();
    this.minutes.clear();
    this.peaks.clear();
  }

  /** Charges still inside (now - 60 s, now]; older ones are dropped for good. */
  private live(account: string, now: number): Charge[] {
    const all = this.charges.get(account) ?? [];
    const live = all.filter(c => c.at > now - WINDOW_MS);
    this.charges.set(account, live);
    return live;
  }
}
