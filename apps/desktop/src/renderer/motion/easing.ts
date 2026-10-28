// Evaluates the generated curves in JS, so an interrupted WAAPI tween can
// restart from the value it is drawing right now. Only curves that motion.ts
// emits are known: the named cubic-beziers, the springs' linear() strings and
// plain linear.
import { easings, springSamples, springs } from '../ui/generated/motion';

export type Progress = (t: number) => number;

/** A cubic-bezier timing function from its four control points. */
export function cubicBezier(points: readonly [number, number, number, number]): Progress {
  const [x1, y1, x2, y2] = points;
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (s: number) => ((ax * s + bx) * s + cx) * s;
  const sampleY = (s: number) => ((ay * s + by) * s + cy) * s;
  const slopeX = (s: number) => (3 * ax * s + 2 * bx) * s + cx;

  function solve(x: number): number {
    let s = x;
    for (let i = 0; i < 8; i++) {
      const error = sampleX(s) - x;
      if (Math.abs(error) < 1e-7) return s;
      const slope = slopeX(s);
      if (Math.abs(slope) < 1e-6) break;
      s -= error / slope;
    }
    let lo = 0;
    let hi = 1;
    s = x;
    for (let i = 0; i < 40; i++) {
      const value = sampleX(s);
      if (Math.abs(value - x) < 1e-7) return s;
      if (value < x) lo = s;
      else hi = s;
      s = (lo + hi) / 2;
    }
    return s;
  }

  return t => (t <= 0 ? 0 : t >= 1 ? 1 : sampleY(solve(t)));
}

/** A CSS linear() curve from evenly spaced samples. */
export function piecewiseLinear(samples: readonly number[]): Progress {
  const last = samples.length - 1;
  return t => {
    if (t <= 0) return samples[0] ?? 0;
    if (t >= 1) return samples[last] ?? 1;
    const at = t * last;
    const i = Math.floor(at);
    const a = samples[i] ?? 0;
    const b = samples[i + 1] ?? a;
    return a + (b - a) * (at - i);
  };
}

const known = new Map<string, Progress>();
for (const easing of Object.values(easings)) known.set(easing.css, cubicBezier(easing.points));
for (const spring of Object.values(springs))
  known.set(spring.linear, piecewiseLinear(springSamples(spring)));
known.set(easings.linear.css, t => Math.min(1, Math.max(0, t)));

/** The timing function for a generated curve string; throws for anything motion.ts does not emit. */
export function progressOf(curve: string): Progress {
  const progress = known.get(curve);
  if (!progress) throw new Error(`Unknown curve ${curve}: curves come from ui/generated/motion.ts`);
  return progress;
}
