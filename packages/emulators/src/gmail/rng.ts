/**
 * Seeded randomness. Every emulator decision that looks random (ids, history steps, the batch
 * refusal curve, generated mail) comes from here, so a seed reproduces a run exactly.
 */
export type Rng = () => number;

/** Small, fast PRNG (mulberry32). Good enough for fixtures; not for secrets. */
export function mulberry32(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Folds several numbers into one seed, so a decision can have its own stream (e.g. batch 7, part 3). */
export function mixSeed(...parts: number[]): number {
  let hash = 2166136261;
  for (const part of parts) {
    hash ^= part >>> 0;
    hash = Math.imul(hash, 16777619);
    hash ^= hash >>> 13;
  }
  return hash >>> 0;
}

export class Random {
  private readonly next: Rng;

  constructor(seed: number) {
    this.next = mulberry32(seed);
  }

  float(): number {
    return this.next();
  }

  /** Integer in [min, max], both inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }

  /** Picks by weight; `[['a', 3], ['b', 1]]` returns 'a' three times as often as 'b'. */
  weighted<T>(items: readonly (readonly [T, number])[]): T {
    const total = items.reduce((sum, [, weight]) => sum + weight, 0);
    let point = this.next() * total;
    for (const [item, weight] of items) {
      point -= weight;
      if (point < 0) return item;
    }
    return items[items.length - 1][0];
  }

  hex(length: number): string {
    let out = '';
    while (out.length < length)
      out += Math.floor(this.next() * 0x100000000)
        .toString(16)
        .padStart(8, '0');
    return out.slice(0, length);
  }
}
