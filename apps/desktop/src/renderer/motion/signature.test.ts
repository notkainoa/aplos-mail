import assert from 'node:assert/strict';
import { test } from 'node:test';
import { easings, motionMs, motions, moves, scales } from '../ui/generated/motion';
import { animatedProperties, play, type MotionPlan } from './animate';
import { closePlan } from './flip';
import { FakeEnv } from './fakes';
import {
  carryPlan,
  commitChipPlan,
  commitEdgePlan,
  dealPlan,
  flightPlan,
  handoffFlightPlan,
  type TriageContext,
} from './signature';
import { armPulsePlan } from './swipe';

const CONTEXTS: Record<string, TriageContext> = {
  normal: {},
  rapid: { rapid: true },
  burst: { rapid: true, burst: true },
  reduced: { reduced: true },
};

function every(context: TriageContext): (MotionPlan | null)[] {
  return [
    commitEdgePlan(context),
    commitChipPlan(context),
    carryPlan('done', context),
    carryPlan('later', context),
    flightPlan('done', context),
    flightPlan('later', context),
    flightPlan('trash', context),
    dealPlan(context),
    closePlan(40, context),
    handoffFlightPlan('done', 30, 0.8, context),
    armPulsePlan(context),
  ];
}

const parse = (transform: string) => {
  const t = /translate\(([-\d.e]+)px, ([-\d.e]+)px\) rotate\(([-\d.e]+)deg\)/.exec(transform);
  assert.ok(t, `not a flight transform: ${transform}`);
  return { x: Number(t[1]), y: Number(t[2]), r: Number(t[3]) };
};

test('every plan animates only transform and opacity', () => {
  for (const [name, context] of Object.entries(CONTEXTS)) {
    for (const plan of every(context)) {
      if (!plan) continue;
      for (const prop of animatedProperties(plan.keyframes)) {
        assert.ok(prop === 'transform' || prop === 'opacity', `${name} ${plan.motion}: ${prop}`);
      }
    }
  }
});

test('durations and curves are the generated ones for the named motion', () => {
  const known = new Set<string>([
    ...Object.values(easings).map(e => e.css),
    ...Object.values(motions).flatMap(m => (m.curve ? [m.curve] : [])),
  ]);
  for (const context of Object.values(CONTEXTS)) {
    for (const plan of every(context)) {
      if (!plan) continue;
      assert.ok(known.has(plan.easing), `${plan.motion} easing ${plan.easing}`);
      const spec = motions[plan.motion];
      const values: number[] = [
        ...Object.values(spec.durations),
        ...Object.values(spec.rapid),
        ...Object.values(spec.reduced),
      ];
      assert.ok(values.includes(plan.duration), `${plan.motion} duration ${plan.duration}`);
    }
  }
  assert.equal(flightPlan('done')?.duration, motionMs('flight', 'base'));
  assert.equal(flightPlan('done')?.easing, motions.flight.curve);
  assert.equal(carryPlan('done')?.easing, motions.carry.curve);
  assert.equal(commitEdgePlan()?.duration, motionMs('commit', 'base'));
});

test('Done flies right and up with a 2 degree tilt; Later flies left and down', () => {
  const done = flightPlan('done');
  const later = flightPlan('later');
  assert.ok(done && later);
  const doneEnd = parse(String(done.keyframes.at(-1)?.transform));
  const laterEnd = parse(String(later.keyframes.at(-1)?.transform));
  assert.deepEqual(doneEnd, { x: moves.flightX, y: -moves.flightY, r: moves.flightRotate });
  assert.deepEqual(laterEnd, { x: -moves.flightX, y: moves.flightY, r: -moves.flightRotate });
  assert.equal(parse(String(flightPlan('trash')?.keyframes.at(-1)?.transform)).x, moves.flightX);
  const fadeStart = done.keyframes.find(k => k.offset === 0.4);
  assert.equal(fadeStart?.opacity, 1);
  assert.equal(done.keyframes.at(-1)?.opacity, 0);
});

test('commit edge grows scaleY from 0 and the chip scales from .9', () => {
  assert.equal(commitEdgePlan()?.keyframes[0]?.transform, `scaleY(${scales.commitEdge})`);
  assert.equal(commitChipPlan()?.keyframes[0]?.transform, `scale(${scales.commit})`);
  assert.equal(commitEdgePlan({ rapid: true })?.duration, motions.commit.rapid.base);
});

test('rapid halves; from the burst key flight becomes the rapid carry', () => {
  assert.equal(flightPlan('done', { rapid: true })?.duration, motions.flight.durations.base / 2);
  assert.equal(carryPlan('done', { rapid: true })?.duration, motions.carry.durations.base / 2);
  const burst = flightPlan('later', { burst: true });
  assert.equal(burst?.motion, 'carry');
  assert.equal(burst?.duration, motions.carry.rapid.base);
  assert.equal(burst?.keyframes.at(-1)?.transform, `translateX(${-moves.carry}px)`);
  assert.equal(dealPlan({ rapid: true }), null);
});

test('reduced motion turns flight and carry into a short fade and drops deal and close', () => {
  for (const plan of [
    flightPlan('done', { reduced: true }),
    flightPlan('done', { reduced: true, burst: true }),
    carryPlan('later', { reduced: true }),
    handoffFlightPlan('later', -40, -1, { reduced: true }),
  ]) {
    assert.ok(plan);
    assert.ok(
      plan.keyframes.every(
        k => k.transform === undefined || k.transform === plan.keyframes[0]?.transform,
      ),
    );
    assert.deepEqual(
      plan.keyframes.map(k => k.opacity),
      [1, 0],
    );
  }
  assert.equal(flightPlan('done', { reduced: true })?.duration, motions.flight.reduced.base);
  assert.equal(carryPlan('done', { reduced: true })?.duration, motions.carry.reduced.base);
  assert.deepEqual(animatedProperties(commitChipPlan({ reduced: true })?.keyframes ?? []), [
    'opacity',
  ]);
  assert.equal(dealPlan({ reduced: true }), null);
  assert.equal(closePlan(40, { reduced: true }), null);
  assert.equal(armPulsePlan({ reduced: true }), null);
});

test('the swipe hand-off starts at the drawn offset and the release speed', () => {
  for (const velocity of [0, 0.3, 0.8, 2.5]) {
    const plan = handoffFlightPlan('done', 50, velocity);
    assert.ok(plan);
    const first = parse(String(plan.keyframes[0]?.transform));
    const second = parse(String(plan.keyframes[1]?.transform));
    assert.equal(first.x, 50);
    const dt = Number(plan.keyframes[1]?.offset) * plan.duration;
    const speed = (second.x - first.x) / dt;
    const end = parse(String(plan.keyframes.at(-1)?.transform));
    assert.ok(end.x - 50 >= moves.flightX - 1e-9);
    // First-segment speed is the release speed plus the small acceleration term.
    const accel = (2 * (end.x - 50 - velocity * plan.duration)) / plan.duration ** 2;
    assert.ok(Math.abs(speed - (velocity + 0.5 * accel * dt)) < 1e-9);
    assert.ok(Math.abs(end.r - moves.flightRotate) < 1e-9);
  }
  const later = handoffFlightPlan('later', -50, -1.2);
  assert.ok(parse(String(later?.keyframes.at(-1)?.transform)).x < -50 - moves.flightX + 1e-9);
});

test('play refuses layout properties and clears will-change when it ends', () => {
  const fake = new FakeEnv();
  const el = fake.element();
  assert.throws(() =>
    play(el.el, {
      motion: 'close',
      duration: motionMs('close', 'base'),
      easing: motions.close.curve,
      keyframes: [{ height: '0px' }, { height: '40px' }],
    }),
  );
  const plan = carryPlan('done');
  assert.ok(plan);
  play(el.el, plan);
  assert.equal(el.style.willChange, 'transform, opacity');
  fake.advance(plan.duration);
  assert.equal(el.style.willChange, '');
  assert.equal(fake.running().length, 0);
});
