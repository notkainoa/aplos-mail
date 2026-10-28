import assert from 'node:assert/strict';
import { test } from 'node:test';
import { motions, timing } from '../ui/generated/motion';
import { FakeEnv, type FakeElement } from './fakes';
import { closeDeltas, createCloser, layoutTops } from './flip';
import { createGhostLayer } from './ghost';
import { createHoldGate } from './holdGate';
import { createRapidTracker } from './rapid';
import { createScheduler } from './scheduler';
import { createTriageMotion } from './triage';

const { base: HOLD, cap: CAP } = motions.hold.durations;

function setup() {
  const fake = new FakeEnv();
  const scheduler = createScheduler(fake.env);
  const hold = createHoldGate(scheduler);
  const releases: { ids: readonly string[]; at: number }[] = [];
  hold.onRelease(r => releases.push({ ids: r.ids, at: fake.now }));
  return { fake, scheduler, hold, releases };
}

test('hold releases 450 ms after the last key', () => {
  const { fake, hold, releases } = setup();
  hold.begin('keys', ['a']);
  fake.advance(200);
  hold.extend(['b']);
  assert.deepEqual(hold.heldIds, ['a', 'b']);
  fake.advance(HOLD - 1);
  assert.equal(hold.isHeld, true);
  fake.advance(1);
  assert.equal(hold.isHeld, false);
  assert.deepEqual(releases, [{ ids: ['a', 'b'], at: 200 + HOLD }]);
  assert.deepEqual(hold.heldIds, []);
});

test('a long burst of keys holds until 450 ms after the last key, so it closes once', () => {
  const { fake, hold, releases } = setup();
  hold.begin('keys', ['a']);
  for (let i = 0; i < 19; i += 1) {
    fake.advance(100);
    hold.extend();
  }
  assert.equal(hold.isHeld, true, 'still held 1.9 s into a burst');
  fake.advance(HOLD);
  assert.deepEqual(
    releases.map(r => r.at),
    [1900 + HOLD],
  );
});

test('a pointer still on the list after the last key holds, but never past the cap', () => {
  const { fake, hold, releases } = setup();
  hold.pointerEnter(['a']);
  hold.extend(['b']);
  fake.advance(CAP - 1);
  assert.equal(hold.isHeld, true);
  fake.advance(1);
  assert.equal(hold.isHeld, false);
  assert.deepEqual(releases, [{ ids: ['a', 'b'], at: CAP }]);
});

test('the pointer alone holds until it leaves, and leaving releases at once', () => {
  const { fake, hold, releases } = setup();
  hold.pointerEnter(['a']);
  fake.advance(CAP * 2);
  assert.equal(hold.isHeld, true);
  hold.pointerLeave();
  assert.equal(hold.isHeld, false);
  assert.equal(releases[0]?.at, CAP * 2);

  hold.begin('keys', ['c']);
  fake.advance(100);
  hold.pointerLeave();
  assert.equal(releases.length, 2);
  assert.equal(releases[1]?.at, CAP * 2 + 100);
});

test('hiding the window releases the hold', () => {
  const { fake, hold, releases } = setup();
  hold.begin('keys', ['a']);
  fake.advance(100);
  fake.setHidden(true);
  assert.equal(hold.isHeld, false);
  assert.equal(releases.length, 1);
  fake.setHidden(false);
  fake.advance(HOLD);
  assert.equal(releases.length, 1);
});

test('subscribers hear every change so useSyncExternalStore stays exact', () => {
  const { fake, hold } = setup();
  let changes = 0;
  hold.subscribe(() => changes++);
  hold.begin('keys', ['a']);
  hold.extend(['a']);
  hold.extend(['b']);
  fake.advance(HOLD);
  assert.equal(changes, 3);
});

test('rapid: keys under 300 ms apart; burst from the fourth key in a second', () => {
  const rapid = createRapidTracker();
  const gap = timing.rapidGap;
  assert.deepEqual(rapid.key(0), { rapid: false, burst: false });
  assert.deepEqual(rapid.key(gap - 1), { rapid: true, burst: false });
  assert.deepEqual(rapid.key(2 * gap - 2), { rapid: true, burst: false });
  assert.deepEqual(rapid.key(3 * gap - 3), { rapid: true, burst: true });
  assert.deepEqual(rapid.key(3 * gap - 3 + gap), { rapid: false, burst: true });
  assert.deepEqual(rapid.key(10_000), { rapid: false, burst: false });
  // Four keys a little over the rapid gap apart are still a burst inside one second.
  const slow = createRapidTracker();
  const step = timing.rapidGap + 10;
  assert.ok(step * (timing.burstKeys - 1) < timing.burstWindow);
  let last = { rapid: false, burst: false };
  for (let i = 0; i < timing.burstKeys; i++) last = slow.key(i * step);
  assert.deepEqual(last, { rapid: false, burst: true });
});

test('FLIP math from fixed row heights', () => {
  const height = (id: string) => (id === 'focus' ? 180 : 40);
  const before = layoutTops(['focus', 'a', 'b', 'c', 'd'], height, 48);
  assert.deepEqual([...before.values()], [48, 228, 268, 308, 348]);
  const after = layoutTops(['focus', 'a', 'c', 'd'], height, 48);
  assert.deepEqual(
    [...closeDeltas(before, after)],
    [
      ['c', 40],
      ['d', 40],
    ],
  );
  const twoGone = layoutTops(['a', 'd'], height, 48);
  assert.deepEqual(
    [...closeDeltas(before, twoGone)],
    [
      ['a', 180],
      ['d', 260],
    ],
  );
});

test('the closer pins rows during the hold and FLIPs them up once it releases', () => {
  const fake = new FakeEnv();
  const scheduler = createScheduler(fake.env);
  const hold = createHoldGate(scheduler);
  const rows = new Map<string, FakeElement>();
  for (const id of ['a', 'b', 'c', 'd']) rows.set(id, fake.element({ height: 40 }));
  const closer = createCloser<string>({
    heightOf: () => 40,
    elementOf: id => rows.get(id)?.el ?? null,
  });
  hold.onRelease(() => closer.close());

  closer.anchor(['a', 'b', 'c', 'd']);
  hold.begin('keys', ['b']);
  closer.pin(['a', 'c', 'd']);
  hold.extend();
  closer.pin(['a', 'd']);
  assert.equal(rows.get('d')?.style.transform, 'translateY(80px)');
  assert.equal(rows.get('c')?.style.transform, '');
  assert.equal(fake.running().length, 0);

  fake.advance(HOLD);
  assert.equal(hold.isHeld, false);
  const running = fake.running();
  assert.equal(running.length, 1);
  assert.equal(running[0]?.target, rows.get('d'));
  assert.deepEqual(
    running[0]?.keyframes.map(k => k.transform),
    ['translateY(80px)', 'none'],
  );
  assert.equal(running[0]?.options.duration, motions.close.durations.base);
  assert.equal(running[0]?.options.easing, motions.close.curve);
  assert.equal(rows.get('d')?.style.transform, '');
  fake.advance(motions.close.durations.base);
  assert.equal(fake.running().length, 0);
  assert.equal(rows.get('d')?.style.willChange, '');
});

test('reduced motion: close lands at once', () => {
  const fake = new FakeEnv();
  const row = fake.element({ height: 40 });
  const closer = createCloser<string>({ heightOf: () => 40, elementOf: () => row.el });
  closer.anchor(['x', 'y']);
  closer.pin(['y']);
  assert.equal(closer.close({ reduced: true }), 0);
  assert.equal(row.style.transform, '');
  assert.equal(fake.running().length, 0);
});

function triageList(ids: readonly string[]) {
  const fake = new FakeEnv();
  const scheduler = createScheduler(fake.env);
  const hold = createHoldGate(scheduler);
  const elements = new Map<string, FakeElement>();
  for (const id of ids) elements.set(id, fake.element({ height: 40 }));
  const closer = createCloser<string>({
    heightOf: () => 40,
    elementOf: id => elements.get(id)?.el ?? null,
  });
  const triage = createTriageMotion({
    scheduler,
    ghosts: createGhostLayer({ scheduler, host: fake.element().el }),
    hold,
    rapid: createRapidTracker(),
    closer,
  });
  const closes = () =>
    fake.animations.filter(a => String(a.keyframes[0]?.transform).startsWith('translateY('));
  return { fake, hold, elements, closer, triage, closes };
}

test('a pointer already resting on the list: the first key still pins, and the cap after the last key closes', () => {
  const s = triageList(['a', 'b', 'c', 'd']);
  s.hold.pointerEnter();
  const b = s.elements.get('b');
  s.elements.delete('b');
  s.triage.commit({
    kind: 'done',
    surface: 'row',
    element: b?.el ?? null,
    rows: { before: ['a', 'b', 'c', 'd'], after: ['a', 'c', 'd'] },
  });
  assert.equal(s.closer.pinned.size, 2);
  assert.equal(s.elements.get('c')?.style.transform, 'translateY(40px)');
  s.fake.advance(CAP - 1);
  assert.equal(s.elements.get('c')?.style.transform, 'translateY(40px)');
  s.fake.advance(1);
  assert.equal(s.closes().length, 2);
  assert.equal(s.closer.pinned.size, 0);
  s.hold.pointerLeave();

  // The next hold anchors afresh from the layout the close landed on.
  s.fake.advance(motions.close.durations.base);
  s.hold.pointerEnter();
  s.triage.commit({
    kind: 'done',
    surface: 'row',
    element: null,
    rows: { before: ['a', 'c', 'd'], after: ['a', 'd'] },
  });
  assert.equal(s.elements.get('d')?.style.transform, 'translateY(40px)');
});

test('an undo during the hold goes through relayout and keeps the rows still', () => {
  const s = triageList(['a', 'b', 'c', 'd']);
  s.triage.commit({
    kind: 'done',
    surface: 'row',
    element: null,
    rows: { before: ['a', 'b', 'c', 'd'], after: ['a', 'c', 'd'] },
  });
  s.triage.commit({
    kind: 'later',
    surface: 'row',
    element: null,
    rows: { before: ['a', 'c', 'd'], after: ['a', 'd'] },
  });
  assert.equal(s.elements.get('d')?.style.transform, 'translateY(80px)');
  s.triage.relayout({ before: ['a', 'd'], after: ['a', 'c', 'd'] });
  assert.equal(s.elements.get('c')?.style.transform, 'translateY(40px)');
  assert.equal(s.elements.get('d')?.style.transform, 'translateY(40px)');
  s.fake.advance(HOLD);
  assert.deepEqual(
    s.closes().map(a => a.keyframes[0]?.transform),
    ['translateY(40px)', 'translateY(40px)'],
  );

  // Outside a hold relayout leaves React's layout alone.
  s.fake.advance(motions.close.durations.base);
  s.triage.relayout({ before: ['a', 'c', 'd'], after: ['a', 'd'] });
  assert.equal(s.elements.get('d')?.style.transform, '');
  assert.equal(s.closer.pinned.size, 0);
});
