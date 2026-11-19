// `slide` (DESIGN 4.8): the one shared puck per group moves by translate and
// scaleX against a fixed base width, never by width. The thumb's
// transform-origin must be its left edge. Under reduced motion it lands at once.
import { motionMs, motions, type MotionContext } from '../ui/generated/motion';
import type { Scheduler } from './scheduler';
import { createTransformTween } from './tween';

/** A cell's box relative to the group, px. */
export interface PuckCell {
  readonly x: number;
  readonly y: number;
  readonly width: number;
}

export interface PuckSlider {
  /** Slides to `cell`; `instant` for the first placement, so nothing slides in on mount. */
  moveTo(cell: PuckCell, options?: { instant?: boolean; context?: MotionContext }): void;
  /** The drawn [x, y, scaleX]. */
  readonly drawn: readonly number[];
  readonly moving: boolean;
  dispose(): void;
}

/** The thumb's transform for a cell, given the width the thumb was laid out at. */
export function puckTransform(cell: PuckCell, baseWidth: number): string {
  return `translate(${cell.x}px, ${cell.y}px) scaleX(${cell.width / baseWidth})`;
}

export function createPuckSlider(
  thumb: HTMLElement,
  baseWidth: number,
  scheduler: Scheduler,
): PuckSlider {
  const toCell = ([x = 0, y = 0, sx = 1]: readonly number[]): PuckCell => ({
    x,
    y,
    width: sx * baseWidth,
  });
  const tween = createTransformTween(
    thumb,
    values => puckTransform(toCell(values), baseWidth),
    () => scheduler.env.now(),
    [0, 0, 1],
  );
  const unsubscribe = scheduler.onHide(() => tween.stop());

  return {
    moveTo(cell, options = {}) {
      const reduced = options.context?.reduced ?? scheduler.env.prefersReducedMotion();
      const duration = options.instant
        ? 0
        : motionMs('slide', 'base', { ...options.context, reduced });
      tween.to([cell.x, cell.y, cell.width / baseWidth], duration, motions.slide.curve, 'slide');
    },
    get drawn() {
      return tween.value;
    },
    get moving() {
      return tween.running;
    },
    dispose() {
      unsubscribe();
      tween.stop();
    },
  };
}
