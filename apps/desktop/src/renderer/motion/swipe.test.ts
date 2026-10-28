import assert from 'node:assert/strict';
import { test } from 'node:test';
import { motions, moves } from '../ui/generated/motion';
import type { CommitKind } from '../ui/props';
import { FakeEnv } from './fakes';
import { createGhostLayer } from './ghost';
import { createScheduler } from './scheduler';
import { handoffFlightPlan } from './signature';
import { armedSide, createSwipe, SWIPE_DISTANCE, SWIPE_VELOCITY, type SwipeSide } from './swipe';

const WIDTH = 600;

function setup(options: { reduced?: boolean } = {}) {
  const fake = new FakeEnv(options);
  const scheduler = createScheduler(fake.env);
  const host = fake.element();
  const ghosts = createGhostLayer({ scheduler, host: host.el });
  const letter = fake.element({ left: 100, top: 100, width: WIDTH, height: 180 });
  const icon = fake.element();
  const arms: (SwipeSide | null)[] = [];
  const commits: CommitKind[] = [];
  const swipe = createSwipe({
    element: letter.el,
    width: WIDTH,
    kinds: { right: 'done', left: 'later' },
    scheduler,
    ghosts,
    iconOf: () => icon.el,
    onArm: side => arms.push(side),
    onCommit: kind => commits.push(kind),
  });
  return { fake, scheduler, host, ghosts, letter, icon, arms, commits, swipe };
}

/** Drags from 0 to `to` in `steps` moves `ms` apart. */
function drag(s: ReturnType<typeof setup>, to: number, steps: number, ms: number) {
  s.swipe.down(0);
  for (let i = 1; i <= steps; i++) {
    s.fake.advance(ms);
    s.swipe.move((to * i) / steps);
  }
}

test('armed side: 30 % of the width or 0.6 px/ms', () => {
  assert.equal(armedSide(SWIPE_DISTANCE * WIDTH - 1, 0, WIDTH), null);
  assert.equal(armedSide(SWIPE_DISTANCE * WIDTH, 0, WIDTH), 'right');
  assert.equal(armedSide(-SWIPE_DISTANCE * WIDTH, 0, WIDTH), 'left');
  assert.equal(armedSide(20, SWIPE_VELOCITY, WIDTH), null);
  assert.equal(armedSide(20, SWIPE_VELOCITY + 0.01, WIDTH), 'right');
  assert.equal(armedSide(20, -(SWIPE_VELOCITY + 0.01), WIDTH), null);
});

test('the letter follows the pointer; arming pulses the underlay icon', () => {
  const s = setup();
  drag(s, 0.29 * WIDTH, 20, 30);
  assert.equal(s.swipe.armed, null);
  s.fake.advance(300);
  assert.ok(Math.abs(s.swipe.offset - 0.29 * WIDTH) < 1);
  assert.match(s.letter.style.transform, /^translateX\(/);
  s.swipe.move(0.31 * WIDTH);
  assert.equal(s.swipe.armed, 'right');
  assert.deepEqual(s.arms, ['right']);
  const pulse = s.fake.running().find(a => a.target === s.icon);
  assert.equal(pulse?.options.duration, motions.snap.durations.base);
  assert.equal(pulse?.options.easing, motions.snap.curve);
});

test('release while armed hands off to a ghost from the drawn offset and velocity', () => {
  const s = setup();
  drag(s, 250, 10, 16);
  const drawn = s.swipe.offset;
  const velocity = s.swipe.velocity;
  assert.ok(velocity > 0);
  assert.equal(s.swipe.up(250), 'commit');
  assert.deepEqual(s.commits, ['done']);
  assert.equal(s.letter.isConnected, false);
  assert.equal(s.letter.style.transform, '');
  assert.equal(s.ghosts.active.length, 1);
  const flight = s.fake.running().find(a => a.target.el === s.ghosts.active[0]?.clone);
  assert.ok(flight);
  assert.deepEqual(flight.keyframes, handoffFlightPlan('done', drawn, velocity)?.keyframes);
  const xs = flight.keyframes.map(k =>
    Number(/translate\(([-\d.e]+)px/.exec(String(k.transform))?.[1]),
  );
  assert.ok(Math.abs(Number(xs[0]) - drawn) < 1e-9);
  const dt = Number(flight.keyframes[1]?.offset) * Number(flight.options.duration);
  assert.ok((Number(xs[1]) - Number(xs[0])) / dt >= velocity - 1e-9, 'the throw keeps its speed');
  assert.ok(Number(xs.at(-1)) - drawn >= moves.flightX - 1e-9);
  s.fake.advance(motions.flight.durations.base + 1);
  assert.equal(s.ghosts.active.length, 0);
  assert.equal(s.fake.running().length, 0);
});

test('a fast flick arms on velocity alone', () => {
  const s = setup();
  s.swipe.down(0);
  s.fake.advance(16);
  s.swipe.move(-40);
  s.fake.advance(16);
  s.swipe.move(-80);
  assert.equal(s.swipe.armed, 'left');
  assert.equal(s.swipe.up(-80), 'commit');
  assert.deepEqual(s.commits, ['later']);
});

test('below the threshold it springs back on snap and settles at rest', () => {
  const s = setup();
  drag(s, 100, 10, 30);
  s.fake.advance(200);
  assert.equal(s.swipe.up(100), 'snap');
  assert.equal(s.commits.length, 0);
  s.fake.advance(30);
  const mid = s.swipe.offset;
  assert.ok(mid > 0 && mid < 100);
  s.fake.advance(1000);
  assert.equal(s.swipe.offset, 0);
  assert.equal(s.letter.style.transform, '');
  assert.equal(s.swipe.active, false);
  assert.equal(s.scheduler.pending, 0);
});

test('a press during the spring-back picks the letter up where it is drawn', () => {
  const s = setup();
  drag(s, 120, 6, 30);
  s.fake.advance(200);
  s.swipe.up(120);
  s.fake.advance(40);
  const drawn = s.swipe.offset;
  s.swipe.down(500);
  assert.ok(Math.abs(s.swipe.offset - drawn) < 1e-9);
  s.swipe.move(500);
  s.fake.advance(400);
  assert.ok(Math.abs(s.swipe.offset - drawn) < 0.5);
});

test('pointercancel stops the springs and puts the letter back', () => {
  const s = setup();
  drag(s, 250, 5, 16);
  s.swipe.cancel();
  assert.equal(s.swipe.active, false);
  assert.equal(s.swipe.armed, null);
  assert.equal(s.letter.style.transform, '');
  assert.equal(s.scheduler.pending, 0);
});

test('reduced motion: follows at once, snaps back at once, releases into a fade', () => {
  const s = setup({ reduced: true });
  s.swipe.down(0);
  s.swipe.move(80);
  assert.equal(s.letter.style.transform, 'translateX(80px)');
  assert.equal(s.swipe.up(80), 'snap');
  assert.equal(s.letter.style.transform, '');
  s.swipe.down(0);
  s.swipe.move(-300);
  assert.equal(s.swipe.up(-300), 'commit');
  assert.deepEqual(s.commits, ['later']);
  const fade = s.fake.running().find(a => a.target.el === s.ghosts.active[0]?.clone);
  assert.equal(fade?.options.duration, motions.flight.reduced.base);
  assert.deepEqual(
    fade?.keyframes.map(k => k.opacity),
    [1, 0],
  );
  assert.equal(
    s.fake.running().some(a => a.target === s.icon),
    false,
  );
});

test('flick, pause, release: an arm won by speed lapses, so release springs back', () => {
  const s = setup();
  s.swipe.down(0);
  for (let x = 10; x <= 60; x += 10) {
    s.fake.advance(8);
    s.swipe.move(x);
  }
  assert.equal(s.swipe.armed, 'right');
  s.fake.advance(400);
  assert.equal(s.swipe.armed, null);
  assert.deepEqual(s.arms, ['right', null]);
  assert.equal(s.swipe.up(60), 'snap');
  assert.equal(s.commits.length, 0);
  s.fake.advance(1000);
  assert.equal(s.scheduler.pending, 0);
});

test('whatever the underlay shows at release is what release does', () => {
  for (let pause = 0; pause <= 200; pause += 10) {
    const s = setup();
    s.swipe.down(0);
    for (let x = 15; x <= 90; x += 15) {
      s.fake.advance(8);
      s.swipe.move(x);
    }
    s.fake.advance(pause);
    const shown = s.swipe.armed;
    const result = s.swipe.up(90);
    assert.equal(result, shown ? 'commit' : 'snap', `pause ${pause} ms`);
  }
});

test('thrown back against an armed drag: disarms and springs back from the drawn motion', () => {
  const s = setup();
  drag(s, 0.4 * WIDTH, 15, 16);
  s.fake.advance(200);
  assert.equal(s.swipe.armed, 'right');
  for (let x = 0.4 * WIDTH; x >= 0.32 * WIDTH; x -= 12) {
    s.fake.advance(8);
    s.swipe.move(x);
  }
  assert.equal(s.swipe.armed, null);
  const drawn = s.swipe.offset;
  const velocity = s.swipe.velocity;
  assert.equal(s.swipe.up(0.32 * WIDTH), 'snap');
  assert.equal(s.commits.length, 0);
  assert.equal(s.ghosts.active.length, 0);
  assert.ok(Math.abs(s.swipe.offset - drawn) < 1e-9);
  assert.ok(Math.abs(s.swipe.velocity - velocity) < 1e-9);
});

test('hand-off from a letter still drifting back keeps its velocity', () => {
  const velocity = -0.3;
  const plan = handoffFlightPlan('done', 200, velocity);
  assert.ok(plan);
  const xs = plan.keyframes.map(k =>
    Number(/translate\(([-\d.e]+)px/.exec(String(k.transform))?.[1]),
  );
  const dt = Number(plan.keyframes[1]?.offset) * plan.duration;
  const [p0, p1, p2] = [Number(xs[0]), Number(xs[1]), Number(xs[2])];
  assert.ok(Math.abs(p0 - 200) < 1e-9);
  // Constant acceleration: the start velocity is (4 p1 - p2 - 3 p0) / 2 dt.
  assert.ok(Math.abs((4 * p1 - p2 - 3 * p0) / (2 * dt) - velocity) < 1e-9);
  assert.ok(Number(xs.at(-1)) - 200 >= moves.flightX - 1e-9);
  for (const frame of plan.keyframes) {
    const tilt = Number(/rotate\(([-\d.e]+)deg/.exec(String(frame.transform))?.[1]);
    assert.ok(tilt >= 0, 'tilt never leans the wrong way');
  }
});
