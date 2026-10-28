// Spring solver, TypeScript twin of scripts/design/spring.mjs.
// Analytic, so any frame time is exact. State keeps value and velocity, and
// retargetSpring() moves the target without a jump, so motion can be
// interrupted mid-flight.

export interface SpringParams {
  readonly stiffness: number;
  readonly damping: number;
  readonly mass: number;
}

export interface SpringState {
  readonly value: number;
  readonly velocity: number;
  readonly target: number;
  // Distance the motion covers; springAtRest() is relative to it. Treated as 1
  // (a unit spring) when absent.
  readonly travel?: number;
}

export const SETTLE_EPSILON = 0.005;
export const LINEAR_SAMPLES = 18;

export function dampingRatio(params: SpringParams): number {
  return params.damping / (2 * Math.sqrt(params.stiffness * params.mass));
}

// Advance a spring by dt seconds. Returns a new state.
export function stepSpring(params: SpringParams, state: SpringState, dt: number): SpringState {
  const omega = Math.sqrt(params.stiffness / params.mass);
  const zeta = dampingRatio(params);
  const y0 = state.value - state.target;
  const v0 = state.velocity;
  let y: number;
  let v: number;
  if (zeta < 1) {
    const wd = omega * Math.sqrt(1 - zeta * zeta);
    const decay = Math.exp(-zeta * omega * dt);
    const b = (v0 + zeta * omega * y0) / wd;
    const cos = Math.cos(wd * dt);
    const sin = Math.sin(wd * dt);
    y = decay * (y0 * cos + b * sin);
    v = decay * ((b * wd - zeta * omega * y0) * cos - (y0 * wd + zeta * omega * b) * sin);
  } else if (zeta === 1) {
    const decay = Math.exp(-omega * dt);
    const b = v0 + omega * y0;
    y = decay * (y0 + b * dt);
    v = decay * (b - omega * (y0 + b * dt));
  } else {
    const root = omega * Math.sqrt(zeta * zeta - 1);
    const r1 = -zeta * omega + root;
    const r2 = -zeta * omega - root;
    const c2 = (v0 - r1 * y0) / (r2 - r1);
    const c1 = y0 - c2;
    y = c1 * Math.exp(r1 * dt) + c2 * Math.exp(r2 * dt);
    v = c1 * r1 * Math.exp(r1 * dt) + c2 * r2 * Math.exp(r2 * dt);
  }
  return { ...state, value: state.target + y, velocity: v };
}

// A spring at rest at `from`, heading for `to`.
export function createSpring(from: number, to: number): SpringState {
  return { value: from, velocity: 0, target: to, travel: Math.abs(to - from) };
}

// Move the target; value and velocity carry over so motion stays continuous.
// The travel becomes the remaining distance (kept from before when that is 0).
export function retargetSpring(state: SpringState, target: number): SpringState {
  const distance = Math.abs(target - state.value);
  return {
    value: state.value,
    velocity: state.velocity,
    target,
    travel: distance > 0 ? distance : travelOf(state),
  };
}

function travelOf(state: SpringState): number {
  return state.travel ?? 1;
}

// True once the spring is within epsilon of its target and nearly still, both
// relative to its travel: |value - target| <= epsilon * travel and
// |velocity| <= 10 * epsilon * travel per second. So a 1 -> 1.02 scale and a
// 0 -> 300 px move both stop at 0.5 % of their travel, never early.
export function springAtRest(state: SpringState, epsilon: number = SETTLE_EPSILON): boolean {
  const tolerance = epsilon * travelOf(state);
  return (
    Math.abs(state.value - state.target) <= tolerance && Math.abs(state.velocity) <= tolerance * 10
  );
}

export function springProgress(params: SpringParams, t: number): number {
  return stepSpring(params, { value: 0, velocity: 0, target: 1 }, t).value;
}

// Seconds until a unit spring stays within epsilon of 1 for good.
export function settleTime(params: SpringParams, epsilon: number = SETTLE_EPSILON): number {
  const step = 1e-4;
  const horizon = 10;
  let last = 0;
  for (let t = 0; t <= horizon; t += step) {
    if (Math.abs(springProgress(params, t) - 1) >= epsilon) {
      last = t;
    }
  }
  let lo = last;
  let hi = last + step;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (Math.abs(springProgress(params, mid) - 1) >= epsilon) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return hi;
}

export function springSamples(
  params: SpringParams,
  count: number = LINEAR_SAMPLES,
  epsilon: number = SETTLE_EPSILON,
): number[] {
  const settle = settleTime(params, epsilon);
  const samples: number[] = [];
  for (let i = 0; i < count; i++) {
    samples.push(i === count - 1 ? 1 : springProgress(params, (i / (count - 1)) * settle));
  }
  return samples;
}

export function springLinear(
  params: SpringParams,
  count: number = LINEAR_SAMPLES,
  epsilon: number = SETTLE_EPSILON,
): string {
  const parts = springSamples(params, count, epsilon).map(s => String(Number(s.toFixed(3))));
  return `linear(${parts.join(', ')})`;
}
