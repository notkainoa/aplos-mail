import assert from 'node:assert/strict';
import { test } from 'node:test';
import { motions, themeHooks, timing } from '../ui/generated/motion';
import { createCursorLayer } from './cursor';
import { cubicBezier, progressOf } from './easing';
import { FakeEnv } from './fakes';
import { createPuckSlider, puckTransform } from './puck';
import { createScheduler } from './scheduler';
import { createSpringMotion } from './spring';
import { createThemeFreeze } from './themeFreeze';

test('cursor: 120 ms on a key, 160 to the focus slot, 0 on repeat, pointer, rapid and reduced', () => {
  const fake = new FakeEnv();
  const scheduler = createScheduler(fake.env);
  const layer = fake.element();
  const cursor = createCursorLayer(layer.el, scheduler);

  cursor.move({ y: 40, cause: 'key' });
  assert.equal(layer.style.transform, 'translate(0px, 40px)');
  const [first] = fake.running();
  assert.equal(first?.options.duration, motions.cursor.durations.base);
  assert.equal(first?.options.easing, motions.cursor.curve);
  assert.deepEqual(
    first?.keyframes.map(k => k.transform),
    ['translate(0px, 0px)', 'translate(0px, 40px)'],
  );

  fake.advance(60);
  const drawn = cursor.position[1] ?? 0;
  const expected = 40 * progressOf(motions.cursor.curve)(60 / motions.cursor.durations.base);
  assert.ok(Math.abs(drawn - expected) < 1e-9);
  cursor.move({ y: 80, cause: 'key', focus: true });
  assert.equal(first?.playState, 'idle');
  const [second] = fake.running();
  assert.equal(second?.options.duration, motions.cursor.durations.focus);
  assert.equal(second?.keyframes[0]?.transform, `translate(0px, ${drawn}px)`);

  for (const move of [
    { y: 120, cause: 'repeat' as const },
    { y: 160, cause: 'pointer' as const },
  ]) {
    cursor.move(move);
    assert.equal(fake.running().length, 0);
    assert.equal(layer.style.transform, `translate(0px, ${move.y}px)`);
    assert.equal(layer.style.willChange, '');
  }
  cursor.move({ y: 200, cause: 'key' }, { rapid: true });
  cursor.move({ y: 240, cause: 'key' }, { reduced: true });
  fake.reduced = true;
  cursor.move({ y: 280, cause: 'key' });
  assert.equal(fake.running().length, 0);
  assert.equal(layer.style.transform, 'translate(0px, 280px)');
});

test('puck slides by translate and scaleX on the slide spring curve, never width', () => {
  const fake = new FakeEnv();
  const scheduler = createScheduler(fake.env);
  const thumb = fake.element();
  const puck = createPuckSlider(thumb.el, 80, scheduler);
  puck.moveTo({ x: 0, y: 0, width: 80 }, { instant: true });
  assert.equal(fake.running().length, 0);
  puck.moveTo({ x: 96, y: 0, width: 120 });
  const [slide] = fake.running();
  assert.equal(slide?.options.duration, motions.slide.durations.base);
  assert.equal(slide?.options.easing, motions.slide.curve);
  assert.deepEqual(
    slide?.keyframes.map(k => k.transform),
    [puckTransform({ x: 0, y: 0, width: 80 }, 80), puckTransform({ x: 96, y: 0, width: 120 }, 80)],
  );
  assert.equal(thumb.style.width, undefined);
  assert.ok(slide?.keyframes.every(k => Object.keys(k).every(key => key === 'transform')));
  fake.advance(motions.slide.durations.base);
  assert.equal(fake.running().length, 0);
  assert.equal(thumb.style.willChange, '');
  puck.moveTo({ x: 0, y: 0, width: 80 }, { context: { reduced: true } });
  assert.equal(fake.running().length, 0);
});

test('theme switch freezes transitions for one frame', () => {
  const fake = new FakeEnv();
  const scheduler = createScheduler(fake.env);
  const root = fake.document.documentElement;
  const freeze = createThemeFreeze(root.el, scheduler);
  let frozenDuringApply = false;
  freeze.switchTheme(() => {
    frozenDuringApply = root.hasAttribute(themeHooks.switching);
    root.setAttribute(themeHooks.theme, 'dark');
  });
  assert.equal(frozenDuringApply, true);
  assert.equal(fake.flushes, 1);
  assert.equal(freeze.frozen, true);
  const startFrames = fake.frames;
  fake.advance(1000);
  assert.equal(fake.frames - startFrames, timing.themeSwitchFrames);
  assert.equal(root.hasAttribute(themeHooks.switching), false);
  assert.equal(root.getAttribute(themeHooks.theme), 'dark');
});

test('one frame loop drives every spring, and nothing runs once they rest', () => {
  const fake = new FakeEnv();
  const scheduler = createScheduler(fake.env);
  for (let i = 0; i < 5; i++) createSpringMotion(scheduler, { spring: 'lift', from: 0, to: 1 + i });
  assert.equal(fake.pendingFrames(), 1);
  fake.advance(17);
  assert.equal(fake.pendingFrames(), 1);
  fake.advance(1000);
  assert.equal(fake.pendingFrames(), 0);
  assert.equal(scheduler.pending, 0);
});

test('cubic-bezier evaluation matches the curve end points and is monotonic for ease.out', () => {
  const out = cubicBezier([0.16, 1, 0.3, 1]);
  assert.equal(out(0), 0);
  assert.equal(out(1), 1);
  let last = 0;
  for (let t = 0.01; t < 1; t += 0.01) {
    const v = out(t);
    assert.ok(v >= last);
    last = v;
  }
  assert.throws(() => progressOf('ease'));
});
