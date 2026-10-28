// A retargetable WAAPI transform tween for the cursor layer and the puck. The
// element's own style always holds the final transform; the animation only
// draws the way there, so nothing is left behind once it ends. Retargeting
// mid-way starts the new animation from the value drawn at that moment.
import type { MotionName } from '../ui/generated/motion';
import { play, type Playing } from './animate';
import { progressOf, type Progress } from './easing';

export interface TransformTween {
  /** The values drawn now. */
  readonly value: readonly number[];
  readonly target: readonly number[];
  readonly running: boolean;
  /** Goes to `target`: at once when `duration` is 0, otherwise from the drawn value on `curve`. */
  to(target: readonly number[], duration: number, curve: string | null, motion: MotionName): void;
  /** Lands on the target now. */
  stop(): void;
}

interface Run {
  readonly from: readonly number[];
  readonly start: number;
  readonly duration: number;
  readonly progress: Progress;
  readonly playing: Playing;
}

const same = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length && a.every((v, i) => Math.abs(v - (b[i] ?? 0)) < 1e-6);

export function createTransformTween(
  element: HTMLElement,
  format: (values: readonly number[]) => string,
  now: () => number,
  initial: readonly number[],
): TransformTween {
  let target = [...initial];
  let run: Run | null = null;

  function drawn(): readonly number[] {
    if (!run || run.playing.done) return target;
    const p = run.progress(Math.min(1, Math.max(0, (now() - run.start) / run.duration)));
    const from = run.from;
    return target.map((v, i) => (from[i] ?? v) + (v - (from[i] ?? v)) * p);
  }

  return {
    get value() {
      return drawn();
    },
    get target() {
      return target;
    },
    get running() {
      return run !== null && !run.playing.done;
    },
    to(next, duration, curve, motion) {
      const from = drawn();
      run?.playing.stop();
      run = null;
      target = [...next];
      element.style.transform = format(target);
      if (duration <= 0 || curve === null || same(from, target)) return;
      const playing = play(element, {
        motion,
        duration,
        easing: curve,
        keyframes: [{ transform: format(from) }, { transform: format(target) }],
      });
      run = { from, start: now(), duration, progress: progressOf(curve), playing };
    },
    stop() {
      run?.playing.stop();
      run = null;
    },
  };
}
