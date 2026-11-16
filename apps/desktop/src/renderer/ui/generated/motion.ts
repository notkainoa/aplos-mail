// Generated from tokens.json by scripts/design/build-tokens.mjs. Do not edit.
// Paper motion tokens (plans/DESIGN.md section 4.8) and stacking layers.
// Durations are in ms, moves in px (flightRotate in deg): the runtime needs
// pixel travel even though CSS sizes are in rem. The spring solver below is
// inlined from scripts/design/spring-runtime.ts.

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

export type ReducedMode = 'none' | 'opacity' | 'colour' | 'static' | 'same';

export interface Easing {
  readonly css: string;
  readonly points: readonly [number, number, number, number];
}

export interface SpringToken extends SpringParams {
  readonly dampingRatio: number;
  readonly settleMs: number;
  readonly linear: string;
}

export interface MotionSpec {
  readonly durations: Readonly<Record<string, number>>;
  readonly rapid: Readonly<Record<string, number>>;
  // During rapid triage the motion must not start until hold ends (arrive).
  readonly deferWhenRapid: boolean;
  readonly reduced: Readonly<Record<string, number>>;
  readonly reducedMode: ReducedMode;
  readonly curve: string | null;
  readonly curveName: string | null;
  readonly curveOut?: string;
  readonly curveOutName?: string;
}

export const easings = {
  out: {
    css: 'cubic-bezier(0.16, 1, 0.3, 1)',
    points: [0.16, 1, 0.3, 1],
  },
  std: {
    css: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
    points: [0.2, 0.8, 0.2, 1],
  },
  in: {
    css: 'cubic-bezier(0.5, 0, 0.75, 0)',
    points: [0.5, 0, 0.75, 0],
  },
  carry: {
    css: 'cubic-bezier(0.4, 0, 1, 1)',
    points: [0.4, 0, 1, 1],
  },
  inout: {
    css: 'cubic-bezier(0.65, 0, 0.35, 1)',
    points: [0.65, 0, 0.35, 1],
  },
  linear: {
    css: 'linear',
    points: [0, 0, 1, 1],
  },
} as const satisfies Record<string, Easing>;

export type EasingName = keyof typeof easings;

export const springs = {
  slide: {
    stiffness: 600,
    damping: 42,
    mass: 1,
    dampingRatio: 0.857,
    settleMs: 265.5,
    linear:
      'linear(0, 0.059, 0.189, 0.343, 0.492, 0.624, 0.732, 0.816, 0.88, 0.925, 0.957, 0.978, 0.991, 0.999, 1.003, 1.005, 1.005, 1)',
  },
  snap: {
    stiffness: 420,
    damping: 36,
    mass: 1,
    dampingRatio: 0.878,
    settleMs: 248.3,
    linear:
      'linear(0, 0.038, 0.126, 0.239, 0.359, 0.474, 0.578, 0.669, 0.745, 0.808, 0.859, 0.898, 0.929, 0.952, 0.969, 0.981, 0.989, 1)',
  },
  lift: {
    stiffness: 500,
    damping: 40,
    mass: 1,
    dampingRatio: 0.894,
    settleMs: 240.2,
    linear:
      'linear(0, 0.041, 0.137, 0.257, 0.381, 0.499, 0.603, 0.693, 0.767, 0.827, 0.874, 0.91, 0.937, 0.958, 0.972, 0.983, 0.99, 1)',
  },
  follow: {
    stiffness: 700,
    damping: 48,
    mass: 1,
    dampingRatio: 0.907,
    settleMs: 211.9,
    linear:
      'linear(0, 0.045, 0.147, 0.272, 0.4, 0.519, 0.623, 0.711, 0.783, 0.84, 0.884, 0.918, 0.943, 0.962, 0.975, 0.984, 0.991, 1)',
  },
  thumb: {
    stiffness: 500,
    damping: 30,
    mass: 1,
    dampingRatio: 0.671,
    settleMs: 306,
    linear:
      'linear(0, 0.067, 0.222, 0.408, 0.589, 0.746, 0.868, 0.956, 1.013, 1.044, 1.057, 1.057, 1.051, 1.04, 1.029, 1.019, 1.011, 1)',
  },
} as const satisfies Record<string, SpringToken>;

export type SpringName = keyof typeof springs;

export const motions = {
  nav: {
    durations: { base: 0 },
    rapid: { base: 0 },
    deferWhenRapid: false,
    reduced: { base: 0 },
    reducedMode: 'none',
    curve: null,
    curveName: null,
  },
  press: {
    durations: { down: 80, up: 140 },
    rapid: { down: 80, up: 140 },
    deferWhenRapid: false,
    reduced: { down: 80, up: 140 },
    reducedMode: 'colour',
    curve: 'cubic-bezier(0.16, 1, 0.3, 1)',
    curveName: 'ease.out',
  },
  hover: {
    durations: { base: 100 },
    rapid: { base: 100 },
    deferWhenRapid: false,
    reduced: { base: 100 },
    reducedMode: 'same',
    curve: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
    curveName: 'ease.std',
  },
  cursor: {
    durations: { base: 120, focus: 160 },
    rapid: { base: 0, focus: 0 },
    deferWhenRapid: false,
    reduced: { base: 0, focus: 0 },
    reducedMode: 'none',
    curve: 'cubic-bezier(0.16, 1, 0.3, 1)',
    curveName: 'ease.out',
  },
  reveal: {
    durations: { in: 140, out: 100 },
    rapid: { in: 140, out: 100 },
    deferWhenRapid: false,
    reduced: { in: 100, out: 100 },
    reducedMode: 'opacity',
    curve: 'cubic-bezier(0.16, 1, 0.3, 1)',
    curveName: 'ease.out',
    curveOut: 'cubic-bezier(0.5, 0, 0.75, 0)',
    curveOutName: 'ease.in',
  },
  settle: {
    durations: { in: 180, out: 120 },
    rapid: { in: 180, out: 120 },
    deferWhenRapid: false,
    reduced: { in: 120, out: 120 },
    reducedMode: 'opacity',
    curve: 'cubic-bezier(0.16, 1, 0.3, 1)',
    curveName: 'ease.out',
    curveOut: 'cubic-bezier(0.5, 0, 0.75, 0)',
    curveOutName: 'ease.in',
  },
  slide: {
    durations: { base: 270 },
    rapid: { base: 270 },
    deferWhenRapid: false,
    reduced: { base: 0 },
    reducedMode: 'none',
    curve:
      'linear(0, 0.059, 0.189, 0.343, 0.492, 0.624, 0.732, 0.816, 0.88, 0.925, 0.957, 0.978, 0.991, 0.999, 1.003, 1.005, 1.005, 1)',
    curveName: 'spring.slide',
  },
  commit: {
    durations: { base: 60 },
    rapid: { base: 30 },
    deferWhenRapid: false,
    reduced: { base: 60 },
    reducedMode: 'opacity',
    curve: 'cubic-bezier(0.16, 1, 0.3, 1)',
    curveName: 'ease.out',
  },
  carry: {
    durations: { base: 120 },
    rapid: { base: 60 },
    deferWhenRapid: false,
    reduced: { base: 80 },
    reducedMode: 'opacity',
    curve: 'cubic-bezier(0.4, 0, 1, 1)',
    curveName: 'ease.carry',
  },
  flight: {
    durations: { base: 220 },
    rapid: { base: 110 },
    deferWhenRapid: false,
    reduced: { base: 120 },
    reducedMode: 'opacity',
    curve: 'cubic-bezier(0.4, 0, 1, 1)',
    curveName: 'ease.carry',
  },
  deal: {
    durations: { base: 140 },
    rapid: { base: 0 },
    deferWhenRapid: false,
    reduced: { base: 0 },
    reducedMode: 'none',
    curve: 'cubic-bezier(0.16, 1, 0.3, 1)',
    curveName: 'ease.out',
  },
  hold: {
    durations: { base: 450, cap: 1200, all: 600 },
    rapid: { base: 450, cap: 1200, all: 600 },
    deferWhenRapid: false,
    reduced: { base: 450, cap: 1200, all: 600 },
    reducedMode: 'same',
    curve: null,
    curveName: null,
  },
  close: {
    durations: { base: 180 },
    rapid: { base: 180 },
    deferWhenRapid: false,
    reduced: { base: 0 },
    reducedMode: 'none',
    curve: 'cubic-bezier(0.16, 1, 0.3, 1)',
    curveName: 'ease.out',
  },
  swap: {
    durations: { base: 120 },
    rapid: { base: 60 },
    deferWhenRapid: false,
    reduced: { base: 100 },
    reducedMode: 'opacity',
    curve: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
    curveName: 'ease.std',
  },
  arrive: {
    durations: { base: 200 },
    rapid: { base: 200 },
    deferWhenRapid: true,
    reduced: { base: 120 },
    reducedMode: 'opacity',
    curve: 'cubic-bezier(0.16, 1, 0.3, 1)',
    curveName: 'ease.out',
  },
  dock: {
    durations: { in: 200, out: 140 },
    rapid: { in: 200, out: 140 },
    deferWhenRapid: false,
    reduced: { in: 0, out: 0 },
    reducedMode: 'none',
    curve: 'cubic-bezier(0.16, 1, 0.3, 1)',
    curveName: 'ease.out',
    curveOut: 'cubic-bezier(0.5, 0, 0.75, 0)',
    curveOutName: 'ease.in',
  },
  'undo-send': {
    durations: { base: 8000 },
    rapid: { base: 8000 },
    deferWhenRapid: false,
    reduced: { base: 8000 },
    reducedMode: 'static',
    curve: 'linear',
    curveName: 'ease.linear',
  },
  lift: {
    durations: { base: 240 },
    rapid: { base: 240 },
    deferWhenRapid: false,
    reduced: { base: 0 },
    reducedMode: 'none',
    curve:
      'linear(0, 0.041, 0.137, 0.257, 0.381, 0.499, 0.603, 0.693, 0.767, 0.827, 0.874, 0.91, 0.937, 0.958, 0.972, 0.983, 0.99, 1)',
    curveName: 'spring.lift',
  },
  follow: {
    durations: { base: 210 },
    rapid: { base: 210 },
    deferWhenRapid: false,
    reduced: { base: 0 },
    reducedMode: 'none',
    curve:
      'linear(0, 0.045, 0.147, 0.272, 0.4, 0.519, 0.623, 0.711, 0.783, 0.84, 0.884, 0.918, 0.943, 0.962, 0.975, 0.984, 0.991, 1)',
    curveName: 'spring.follow',
  },
  snap: {
    durations: { base: 250 },
    rapid: { base: 250 },
    deferWhenRapid: false,
    reduced: { base: 0 },
    reducedMode: 'none',
    curve:
      'linear(0, 0.038, 0.126, 0.239, 0.359, 0.474, 0.578, 0.669, 0.745, 0.808, 0.859, 0.898, 0.929, 0.952, 0.969, 0.981, 0.989, 1)',
    curveName: 'spring.snap',
  },
  thumb: {
    durations: { base: 310 },
    rapid: { base: 310 },
    deferWhenRapid: false,
    reduced: { base: 0 },
    reducedMode: 'none',
    curve:
      'linear(0, 0.067, 0.222, 0.408, 0.589, 0.746, 0.868, 0.956, 1.013, 1.044, 1.057, 1.057, 1.051, 1.04, 1.029, 1.019, 1.011, 1)',
    curveName: 'spring.thumb',
  },
  breathe: {
    durations: { base: 1600 },
    rapid: { base: 1600 },
    deferWhenRapid: false,
    reduced: { base: 1600 },
    reducedMode: 'static',
    curve: 'cubic-bezier(0.65, 0, 0.35, 1)',
    curveName: 'ease.inout',
  },
  status: {
    durations: { base: 1500 },
    rapid: { base: 1500 },
    deferWhenRapid: false,
    reduced: { base: 1500 },
    reducedMode: 'static',
    curve: 'cubic-bezier(0.65, 0, 0.35, 1)',
    curveName: 'ease.inout',
  },
  count: {
    durations: { base: 140 },
    rapid: { base: 0 },
    deferWhenRapid: false,
    reduced: { base: 0 },
    reducedMode: 'none',
    curve: 'cubic-bezier(0.16, 1, 0.3, 1)',
    curveName: 'ease.out',
  },
} as const satisfies Record<string, MotionSpec>;

export type MotionName = keyof typeof motions;

export type MotionPhase<N extends MotionName> = keyof (typeof motions)[N]['durations'] & string;

export const moves = {
  reveal: 4,
  settle: 8,
  deal: 6,
  arrive: 6,
  swap: 12,
  carry: 28,
  dock: 24,
  count: 4,
  flightX: 96,
  flightY: 12,
  flightRotate: 2,
} as const;

export const scales = {
  press: 0.97,
  pressIcon: 0.94,
  reveal: 0.98,
  settle: 0.98,
  commit: 0.9,
  commitEdge: 0,
  lift: 1.02,
  snap: 1.08,
} as const;

export const breathe = { lo: 0.75, hi: 1, static: 0.85 } as const;

export const timing = {
  toast: 4000,
  toastUndo: 8000,
  toastFade: 400,
  revealGrace: 600,
  rapidGap: 300,
  burstWindow: 1000,
  spinnerDelay: 150,
  burstKeys: 4,
  themeSwitchFrames: 1,
} as const;

// Stacking layers (z-index), lowest to highest; the same values as the --z-* CSS
// variables. Use these only where a style is written from TS.
export const layers = {
  sticky: 10,
  dock: 20,
  menu: 30,
  toast: 40,
  dialog: 50,
  palette: 60,
  tooltip: 70,
} as const;

export type LayerName = keyof typeof layers;

// Timing values that change under reduced motion.
export const timingReduced = { toastFade: 120 } as const satisfies Partial<
  Record<keyof typeof timing, number>
>;

export const themeHooks = {
  theme: 'data-theme',
  contrast: 'data-contrast',
  motion: 'data-motion',
  switching: 'data-theme-switching',
  contrastQuery: '(prefers-contrast: more)',
  reducedMotionQuery: '(prefers-reduced-motion: reduce)',
} as const;

export interface MotionContext {
  readonly rapid?: boolean;
  readonly reduced?: boolean;
}

// True when a motion must wait for hold to end instead of playing now.
export function motionDeferred(name: MotionName, context: MotionContext = {}): boolean {
  const spec: MotionSpec = motions[name];
  return Boolean(context.rapid) && spec.deferWhenRapid;
}

// The duration of one phase of a named motion. Reduced wins over rapid. For a
// motion with deferWhenRapid, check motionDeferred() first.
export function motionMs<N extends MotionName>(
  name: N,
  phase: MotionPhase<N>,
  context: MotionContext = {},
): number {
  const spec: MotionSpec = motions[name];
  if (context.reduced) {
    return spec.reduced[phase];
  }
  if (context.rapid) {
    return spec.rapid[phase];
  }
  return spec.durations[phase];
}
