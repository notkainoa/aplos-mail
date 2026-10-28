// The one shared list-cursor layer (DESIGN 4.8 `cursor`): a single element
// moved by transform, never a per-row highlight. A key moves it over 120 ms
// (160 ms to the Home focus slot); key repeat, the pointer, rapid triage and
// reduced motion move it at once. A new move starts from where it is drawn.
import { motionMs, motions, type MotionContext } from '../ui/generated/motion';
import type { Scheduler } from './scheduler';
import { createTransformTween } from './tween';

/** Why the cursor moves: a key press, an auto-repeat, or the pointer. */
export type CursorCause = 'key' | 'repeat' | 'pointer';

export interface CursorMove {
  /** Offset of the row's top in the list, px. */
  readonly y: number;
  readonly x?: number;
  readonly cause: CursorCause;
  /** Moving to or from the Home focus slot. */
  readonly focus?: boolean;
}

export interface CursorLayer {
  move(to: CursorMove, context?: MotionContext): void;
  /** The drawn [x, y]. */
  readonly position: readonly number[];
  readonly moving: boolean;
  dispose(): void;
}

/** The cursor's duration for one move; 0 on repeat and pointer. */
export function cursorMs(to: Pick<CursorMove, 'cause' | 'focus'>, context: MotionContext): number {
  if (to.cause !== 'key') return 0;
  return motionMs('cursor', to.focus ? 'focus' : 'base', context);
}

export function createCursorLayer(element: HTMLElement, scheduler: Scheduler): CursorLayer {
  const tween = createTransformTween(
    element,
    ([x = 0, y = 0]) => `translate(${x}px, ${y}px)`,
    () => scheduler.env.now(),
    [0, 0],
  );
  const unsubscribe = scheduler.onHide(() => tween.stop());

  return {
    move(to, context = {}) {
      const reduced = context.reduced ?? scheduler.env.prefersReducedMotion();
      const duration = cursorMs(to, { ...context, reduced });
      tween.to([to.x ?? 0, to.y], duration, motions.cursor.curve, 'cursor');
    },
    get position() {
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
