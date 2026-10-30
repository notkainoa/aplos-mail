import type { State } from './contract-shapes';

/**
 * Orders change-log positions. `seq` compares only within one `dbEpoch`; across epochs, the one observed later is
 * newer (a reset or restore starts a new epoch, and everything from the old one is superseded).
 */
export class StateOrder {
  private readonly ranks = new Map<string, number>();

  observe(dbEpoch: string): void {
    if (!this.ranks.has(dbEpoch)) this.ranks.set(dbEpoch, this.ranks.size);
  }

  /** Negative when `a` is older than `b`, 0 when equal, positive when newer. */
  compare(a: State, b: State): number {
    this.observe(a.dbEpoch);
    this.observe(b.dbEpoch);
    if (a.dbEpoch !== b.dbEpoch) return this.ranks.get(a.dbEpoch)! - this.ranks.get(b.dbEpoch)!;
    return a.seq - b.seq;
  }

  /** True when `current` is at or past `target`; never for an unknown current. */
  reached(current: State | null | undefined, target: State): boolean {
    return !!current && this.compare(current, target) >= 0;
  }
}
