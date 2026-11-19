import assert from 'node:assert/strict';
import { test } from 'node:test';
import { motions } from '../ui/generated/motion';
import { FakeEnv, type FakeElement } from './fakes';
import { createGhostLayer, MAX_GHOSTS } from './ghost';
import { createScheduler } from './scheduler';
import { carryPlan, commitChipPlan, flightPlan } from './signature';

function setup(options: { reduced?: boolean } = {}) {
  const fake = new FakeEnv(options);
  const scheduler = createScheduler(fake.env);
  const host = fake.element();
  const ghosts = createGhostLayer({ scheduler, host: host.el });
  return { fake, scheduler, host, ghosts };
}

test('a ghost is a fixed-geometry clone; the real element goes at once', () => {
  const { fake, host, ghosts } = setup();
  const list = fake.element();
  const row = fake.element({ left: 240, top: 120, width: 600, height: 40 }, list);
  row.setAttribute('id', 'row-1');
  const ghost = ghosts.launch(row.el, flightPlan('done'));
  assert.ok(ghost);
  assert.equal(row.isConnected, false);
  const clone = host.children[0];
  assert.ok(clone);
  assert.equal(clone.hasAttribute('id'), false);
  assert.equal(clone.getAttribute('aria-hidden'), 'true');
  assert.deepEqual(
    [
      clone.style.position,
      clone.style.left,
      clone.style.top,
      clone.style.width,
      clone.style.height,
    ],
    ['fixed', '240px', '120px', '600px', '40px'],
  );
  assert.equal(clone.style.willChange, 'transform, opacity');
  const [animation] = fake.running();
  assert.equal(animation?.target, clone);
  assert.equal(animation?.options.duration, motions.flight.durations.base);
  assert.equal(animation?.options.easing, motions.flight.curve);
  assert.equal(animation?.options.fill, undefined);
});

test('at most three ghosts; a fourth finishes the oldest', () => {
  const { fake, host, ghosts } = setup();
  const launched = [];
  for (let i = 0; i < MAX_GHOSTS + 1; i++) {
    launched.push(ghosts.launch(fake.element({ top: i * 40, height: 40 }).el, carryPlan('done')));
  }
  assert.equal(ghosts.active.length, MAX_GHOSTS);
  assert.equal(launched[0]?.done, true);
  assert.equal(host.children.length, MAX_GHOSTS);
  assert.equal(fake.running().length, MAX_GHOSTS);
  assert.equal(launched[0]?.clone.style.willChange, '');
});

test('will-change is removed after settle and nothing is left running', () => {
  const { fake, host, ghosts } = setup();
  const ghost = ghosts.launch(fake.element({ height: 40 }).el, flightPlan('later'), {
    decorate: clone => {
      const chip = fake.element({}, clone as unknown as FakeElement);
      return [{ element: chip.el, plan: commitChipPlan() }];
    },
  });
  assert.equal(fake.running().length, 2);
  fake.advance(motions.flight.durations.base + 1);
  assert.equal(ghost?.done, true);
  assert.equal(host.children.length, 0);
  assert.equal(fake.running().length, 0);
  assert.equal(ghost?.clone.style.willChange, '');
  for (const el of (ghost?.clone as unknown as FakeElement | undefined)?.descendants() ?? [])
    assert.equal(el.style.willChange, '');
});

test('reduced motion: flight is a short fade', () => {
  const { fake, ghosts } = setup({ reduced: true });
  ghosts.launch(fake.element({ height: 40 }).el, flightPlan('done', { reduced: true }));
  const [animation] = fake.running();
  assert.equal(animation?.options.duration, motions.flight.reduced.base);
  assert.deepEqual(
    animation?.keyframes.map(k => k.opacity),
    [1, 0],
  );
});

test('a hidden window finishes every ghost', () => {
  const { fake, ghosts, host } = setup();
  ghosts.launch(fake.element({ height: 40 }).el, flightPlan('done'));
  ghosts.launch(fake.element({ height: 40 }).el, flightPlan('later'));
  fake.setHidden(true);
  assert.equal(ghosts.active.length, 0);
  assert.equal(host.children.length, 0);
  assert.equal(fake.running().length, 0);
});

test("'hide' leaves a React-owned node in place, hidden, and shows it again if it survives", () => {
  const { fake, ghosts } = setup();
  const row = fake.element({ height: 40 });
  ghosts.launch(row.el, carryPlan('done'), { release: 'hide' });
  assert.equal(row.isConnected, true);
  assert.equal(row.style.visibility, 'hidden');
  fake.advance(motions.carry.durations.base + 1);
  assert.equal(row.style.visibility, '');
});

test("'hide' twice on a node that survives: both clones show, and the last ghost restores it", () => {
  const { fake, ghosts } = setup();
  const row = fake.element({ height: 40 });
  const first = ghosts.launch(row.el, flightPlan('done'), { release: 'hide' });
  fake.advance(motions.flight.durations.base / 2);
  const second = ghosts.launch(row.el, flightPlan('done'), { release: 'hide' });
  assert.equal(second?.clone.style.visibility, 'visible');
  assert.equal(row.style.visibility, 'hidden');
  fake.advance(motions.flight.durations.base / 2 + 1);
  assert.equal(first?.done, true);
  assert.equal(row.style.visibility, 'hidden', 'the second ghost still flies');
  fake.advance(motions.flight.durations.base);
  assert.equal(second?.done, true);
  assert.equal(row.isConnected, true);
  assert.equal(row.style.visibility, '');
});

test('an instant plan releases the element without a ghost', () => {
  const { fake, ghosts, host } = setup();
  const row = fake.element({ height: 40 });
  assert.equal(ghosts.launch(row.el, null), null);
  assert.equal(row.isConnected, false);
  assert.equal(host.children.length, 0);
});
