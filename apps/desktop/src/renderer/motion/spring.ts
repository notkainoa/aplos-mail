// Interruptible springs (DESIGN 4.8 springs, 5 rules 5 and 15) on the
// generated analytic solver. The state is advanced to the exact moment of any
// read or retarget, so a retarget keeps the drawn value and velocity with no
// jump. Frames come from the shared scheduler: a hidden window pauses the
// spring (visible time stops), and pointercancel can stop it.
import {
  retargetSpring,
  springAtRest,
  springs,
  stepSpring,
  type SpringName,
  type SpringParams,
  type SpringState,
} from '../ui/generated/motion';
import type { Scheduler } from './scheduler';

export interface SpringOptions {
  /** A generated spring by name, or explicit parameters. */
  readonly spring: SpringName | SpringParams;
  readonly from: number;
  /** Defaults to `from` (at rest). */
  readonly to?: number;
  /** Units per second. */
  readonly velocity?: number;
  /** Each frame, and once more at rest. Write the transform here; never set React state. */
  readonly onUpdate?: (value: number, velocity: number) => void;
  readonly onRest?: (value: number) => void;
}

export interface SpringMotion {
  /** The value drawn now. */
  readonly value: number;
  /** Units per second, now. */
  readonly velocity: number;
  readonly target: number;
  readonly running: boolean;
  /** Moves the target; value and velocity carry over. */
  retarget(target: number): void;
  /** Jumps to `value` with `velocity` (units per second), keeping the target. */
  set(value: number, velocity?: number): void;
  /** Stops where it is drawn, velocity 0. */
  stop(): void;
  /** Stops on `type` (pointercancel by default) from `target`. Returns an unsubscribe function. */
  stopOn(target: EventTarget, type?: string): () => void;
}

const paramsOf = (spring: SpringName | SpringParams): SpringParams =>
  typeof spring === 'string' ? springs[spring] : spring;

const travelBetween = (from: number, to: number) => Math.abs(to - from) || 1;

export function createSpringMotion(scheduler: Scheduler, options: SpringOptions): SpringMotion {
  const params = paramsOf(options.spring);
  const to = options.to ?? options.from;
  let state: SpringState = {
    value: options.from,
    velocity: options.velocity ?? 0,
    target: to,
    travel: travelBetween(options.from, to),
  };
  let at = scheduler.now();
  let cancelLoop: (() => void) | null = null;

  function advance(now: number) {
    const dt = (now - at) / 1000;
    if (dt > 0 && cancelLoop) state = stepSpring(params, state, dt);
    at = now;
  }

  function settle() {
    cancelLoop?.();
    cancelLoop = null;
  }

  function tick(now: number): boolean {
    advance(now);
    if (springAtRest(state)) {
      state = { ...state, value: state.target, velocity: 0 };
      cancelLoop = null;
      options.onUpdate?.(state.value, 0);
      options.onRest?.(state.value);
      return false;
    }
    options.onUpdate?.(state.value, state.velocity);
    return true;
  }

  function run() {
    if (cancelLoop) return;
    at = scheduler.now();
    cancelLoop = scheduler.loop(tick);
  }

  if (state.value !== state.target || state.velocity !== 0) run();

  const motion: SpringMotion = {
    get value() {
      advance(scheduler.now());
      return state.value;
    },
    get velocity() {
      advance(scheduler.now());
      return state.velocity;
    },
    get target() {
      return state.target;
    },
    get running() {
      return cancelLoop !== null;
    },
    retarget(target) {
      advance(scheduler.now());
      state = retargetSpring(state, target);
      run();
    },
    set(value, velocity = 0) {
      advance(scheduler.now());
      state = {
        value,
        velocity,
        target: state.target,
        travel: travelBetween(value, state.target),
      };
      run();
    },
    stop() {
      advance(scheduler.now());
      state = { ...state, velocity: 0, target: state.value };
      settle();
    },
    stopOn(target, type = 'pointercancel') {
      const listener = () => motion.stop();
      target.addEventListener(type, listener);
      return () => target.removeEventListener(type, listener);
    },
  };
  return motion;
}
