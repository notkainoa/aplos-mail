import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createSpring,
  retargetSpring,
  settleTime,
  springAtRest,
  springSamples,
  stepSpring,
} from './spring.mjs';
import { GENERATED_DIR } from './tokens-lib.mjs';

// DESIGN 4.8, verbatim.
const DESIGN = {
  slide: {
    k: 600,
    d: 42,
    ms: 270,
    curve: [
      0, 0.059, 0.189, 0.343, 0.492, 0.624, 0.732, 0.816, 0.88, 0.925, 0.957, 0.978, 0.991, 0.999,
      1.003, 1.005, 1.005, 1,
    ],
  },
  snap: {
    k: 420,
    d: 36,
    ms: 250,
    curve: [
      0, 0.038, 0.126, 0.239, 0.358, 0.473, 0.577, 0.668, 0.745, 0.808, 0.858, 0.898, 0.928, 0.951,
      0.968, 0.981, 0.989, 1,
    ],
  },
  lift: {
    k: 500,
    d: 40,
    ms: 240,
    curve: [
      0, 0.041, 0.137, 0.257, 0.381, 0.498, 0.603, 0.692, 0.766, 0.826, 0.873, 0.91, 0.937, 0.958,
      0.972, 0.983, 0.99, 1,
    ],
  },
  follow: {
    k: 700,
    d: 48,
    ms: 210,
    curve: [
      0, 0.044, 0.146, 0.271, 0.399, 0.518, 0.622, 0.71, 0.782, 0.839, 0.884, 0.918, 0.943, 0.961,
      0.975, 0.984, 0.991, 1,
    ],
  },
  thumb: {
    k: 500,
    d: 30,
    ms: 310,
    curve: [
      0, 0.067, 0.221, 0.407, 0.588, 0.745, 0.868, 0.955, 1.012, 1.044, 1.057, 1.057, 1.051, 1.041,
      1.03, 1.02, 1.011, 1,
    ],
  },
};

function params(spec) {
  return { stiffness: spec.k, damping: spec.d, mass: 1 };
}

test("springs reproduce DESIGN 4.8's linear() curves within 0.002 per sample", () => {
  for (const [name, spec] of Object.entries(DESIGN)) {
    const samples = springSamples(params(spec));
    assert.equal(samples.length, 18);
    samples.forEach((s, i) => {
      assert.ok(
        Math.abs(s - spec.curve[i]) <= 0.002,
        `${name} sample ${i}: ${s.toFixed(4)} vs ${spec.curve[i]}`,
      );
    });
  }
});

test('settle times match DESIGN 4.8, which rounds the exact 0.5 % settle to 10 ms', () => {
  const exact = { slide: 265.5, snap: 248.3, lift: 240.2, follow: 211.9, thumb: 306.0 };
  for (const [name, spec] of Object.entries(DESIGN)) {
    const ms = settleTime(params(spec)) * 1000;
    assert.ok(Math.abs(ms - exact[name]) < 0.1, `${name} settles at ${ms.toFixed(2)} ms`);
    assert.equal(Math.round(ms / 10) * 10, spec.ms, `${name} rounds to DESIGN's ${spec.ms} ms`);
    assert.ok(Math.abs(ms - spec.ms) <= 5, `${name} within 5 ms of DESIGN`);
  }
});

// Fine-step RK4 as an independent reference for every damping regime.
function rk4(p, state, dt, steps = 2000) {
  let { value: x, velocity: v } = state;
  const h = dt / steps;
  const acc = (xx, vv) => (-p.stiffness * (xx - state.target) - p.damping * vv) / p.mass;
  for (let i = 0; i < steps; i++) {
    const k1x = v;
    const k1v = acc(x, v);
    const k2x = v + (h / 2) * k1v;
    const k2v = acc(x + (h / 2) * k1x, v + (h / 2) * k1v);
    const k3x = v + (h / 2) * k2v;
    const k3v = acc(x + (h / 2) * k2x, v + (h / 2) * k2v);
    const k4x = v + h * k3v;
    const k4v = acc(x + h * k3x, v + h * k3v);
    x += (h / 6) * (k1x + 2 * k2x + 2 * k3x + k4x);
    v += (h / 6) * (k1v + 2 * k2v + 2 * k3v + k4v);
  }
  return { value: x, velocity: v };
}

test('the analytic step agrees with RK4 when under-, critically and over-damped', () => {
  const cases = [
    { stiffness: 600, damping: 42, mass: 1 },
    { stiffness: 400, damping: 40, mass: 1 },
    { stiffness: 300, damping: 60, mass: 1.5 },
  ];
  const start = { value: 0.3, velocity: -4, target: 1 };
  for (const p of cases) {
    for (const dt of [0.016, 0.1, 0.4]) {
      const exact = stepSpring(p, start, dt);
      const ref = rk4(p, start, dt);
      assert.ok(
        Math.abs(exact.value - ref.value) < 1e-6,
        `value k=${p.stiffness} d=${p.damping} dt=${dt}`,
      );
      assert.ok(
        Math.abs(exact.velocity - ref.velocity) < 1e-4,
        `velocity k=${p.stiffness} d=${p.damping} dt=${dt}`,
      );
    }
  }
});

test('retargeting at random moments keeps value and velocity continuous', () => {
  let seed = 7;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const p = { stiffness: 600, damping: 42, mass: 1 };
  for (let run = 0; run < 200; run++) {
    let state = { value: random() * 2 - 1, velocity: random() * 20 - 10, target: random() };
    state = stepSpring(p, state, random() * 0.3);
    const moved = retargetSpring(state, random() * 4 - 2);
    assert.equal(moved.value, state.value);
    assert.equal(moved.velocity, state.velocity);
    const a = stepSpring(p, moved, 0.001);
    assert.ok(Math.abs(a.value - moved.value) < 0.05, 'no jump in the frame after a retarget');
    const split = stepSpring(p, stepSpring(p, moved, 0.05), 0.07);
    const whole = stepSpring(p, moved, 0.12);
    assert.ok(Math.abs(split.value - whole.value) < 1e-9);
    assert.ok(Math.abs(split.velocity - whole.velocity) < 1e-7);
  }
});

test('the TypeScript twin in generated/motion.ts matches spring.mjs', async () => {
  const motion = await import(pathToFileURL(join(GENERATED_DIR, 'motion.ts')).href);
  const p = { stiffness: 500, damping: 30, mass: 1 };
  const state = { value: -0.4, velocity: 3, target: 0.8 };
  for (const dt of [0, 0.008, 0.05, 0.3]) {
    assert.deepEqual(motion.stepSpring(p, state, dt), stepSpring(p, state, dt));
  }
  for (const [name, spec] of Object.entries(DESIGN)) {
    assert.equal(motion.springs[name].settleMs, Math.round(settleTime(params(spec)) * 10000) / 10);
  }
});

// Steps at 120 Hz until springAtRest; returns [ms, state].
function runToRest(p, state) {
  let s = state;
  let t = 0;
  while (!springAtRest(s) && t < 5) {
    s = stepSpring(p, s, 1 / 120);
    t += 1 / 120;
  }
  return [t * 1000, s];
}

test('springAtRest is relative to the travel, so small and large moves stop alike', () => {
  const lift = { stiffness: 500, damping: 40, mass: 1 };
  const [smallMs, small] = runToRest(lift, createSpring(1, 1.02));
  const [largeMs, large] = runToRest(lift, createSpring(0, 300));
  assert.ok(Math.abs(smallMs - largeMs) < 1, `${smallMs} vs ${largeMs}`);
  assert.ok(
    Math.abs(small.target - small.value) <= 0.005 * 0.02,
    'never stops early on a small travel',
  );
  assert.ok(Math.abs(large.target - large.value) <= 0.005 * 300);
  const settle = settleTime(lift) * 1000;
  assert.ok(
    smallMs >= settle - 9 && smallMs <= settle + 60,
    `rests at ${smallMs} ms against a ${settle} ms settle`,
  );
});

test('a retarget measures rest against the new remaining distance', () => {
  const p = { stiffness: 600, damping: 42, mass: 1 };
  const moving = stepSpring(p, createSpring(0, 300), 0.1);
  const moved = retargetSpring(moving, moving.value + 10);
  assert.equal(moved.travel, 10);
  assert.equal(
    retargetSpring(moved, moved.value).travel,
    10,
    'keeps the old travel when the new distance is 0',
  );
  const [, rest] = runToRest(p, moved);
  assert.ok(Math.abs(rest.target - rest.value) <= 0.05);
});
