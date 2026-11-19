// Swipe to triage (DESIGN 4.9 Swipe). The letter follows the pointer on the
// `follow` spring. Past 30 % of the width, or faster than 0.6 px/ms, the side
// arms: the caller shows the underlay's armed state and its icon pulses on
// `snap`. Throwing back the other way faster than 0.6 px/ms disarms, and
// arming is re-checked every frame while pressed, so an arm won by speed lapses
// when the pointer stops: what the underlay shows is what release does.
// Releasing while armed commits and hands the letter to a ghost that
// continues from the drawn position and velocity into flight; releasing
// unarmed springs back on `snap` from the drawn value and velocity. A new
// press during the spring-back picks it up where it is. pointercancel stops the
// springs and puts the letter back at rest.
import type { CommitKind } from '../ui/props';
import { motionMs, motions, scales } from '../ui/generated/motion';
import { play, type MotionPlan } from './animate';
import type { GhostLayer } from './ghost';
import type { Scheduler } from './scheduler';
import { handoffFlightPlan, type TriageContext } from './signature';
import { createSpringMotion, type SpringMotion } from './spring';

/** Arms at this share of the width (DESIGN 4.9). */
export const SWIPE_DISTANCE = 0.3;
/** Or above this pointer speed, px/ms (DESIGN 4.9). */
export const SWIPE_VELOCITY = 0.6;
/** Pointer samples older than this do not count toward the speed. */
const VELOCITY_WINDOW_MS = 100;

export type SwipeSide = 'right' | 'left';

export interface SwipeOptions {
  readonly element: HTMLElement;
  /** The element's width, px, from the fixed layout. */
  readonly width: number;
  readonly kinds: { readonly right: CommitKind; readonly left: CommitKind };
  readonly scheduler: Scheduler;
  readonly ghosts: GhostLayer;
  readonly release?: 'remove' | 'hide';
  /** The underlay icon of a side, to pulse when it arms. */
  readonly iconOf?: (side: SwipeSide) => HTMLElement | null;
  /** Arming changed: show or clear the underlay's armed state and the matching action button. */
  readonly onArm?: (side: SwipeSide | null) => void;
  /** The drawn offset, every frame (px). Write styles only. */
  readonly onOffset?: (x: number) => void;
  /** Released armed: commit the state now. The ghost is already flying. */
  readonly onCommit?: (kind: CommitKind, side: SwipeSide) => void;
  readonly context?: () => TriageContext;
}

export interface Swipe {
  down(x: number): void;
  move(x: number): void;
  /** Returns what the release did. */
  up(x: number): 'commit' | 'snap' | 'none';
  /** pointercancel. */
  cancel(): void;
  /** The drawn offset, px. */
  readonly offset: number;
  /** The drawn velocity, px/ms. */
  readonly velocity: number;
  readonly armed: SwipeSide | null;
  readonly active: boolean;
  dispose(): void;
}

/**
 * The side a drag arms, if any: distance past `SWIPE_DISTANCE` of the width, or speed past
 * `SWIPE_VELOCITY`. A throw back against the drag faster than `SWIPE_VELOCITY` arms nothing.
 */
export function armedSide(dx: number, velocity: number, width: number): SwipeSide | null {
  if (Math.abs(dx) >= SWIPE_DISTANCE * width) {
    if (Math.abs(velocity) > SWIPE_VELOCITY && Math.sign(velocity) !== Math.sign(dx)) return null;
    return dx > 0 ? 'right' : 'left';
  }
  if (Math.abs(velocity) > SWIPE_VELOCITY && Math.sign(velocity) === Math.sign(dx || velocity)) {
    return velocity > 0 ? 'right' : 'left';
  }
  return null;
}

/** The armed icon's pulse, 1 to 1.08 to 1 on `snap`. Null under reduced motion. */
export function armPulsePlan(context: TriageContext = {}): MotionPlan | null {
  const duration = motionMs('snap', 'base', context);
  if (duration <= 0) return null;
  return {
    motion: 'snap',
    duration,
    easing: motions.snap.curve,
    keyframes: [
      { transform: 'none' },
      { transform: `scale(${scales.snap})` },
      { transform: 'none' },
    ],
  };
}

export function createSwipe(options: SwipeOptions): Swipe {
  const { element, scheduler } = options;
  const contextOf = (): TriageContext => {
    const context = options.context?.() ?? {};
    return { ...context, reduced: context.reduced ?? scheduler.env.prefersReducedMotion() };
  };
  let spring: SpringMotion | null = null;
  let origin = 0;
  let pressed = false;
  let armed: SwipeSide | null = null;
  let samples: { x: number; at: number }[] = [];
  let lastDrawn = 0;
  let pointerDx = 0;
  let stopRecheck: (() => void) | null = null;

  const draw = (x: number) => {
    lastDrawn = x;
    element.style.transform = x === 0 ? '' : `translateX(${x}px)`;
    options.onOffset?.(x);
  };

  const drawnOffset = () => (spring ? spring.value : lastDrawn);

  function stopSpring() {
    spring?.stop();
    spring = null;
  }

  function endRecheck() {
    stopRecheck?.();
    stopRecheck = null;
  }

  function setArmed(side: SwipeSide | null) {
    if (side === armed) return;
    armed = side;
    options.onArm?.(side);
    if (!side) {
      endRecheck();
      return;
    }
    // Pointer speed decays without move events; keep the armed state honest until it lapses.
    stopRecheck ??= scheduler.loop(() => {
      if (!pressed || !armed) {
        stopRecheck = null;
        return false;
      }
      setArmed(armedSide(pointerDx, pointerVelocity(), options.width));
      return armed !== null;
    });
    const icon = options.iconOf?.(side);
    const pulse = armPulsePlan(contextOf());
    if (icon && pulse) play(icon, pulse);
  }

  function pointerVelocity(): number {
    const now = scheduler.env.now();
    const recent = samples.filter(s => now - s.at <= VELOCITY_WINDOW_MS);
    const first = recent[0];
    const last = recent[recent.length - 1];
    if (!first || !last || last.at <= first.at) return 0;
    return (last.x - first.x) / (last.at - first.at);
  }

  function follow(from: number, velocity: number) {
    stopSpring();
    if (contextOf().reduced) {
      draw(from);
      return;
    }
    spring = createSpringMotion(scheduler, {
      spring: 'follow',
      from,
      velocity,
      to: from,
      onUpdate: draw,
    });
  }

  function track(x: number) {
    if (!pressed) return;
    const dx = x - origin;
    pointerDx = dx;
    samples.push({ x, at: scheduler.env.now() });
    if (spring) spring.retarget(dx);
    else draw(dx);
    setArmed(armedSide(dx, pointerVelocity(), options.width));
  }

  function rest() {
    stopSpring();
    draw(0);
    setArmed(null);
  }

  return {
    down(x) {
      const drawn = drawnOffset();
      const velocity = spring?.velocity ?? 0;
      pressed = true;
      origin = x - drawn;
      pointerDx = drawn;
      samples = [{ x, at: scheduler.env.now() }];
      follow(drawn, velocity);
    },
    move: track,
    up(x) {
      if (!pressed) return 'none';
      // Release decides by the armed state on screen; a release away from the last move counts as one.
      if (x - origin !== pointerDx) track(x);
      const side = armed;
      const dx = pointerDx;
      pressed = false;
      endRecheck();
      const drawn = spring ? spring.value : dx;
      const velocity = spring ? spring.velocity / 1000 : 0;
      stopSpring();
      if (side) {
        const kind = options.kinds[side];
        draw(0);
        setArmed(null);
        options.ghosts.launch(element, handoffFlightPlan(kind, drawn, velocity, contextOf()), {
          release: options.release,
        });
        options.onCommit?.(kind, side);
        return 'commit';
      }
      setArmed(null);
      if (contextOf().reduced) {
        draw(0);
        return 'snap';
      }
      spring = createSpringMotion(scheduler, {
        spring: 'snap',
        from: drawn,
        velocity: velocity * 1000,
        to: 0,
        onUpdate: draw,
        onRest: () => {
          spring = null;
        },
      });
      return 'snap';
    },
    cancel() {
      pressed = false;
      samples = [];
      rest();
    },
    get offset() {
      return drawnOffset();
    },
    get velocity() {
      return spring ? spring.velocity / 1000 : 0;
    },
    get armed() {
      return armed;
    },
    get active() {
      return pressed || spring !== null;
    },
    dispose() {
      pressed = false;
      endRecheck();
      stopSpring();
    },
  };
}
