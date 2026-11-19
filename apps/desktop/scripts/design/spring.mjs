// Damped-spring solver for the Paper motion tokens (DESIGN 4.8).
// Springs are stiffness / damping / mass. The solver is analytic (exact for
// any step size), keeps value and velocity, and can be retargeted mid-flight.
// build-tokens.mjs inlines a TypeScript twin of these functions into
// generated/motion.ts; spring.test.mjs checks the two agree.

export const SETTLE_EPSILON = 0.005;
export const LINEAR_SAMPLES = 18;

export function dampingRatio({ stiffness, damping, mass }) {
  return damping / (2 * Math.sqrt(stiffness * mass));
}

// Advance a spring state { value, velocity, target, travel? } by dt seconds.
// Returns a new state; the input is not changed.
export function stepSpring(params, state, dt) {
  const { stiffness, mass } = params;
  const omega = Math.sqrt(stiffness / mass);
  const zeta = dampingRatio(params);
  const y0 = state.value - state.target;
  const v0 = state.velocity;
  let y;
  let v;
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

// A spring at rest at `from`, heading for `to`. `travel` is the distance the
// motion covers; springAtRest() measures its tolerance against it, so a
// 1 -> 1.02 scale and a 0 -> 300 px move both stop at 0.5 % of their travel.
export function createSpring(from, to) {
  return { value: from, velocity: 0, target: to, travel: Math.abs(to - from) };
}

// Move the target; value and velocity carry over so motion stays continuous.
// The travel becomes the remaining distance (kept from before when that is 0).
export function retargetSpring(state, target) {
  const distance = Math.abs(target - state.value);
  return {
    value: state.value,
    velocity: state.velocity,
    target,
    travel: distance > 0 ? distance : travelOf(state),
  };
}

// States made by hand without a travel are treated as unit springs (0 -> 1).
function travelOf(state) {
  return state.travel ?? 1;
}

// True once the spring is within epsilon of its target and nearly still, both
// relative to its travel: |value - target| <= epsilon * travel and
// |velocity| <= 10 * epsilon * travel per second. Never stops early, since the
// value tolerance is the same 0.5 % that defines the settle time.
export function springAtRest(state, epsilon = SETTLE_EPSILON) {
  const tolerance = epsilon * travelOf(state);
  return (
    Math.abs(state.value - state.target) <= tolerance && Math.abs(state.velocity) <= tolerance * 10
  );
}

// Value of a unit spring (0 -> 1 from rest) at time t seconds.
export function springProgress(params, t) {
  return stepSpring(params, { value: 0, velocity: 0, target: 1 }, t).value;
}

// Seconds until the unit spring stays within epsilon of 1 for good.
// Scans in 0.1 ms steps for the last excursion, then refines by bisection.
export function settleTime(params, epsilon = SETTLE_EPSILON) {
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

// Evenly spaced samples from t = 0 to the settle time; the last sample is
// pinned to 1 so a CSS animation ends exactly on its target.
export function springSamples(params, count = LINEAR_SAMPLES, epsilon = SETTLE_EPSILON) {
  const settle = settleTime(params, epsilon);
  const samples = [];
  for (let i = 0; i < count; i++) {
    samples.push(i === count - 1 ? 1 : springProgress(params, (i / (count - 1)) * settle));
  }
  return samples;
}

export function formatSample(value) {
  return String(Number(value.toFixed(3)));
}

export function springLinear(params, count = LINEAR_SAMPLES, epsilon = SETTLE_EPSILON) {
  return `linear(${springSamples(params, count, epsilon).map(formatSample).join(', ')})`;
}

export function compileSpring(params) {
  return {
    stiffness: params.stiffness,
    damping: params.damping,
    mass: params.mass,
    dampingRatio: Math.round(dampingRatio(params) * 1000) / 1000,
    settleMs: Math.round(settleTime(params) * 10000) / 10,
    linear: springLinear(params),
  };
}
