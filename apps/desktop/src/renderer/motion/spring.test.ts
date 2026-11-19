import assert from 'node:assert/strict';
import { test } from 'node:test';
import { springs, stepSpring, type SpringName, type SpringState } from '../ui/generated/motion';
import { FakeEnv, seeded } from './fakes';
import { createScheduler } from './scheduler';
import { createSpringMotion } from './spring';

const NAMES = Object.keys(springs) as SpringName[];

test('retarget keeps value and velocity: fuzz over random times, targets and velocities', () => {
  const random = seeded(7);
  for (let run = 0; run < 60; run++) {
    const fake = new FakeEnv();
    const scheduler = createScheduler(fake.env);
    const name = NAMES[Math.floor(random() * NAMES.length)] ?? 'follow';
    const params = springs[name];
    const from = (random() - 0.5) * 600;
    const to = (random() - 0.5) * 600;
    const velocity = (random() - 0.5) * 10_000;
    const drawn: number[] = [];
    const spring = createSpringMotion(scheduler, {
      spring: name,
      from,
      to,
      velocity,
      onUpdate: value => drawn.push(value),
    });
    let reference: SpringState = { value: from, velocity, target: to };
    let referenceAt = fake.now;

    for (let step = 0; step < 40; step++) {
      fake.advance(random() * 60);
      if (spring.running) {
        reference = stepSpring(params, reference, (fake.now - referenceAt) / 1000);
        const scale = Math.max(1, Math.abs(reference.value), Math.abs(reference.velocity));
        assert.ok(Math.abs(spring.value - reference.value) < 1e-6 * scale, `run ${run} value`);
        assert.ok(
          Math.abs(spring.velocity - reference.velocity) < 1e-6 * scale,
          `run ${run} velocity`,
        );
      } else {
        reference = { value: spring.value, velocity: 0, target: spring.target };
      }
      referenceAt = fake.now;
      if (random() < 0.5) {
        const value = spring.value;
        const speed = spring.velocity;
        spring.retarget((random() - 0.5) * 600);
        assert.equal(spring.value, value);
        assert.equal(spring.velocity, speed);
        reference = { ...reference, target: spring.target };
      }
    }
    fake.advance(3000);
    assert.equal(spring.running, false);
    assert.equal(spring.value, spring.target);
    assert.equal(scheduler.pending, 0);
    assert.ok(drawn.length > 0);
  }
});

test('pointercancel stops the spring where it is drawn', () => {
  const fake = new FakeEnv();
  const scheduler = createScheduler(fake.env);
  const target = fake.element();
  const spring = createSpringMotion(scheduler, { spring: 'follow', from: 0, to: 200 });
  spring.stopOn(target.el);
  fake.advance(50);
  const at = spring.value;
  target.dispatch('pointercancel');
  assert.equal(spring.running, false);
  assert.equal(spring.velocity, 0);
  fake.advance(500);
  assert.equal(spring.value, at);
  assert.equal(scheduler.pending, 0);
});

test('a hidden window pauses the spring and it resumes where it was', () => {
  const fake = new FakeEnv();
  const scheduler = createScheduler(fake.env);
  const spring = createSpringMotion(scheduler, { spring: 'snap', from: 0, to: 100 });
  fake.advance(40);
  const before = spring.value;
  const speed = spring.velocity;
  fake.setHidden(true);
  fake.advance(2000);
  assert.equal(spring.value, before);
  assert.equal(spring.velocity, speed);
  assert.equal(fake.pendingFrames(), 0);
  fake.setHidden(false);
  fake.advance(20);
  assert.ok(spring.value > before);
  fake.advance(1000);
  assert.equal(spring.value, 100);
});

test('the spring settles within its generated settle time', () => {
  const fake = new FakeEnv();
  const scheduler = createScheduler(fake.env);
  let restedAt = -1;
  createSpringMotion(scheduler, {
    spring: 'slide',
    from: 0,
    to: 1,
    onRest: () => (restedAt = fake.now),
  });
  fake.advance(1000);
  assert.ok(restedAt > 0 && restedAt <= springs.slide.settleMs + 2 * (1000 / 60), `${restedAt}`);
});
