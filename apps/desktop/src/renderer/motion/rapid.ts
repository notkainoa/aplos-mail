// Rapid mode (DESIGN 4.8, 4.9). A triage key that follows the previous one by
// less than timing.rapidGap is rapid and plays at the rapid durations; from the
// timing.burstKeys-th key inside timing.burstWindow, flight becomes carry.
// Pure: the caller passes the time of each key.
import { timing } from '../ui/generated/motion';

export interface RapidState {
  /** This key came under timing.rapidGap after the previous one. */
  readonly rapid: boolean;
  /** At least timing.burstKeys keys, this one included, inside timing.burstWindow. */
  readonly burst: boolean;
}

export interface RapidTracker {
  /** Records a triage key at `at` (ms) and classifies it. */
  key(at: number): RapidState;
  /** What a key at `at` would be, without recording it. */
  peek(at: number): RapidState;
  reset(): void;
}

export function createRapidTracker(): RapidTracker {
  let recent: number[] = [];

  function classify(at: number): { state: RapidState; kept: number[] } {
    const kept = recent.filter(t => at - t < timing.burstWindow);
    const last = recent[recent.length - 1];
    const rapid = last !== undefined && at - last < timing.rapidGap;
    return { state: { rapid, burst: kept.length + 1 >= timing.burstKeys }, kept };
  }

  return {
    key(at) {
      const { state, kept } = classify(at);
      recent = [...kept, at];
      return state;
    },
    peek: at => classify(at).state,
    reset() {
      recent = [];
    },
  };
}
