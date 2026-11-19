// "Carried off" (DESIGN 4.8, 4.9) as plain data: the keyframes and timings of
// commit, flight, carry and deal, built only from ui/generated/motion.ts.
// Done (and Trash) leave right and slightly up with a 2 degree tilt, Later
// leaves left and slightly down. Rapid halves the durations; the burst key (the
// fourth in a second) turns flight into the rapid carry; reduced motion turns
// flight and carry into a short fade.
import type { CommitKind } from '../ui/props';
import {
  easings,
  motionMs,
  motions,
  moves,
  scales,
  type MotionContext,
} from '../ui/generated/motion';
import type { MotionFrame, MotionPlan } from './animate';

export interface TriageContext extends MotionContext {
  /** From the burst key on (timing.burstKeys in timing.burstWindow): flight becomes carry. */
  readonly burst?: boolean;
}

/** What is leaving: the focus letter or reader column flies; a list row is carried. */
export type Surface = 'letter' | 'row';

/** The flight keeps full opacity for its first 40 % (DESIGN 4.8 `flight`). */
export const FLIGHT_FADE_FROM = 0.4;
/** Samples of the swipe hand-off flight, so 0.4 lands on a sample. */
const HANDOFF_STEPS = 10;

/** +1 leaves to the right (Done, Trash), -1 to the left (Later). */
export function directionOf(kind: CommitKind): 1 | -1 {
  return kind === 'later' ? -1 : 1;
}

function plan(
  motion: MotionPlan['motion'],
  duration: number,
  curve: string,
  keyframes: readonly MotionFrame[],
): MotionPlan | null {
  return duration > 0 ? { motion, duration, easing: curve, keyframes } : null;
}

const fadeOut = (transform = 'none'): MotionFrame[] => [
  { transform, opacity: 1 },
  { transform, opacity: 0 },
];

const flightTransform = (direction: 1 | -1, x: number, progress: number) =>
  `translate(${x}px, ${-direction * moves.flightY * progress}px) rotate(${direction * moves.flightRotate * progress}deg)`;

/** The 3 px commit edge: scaleY 0 to 1 (reduced: opacity). */
export function commitEdgePlan(context: TriageContext = {}): MotionPlan | null {
  const keyframes: MotionFrame[] = context.reduced
    ? [{ opacity: 0 }, { opacity: 1 }]
    : [{ transform: `scaleY(${scales.commitEdge})` }, { transform: 'none' }];
  return plan('commit', motionMs('commit', 'base', context), motions.commit.curve, keyframes);
}

/** The commit chip: opacity and scale .9 to 1 (reduced: opacity). */
export function commitChipPlan(context: TriageContext = {}): MotionPlan | null {
  const keyframes: MotionFrame[] = context.reduced
    ? [{ opacity: 0 }, { opacity: 1 }]
    : [
        { opacity: 0, transform: `scale(${scales.commit})` },
        { opacity: 1, transform: 'none' },
      ];
  return plan('commit', motionMs('commit', 'base', context), motions.commit.curve, keyframes);
}

/** A ghost row leaving a list: translateX 28 px and fade. */
export function carryPlan(kind: CommitKind, context: TriageContext = {}): MotionPlan | null {
  const keyframes = context.reduced
    ? fadeOut()
    : [
        { transform: 'none', opacity: 1 },
        { transform: `translateX(${directionOf(kind) * moves.carry}px)`, opacity: 0 },
      ];
  return plan('carry', motionMs('carry', 'base', context), motions.carry.curve, keyframes);
}

/** A ghost letter on commit: (96, -12) px and 2 degrees for Done, mirrored for Later, fading from 40 %. */
export function flightPlan(kind: CommitKind, context: TriageContext = {}): MotionPlan | null {
  if (context.burst && !context.reduced) return carryPlan(kind, { ...context, rapid: true });
  const direction = directionOf(kind);
  const keyframes = context.reduced
    ? fadeOut()
    : [
        { offset: 0, transform: 'none', opacity: 1 },
        {
          offset: FLIGHT_FADE_FROM,
          transform: flightTransform(
            direction,
            direction * moves.flightX * FLIGHT_FADE_FROM,
            FLIGHT_FADE_FROM,
          ),
          opacity: 1,
        },
        {
          offset: 1,
          transform: flightTransform(direction, direction * moves.flightX, 1),
          opacity: 0,
        },
      ];
  return plan('flight', motionMs('flight', 'base', context), motions.flight.curve, keyframes);
}

/** The departure for a surface: letters fly, rows are carried. */
export function departurePlan(
  kind: CommitKind,
  surface: Surface,
  context: TriageContext = {},
): MotionPlan | null {
  return surface === 'letter' ? flightPlan(kind, context) : carryPlan(kind, context);
}

/** The next letter's content dealt into the fixed Home slot: opacity and a 6 px rise. 0 when rapid or reduced. */
export function dealPlan(context: TriageContext = {}): MotionPlan | null {
  return plan('deal', motionMs('deal', 'base', context), motions.deal.curve, [
    { opacity: 0, transform: `translateY(${moves.deal}px)` },
    { opacity: 1, transform: 'none' },
  ]);
}

/**
 * A released swipe continuing into flight from where it is drawn (`x`, px) at its release
 * velocity (`velocity`, px/ms). Sampled from constant acceleration so the first segment moves at
 * the release speed and the letter still accelerates away, as `ease.carry` does; the samples are
 * joined linearly.
 */
export function handoffFlightPlan(
  kind: CommitKind,
  x: number,
  velocity: number,
  context: TriageContext = {},
): MotionPlan | null {
  const duration = motionMs('flight', 'base', context);
  if (duration <= 0) return null;
  if (context.reduced) {
    return plan('flight', duration, motions.flight.curve, fadeOut(`translateX(${x}px)`));
  }
  const direction = directionOf(kind);
  // Signed, so a letter still drifting back at release turns around without a velocity jump.
  const speed = velocity * direction;
  const distance = Math.max(moves.flightX, speed * duration);
  const accel = (2 * (distance - speed * duration)) / (duration * duration);
  const keyframes: MotionFrame[] = [];
  for (let step = 0; step <= HANDOFF_STEPS; step++) {
    const offset = step / HANDOFF_STEPS;
    const elapsed = offset * duration;
    const travelled = speed * elapsed + 0.5 * accel * elapsed * elapsed;
    const opacity =
      offset <= FLIGHT_FADE_FROM ? 1 : 1 - (offset - FLIGHT_FADE_FROM) / (1 - FLIGHT_FADE_FROM);
    keyframes.push({
      offset,
      transform: flightTransform(
        direction,
        x + direction * travelled,
        Math.max(0, travelled / distance),
      ),
      opacity,
    });
  }
  return plan('flight', duration, easings.linear.css, keyframes);
}
