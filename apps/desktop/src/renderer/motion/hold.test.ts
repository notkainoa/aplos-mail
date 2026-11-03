import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createFixtureEngine, defaultNow } from '@aplos/contract-fixture';
import { connectDataLayer } from '../data/connect';
import { createHoldGate, type HoldGate } from '../data/holds';
import { useHold } from '../data/index';
import { createManualScheduler, createManualTimers } from '../data/scheduler';
import type { Timers } from '../data/scheduler';
import { motions, timing } from '../ui/generated/motion';
import { createCursorLayer } from './cursor';
import { FakeEnv, type FakeElement } from './fakes';
import { closeDeltas, createCloser, layoutTops } from './flip';
import { createGhostLayer } from './ghost';
import { createMotionRuntime } from './index';
import { createRapidTracker } from './rapid';
import { createScheduler } from './scheduler';
import { createTriageMotion } from './triage';

const { base: HOLD, cap: CAP } = motions.hold.durations;

// The hold gate's rules and their cases live with the gate (data/holds.test.ts).
// Here: the same gate on this lane's visible-time scheduler, which is a data
// layer Timers (now, setTimeout, onHide).
test("the data layer's hold gate runs on the motion scheduler's visible clock", () => {
  const fake = new FakeEnv();
  const scheduler = createScheduler(fake.env);
  const timers: Timers = scheduler;
  const hold = createHoldGate(timers);
  const releases: { ids: readonly string[]; at: number }[] = [];
  hold.onRelease(r => releases.push({ ids: r.ids, at: fake.now }));

  hold.begin('keys', ['a']);
  fake.advance(200);
  hold.extend(['b']);
  fake.advance(HOLD - 1);
  assert.equal(hold.isHeld, true);
  fake.advance(1);
  assert.deepEqual(releases, [{ ids: ['a', 'b'], at: 200 + HOLD }]);
  assert.equal(scheduler.pending, 0);

  // A resting pointer: the cap after the last key releases once, then a pointer-only hold.
  hold.pointerEnter();
  hold.extend(['c']);
  fake.advance(CAP);
  assert.equal(releases.length, 2);
  assert.equal(hold.isHeld, true);
  assert.deepEqual(hold.heldIds, []);
  assert.equal(scheduler.pending, 0);

  // A hide releases and forgets the pointer; nothing waits on hidden time.
  hold.extend(['d']);
  fake.setHidden(true);
  assert.equal(hold.isHeld, false);
  assert.equal(releases.length, 3);
  assert.equal(scheduler.pending, 0);
  fake.setHidden(false);
  fake.advance(CAP * 2);
  assert.equal(hold.isHeld, false);
  hold.pointerEnter();
  assert.equal(hold.isHeld, true);
  hold.pointerLeave();
  assert.equal(releases.length, 4);
  hold.dispose();
});

test('one gate per list: triage closes on the same gate whose heldIds freeze the window', async () => {
  const engine = createFixtureEngine({ scenario: 'demo', clock: defaultNow });
  const frames = createManualScheduler();
  const timers = createManualTimers(defaultNow);
  const connection = connectDataLayer({ session: engine.connect(), scheduler: frames, timers });
  const { layer } = connection;
  try {
    const w = layer.windows.acquire({ kind: 'home' });
    for (let i = 0; i < 20; i++) {
      await new Promise<void>(resolve => setImmediate(resolve));
      frames.flush();
    }
    // What a list does: useHold(scope) for the gate, its heldIds as useView's holdIds, the same gate to triage.
    let fromHook: HoldGate | null = null;
    function List() {
      fromHook = useHold('home') as HoldGate;
      return null;
    }
    renderToStaticMarkup(createElement(List));
    const gate = layer.hold('home');
    assert.equal(fromHook, gate, 'useHold hands out the layer gate itself');
    gate.subscribe(() => w.setHold(1, gate.heldIds));

    const fake = new FakeEnv();
    const runtime = createMotionRuntime(fake.env);
    assert.equal('createHold' in runtime, false, 'the motion runtime makes no gates of its own');
    const ids = [...w.snapshot().ids].slice(0, 4);
    const elements = new Map<string, FakeElement>();
    for (const id of ids) elements.set(id, fake.element({ height: 40 }));
    const closer = createCloser<string>({
      heightOf: () => 40,
      elementOf: id => elements.get(id)?.el ?? null,
    });
    const triage = createTriageMotion({
      scheduler: runtime.scheduler,
      ghosts: runtime.ghosts,
      hold: gate,
      rapid: runtime.rapid,
      closer,
    });
    const [a, , c, d] = ids as [string, string, string, string];
    triage.commit({
      kind: 'done',
      surface: 'row',
      element: null,
      holdIds: [a, c],
      rows: { before: ids, after: [a, c, d] },
    });
    assert.equal(w.held, true, 'the key froze the window');
    assert.equal(closer.pinned.size, 2);
    timers.advance(HOLD);
    assert.equal(w.held, false, 'one release lets the window go');
    assert.equal(closer.pinned.size, 0, 'and closes the rows');
    triage.dispose();
    runtime.dispose();
  } finally {
    connection.close();
  }
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

test('during a hold the cursor rides the focused row; on release it lands with the row on close', () => {
  const fake = new FakeEnv();
  const scheduler = createScheduler(fake.env);
  const hold = createHoldGate(scheduler);
  const elements = new Map<string, FakeElement>();
  ['a', 'b', 'c', 'd', 'e', 'f'].forEach((id, i) =>
    elements.set(id, fake.element({ top: i * 40, height: 40 })),
  );
  const closer = createCloser<string>({
    heightOf: () => 40,
    elementOf: id => elements.get(id)?.el ?? null,
  });
  const cursorEl = fake.element();
  const cursor = createCursorLayer(cursorEl.el, scheduler);
  const triage = createTriageMotion({
    scheduler,
    ghosts: createGhostLayer({ scheduler, host: fake.element().el }),
    hold,
    rapid: createRapidTracker(),
    closer,
    cursor,
  });
  let rows = ['a', 'b', 'c', 'd', 'e', 'f'];
  triage.focus(rows, 'b');
  fake.advance(300);
  for (const [i, next] of ['c', 'd', 'e'].entries()) {
    const before = rows;
    rows = rows.filter(r => r !== before[1]);
    triage.commit({
      kind: 'done',
      surface: 'row',
      element: null,
      rows: { before, after: rows },
      focus: next,
    });
    assert.equal(cursor.target[1], 80 + i * 40, `E${i + 1}: cursor on ${next}'s drawn top`);
    assert.equal(elements.get(next)?.style.transform, `translateY(${(i + 1) * 40}px)`);
    fake.advance(200);
  }
  assert.equal(hold.isHeld, true);

  fake.advance(HOLD - 200);
  assert.equal(hold.isHeld, false);
  const glide = fake.running().find(a => a.target === cursorEl);
  assert.equal(glide?.options.duration, motions.close.durations.base);
  assert.equal(glide?.options.easing, motions.close.curve);
  assert.deepEqual(
    glide?.keyframes.map(k => k.transform),
    ['translate(0px, 160px)', 'translate(0px, 40px)'],
  );
  const row = fake.running().find(a => a.target === elements.get('e'));
  assert.equal(row?.options.duration, glide?.options.duration);
  fake.advance(motions.close.durations.base);
  assert.deepEqual(cursor.position, [0, 40]);
  assert.equal(fake.running().length, 0);
});
