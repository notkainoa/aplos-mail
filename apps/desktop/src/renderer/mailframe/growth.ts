// The growth fence (PROTOCOL.md "Runaway growth"). The host sizes the frame to the letter's reported height, and the
// letter is laid out in that frame: content sized in viewport units (`100vh`, `150vh`) is then taller each time the
// frame is, so the letter and the host chase each other until the 200,000 px clamp, or forever for `100vh` plus
// padding (seen in Chromium with the real reporter, with renderer memory in the gigabytes). Neither sanitiser rewrites
// viewport units yet, so the host fences it: a letter may grow `MAX_GROWTHS` times, then keeps its height for good.
// A count, not a rate: a loop on a busy machine runs slower but never stops on its own, so only a count bounds it.
// Images arriving or a `<details>` opening grow a letter a few dozen times at most.

/** Growth steps one letter may take; after that its height is frozen. */
export const MAX_GROWTHS = 100;

/** One letter's fence: feed it every measured height, apply what it returns. */
export interface GrowthFence {
  /** The height to apply for a new measurement. */
  next(height: number): number;
  /** True once the letter has been frozen. */
  frozen(): boolean;
}

/** A fence for one letter (one frame document). */
export function createGrowthFence(): GrowthFence {
  let applied = 0;
  let growths = 0;
  const frozen = () => growths >= MAX_GROWTHS;
  const next = (height: number): number => {
    if (frozen()) return applied;
    if (applied > 0 && height > applied) growths++;
    applied = height;
    return applied;
  };
  return { next, frozen };
}
