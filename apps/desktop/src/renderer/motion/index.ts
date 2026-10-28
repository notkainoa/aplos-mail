// The motion runtime (plan 30 4.3, DESIGN 4.8, 4.9 and 5). Hand-written
// modules on top of the generated ui/generated/motion.ts; screens reach motion
// only through here.
import type { MotionEnv } from './env';
import { createGhostLayer, type GhostLayer } from './ghost';
import { createHoldGate, type HoldGate } from './holdGate';
import { createRapidTracker, type RapidTracker } from './rapid';
import { createScheduler, type Scheduler } from './scheduler';

export {
  ANIMATABLE,
  animatedProperties,
  play,
  type MotionFrame,
  type MotionPlan,
  type Playing,
} from './animate';
export {
  createCursorLayer,
  cursorMs,
  type CursorCause,
  type CursorLayer,
  type CursorMove,
} from './cursor';
export { cubicBezier, piecewiseLinear, progressOf, type Progress } from './easing';
export { browserEnv, type MotionEnv, type TimerHandle } from './env';
export {
  closeDeltas,
  closePlan,
  createCloser,
  layoutTops,
  type Closer,
  type CloserOptions,
} from './flip';
export {
  createGhostLayer,
  MAX_GHOSTS,
  type Ghost,
  type GhostExtra,
  type GhostLayer,
  type GhostLayerOptions,
  type LaunchOptions,
} from './ghost';
export { createHoldGate, type HoldGate } from './holdGate';
export { createPuckSlider, puckTransform, type PuckCell, type PuckSlider } from './puck';
export { createRapidTracker, type RapidState, type RapidTracker } from './rapid';
export { createScheduler, type FrameTask, type Scheduler } from './scheduler';
export {
  carryPlan,
  commitChipPlan,
  commitEdgePlan,
  dealPlan,
  departurePlan,
  directionOf,
  FLIGHT_FADE_FROM,
  flightPlan,
  handoffFlightPlan,
  type Surface,
  type TriageContext,
} from './signature';
export { createSpringMotion, type SpringMotion, type SpringOptions } from './spring';
export {
  armedSide,
  armPulsePlan,
  createSwipe,
  SWIPE_DISTANCE,
  SWIPE_VELOCITY,
  type Swipe,
  type SwipeOptions,
  type SwipeSide,
} from './swipe';
export { createThemeFreeze, type ThemeFreeze } from './themeFreeze';
export {
  createTriageMotion,
  type FocusMove,
  type ListChange,
  type TriageCommit,
  type TriageMotion,
  type TriageMotionOptions,
} from './triage';
export { createTransformTween, type TransformTween } from './tween';

/** The window-wide pieces: one scheduler, one ghost layer, one rapid tracker. Holds are per list. */
export interface MotionRuntime {
  readonly scheduler: Scheduler;
  readonly ghosts: GhostLayer;
  readonly rapid: RapidTracker;
  /** A hold gate for one list. */
  createHold(): HoldGate;
  dispose(): void;
}

export function createMotionRuntime(env: MotionEnv, host?: HTMLElement): MotionRuntime {
  const scheduler = createScheduler(env);
  const ghosts = createGhostLayer({ scheduler, host });
  const holds = new Set<HoldGate>();
  return {
    scheduler,
    ghosts,
    rapid: createRapidTracker(),
    createHold() {
      const hold = createHoldGate(scheduler);
      holds.add(hold);
      return hold;
    },
    dispose() {
      for (const hold of holds) hold.dispose();
      ghosts.dispose();
      scheduler.dispose();
    },
  };
}
