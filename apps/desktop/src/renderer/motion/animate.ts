// The only door to Element.animate in the runtime. It refuses any keyframe
// property but transform, opacity and the hover colours (DESIGN 5 rule 7),
// sets will-change for exactly the animated properties while the animation
// runs and clears it on finish or cancel (rule 14), and never uses fill, so
// nothing stays in document.getAnimations() after it settles.
import type { MotionName } from '../ui/generated/motion';

/** Properties a keyframe may carry. Colour is only for hover. */
export const ANIMATABLE = new Set([
  'transform',
  'opacity',
  'color',
  'backgroundColor',
  'borderColor',
]);
const KEYFRAME_META = new Set(['offset', 'easing', 'composite']);

export type MotionFrame = Keyframe & { transform?: string; opacity?: number };

/** One animation, described before it plays: what moves, how long and on which curve. */
export interface MotionPlan {
  /** The named motion it comes from (DESIGN 4.8). */
  readonly motion: MotionName;
  readonly keyframes: readonly MotionFrame[];
  readonly duration: number;
  readonly easing: string;
  readonly delay?: number;
}

export interface Playing {
  readonly animation: Animation;
  /** Ends it now, idempotent. The final state is whatever the element's own style says. */
  stop(): void;
  readonly done: boolean;
}

const cssName = (key: string) => key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`);

/** The properties a plan animates, in CSS spelling; throws on anything not allowed. */
export function animatedProperties(keyframes: readonly MotionFrame[]): string[] {
  const props = new Set<string>();
  for (const frame of keyframes) {
    for (const key of Object.keys(frame)) {
      if (KEYFRAME_META.has(key)) continue;
      if (!ANIMATABLE.has(key)) throw new Error(`Motion may not animate ${key}`);
      props.add(cssName(key));
    }
  }
  return [...props];
}

// The properties each running animation needs, per element, so overlapping
// animations on one element keep will-change until the last one ends.
const running = new WeakMap<HTMLElement, Map<object, readonly string[]>>();

function syncWillChange(element: HTMLElement) {
  const props = new Set<string>();
  for (const list of running.get(element)?.values() ?? []) for (const prop of list) props.add(prop);
  element.style.willChange = [...props].join(', ');
}

/** Plays `plan` on `element`. `onEnd` runs once, on finish or cancel. */
export function play(element: HTMLElement, plan: MotionPlan, onEnd?: () => void): Playing {
  const props = animatedProperties(plan.keyframes);
  const token = {};
  const mine = running.get(element) ?? new Map<object, readonly string[]>();
  running.set(element, mine);
  mine.set(token, props);
  syncWillChange(element);
  const animation = element.animate(plan.keyframes as Keyframe[], {
    duration: plan.duration,
    easing: plan.easing,
    delay: plan.delay ?? 0,
  });
  let done = false;
  const end = () => {
    if (done) return;
    done = true;
    mine.delete(token);
    syncWillChange(element);
    onEnd?.();
  };
  animation.onfinish = end;
  animation.oncancel = end;
  return {
    animation,
    stop() {
      if (done) return;
      animation.cancel();
      end();
    },
    get done() {
      return done;
    },
  };
}
