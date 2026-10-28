/**
 * The one hold gate (`holds.ts`) on the data layer's manual timers: the owner's rules (plans/STATUS.md 2026-10-28),
 * the cases ported from the motion lane's hold tests and the button masher's pointer cases, and a seeded fuzz of keys,
 * pointer moves, hides and Esc checked against a model of the rules. The motion lane runs the same gate on its
 * visible-time scheduler (`motion/hold.test.ts`, `motion/masher.test.ts`).
 * `cd apps/desktop && npx tsx --test src/renderer/data/holds.test.ts`; `APLOS_PROPERTY_RUNS` overrides the 1,000 fuzz
 * runs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { motions } from '../ui/generated/motion';
import type { Id } from './contract-shapes';
import { createHarness } from './harness';
import { createHoldGate, HOLD_CAP_MS, HOLD_RELEASE_MS } from './holds';
import type { HoldReason } from './index';
import { createManualTimers } from './scheduler';

const HOLD = HOLD_RELEASE_MS;
const CAP = HOLD_CAP_MS;
const RUNS = Number(process.env.APLOS_PROPERTY_RUNS ?? 1_000);

/** mulberry32, so fuzz runs repeat. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function setup() {
  const timers = createManualTimers(0);
  const hold = createHoldGate(timers);
  const releases: { ids: readonly Id[]; reason: HoldReason; at: number }[] = [];
  hold.onRelease(r => releases.push({ ids: r.ids, reason: r.reason, at: timers.now() }));
  return { timers, hold, releases };
}

test('timing is the generated hold motion: base 450, cap 1200', () => {
  assert.equal(HOLD, motions.hold.durations.base);
  assert.equal(CAP, motions.hold.durations.cap);
  assert.equal(HOLD, 450);
  assert.equal(CAP, 1200);
});

test('hold releases 450 ms after the last key', () => {
  const { timers, hold, releases } = setup();
  hold.begin('keys', ['a']);
  timers.advance(200);
  hold.extend(['b']);
  assert.deepEqual(hold.heldIds, ['a', 'b']);
  timers.advance(HOLD - 1);
  assert.equal(hold.isHeld, true);
  timers.advance(1);
  assert.equal(hold.isHeld, false);
  assert.deepEqual(releases, [{ ids: ['a', 'b'], reason: 'keys', at: 200 + HOLD }]);
  assert.deepEqual(hold.heldIds, []);
  assert.equal(timers.pending, 0);
});

test('a long burst of keys holds until 450 ms after the last key, so it closes once', () => {
  const { timers, hold, releases } = setup();
  hold.begin('keys', ['a']);
  for (let i = 0; i < 19; i += 1) {
    timers.advance(100);
    hold.extend();
  }
  assert.equal(hold.isHeld, true, 'still held 1.9 s into a burst: no cap without the pointer');
  timers.advance(HOLD);
  assert.deepEqual(
    releases.map(r => r.at),
    [1900 + HOLD],
  );
});

test('keys spaced under 450 ms keep one hold past 1200 ms; ids merge without duplicates', () => {
  const { timers, hold, releases } = setup();
  hold.begin('keys', ['t1', 't1']);
  for (const at of [300, 600, 900, 1200, 1500]) {
    timers.set(at);
    hold.extend(['t2']);
  }
  assert.deepEqual(hold.heldIds, ['t1', 't2']);
  timers.set(1500 + HOLD - 1);
  assert.equal(hold.isHeld, true);
  timers.set(1500 + HOLD);
  assert.deepEqual(releases, [{ ids: ['t1', 't2'], reason: 'keys', at: 1500 + HOLD }]);
});

test('extend on an idle gate begins a key hold', () => {
  const { timers, hold, releases } = setup();
  hold.extend(['a']);
  assert.equal(hold.isHeld, true);
  assert.equal(hold.reason, 'keys');
  assert.deepEqual(hold.heldIds, ['a']);
  timers.advance(HOLD);
  assert.equal(releases.length, 1);
});

test('a pointer still on the list after the last key: the cap releases once, and the pointer keeps holding until it leaves', () => {
  const { timers, hold, releases } = setup();
  hold.pointerEnter(['a']);
  hold.extend(['b']);
  timers.advance(CAP - 1);
  assert.equal(hold.isHeld, true);
  timers.advance(1);
  assert.deepEqual(releases, [{ ids: ['a', 'b'], reason: 'pointer', at: CAP }]);
  assert.equal(hold.isHeld, true, 'the resting pointer still holds');
  assert.equal(hold.reason, 'pointer');
  assert.deepEqual(hold.heldIds, [], 'the fresh pointer hold has no pins');
  timers.advance(CAP * 4);
  assert.equal(hold.isHeld, true);
  assert.equal(releases.length, 1);
  assert.equal(timers.pending, 0, 'a pointer-only hold has no timer');

  // Another key under the resting pointer: the cap closes it once more.
  hold.extend(['c']);
  timers.advance(CAP);
  assert.equal(releases.length, 2);
  assert.deepEqual(releases[1]?.ids, ['c']);
  assert.equal(hold.isHeld, true);
  hold.pointerLeave();
  assert.equal(hold.isHeld, false);
  assert.equal(releases.length, 3);
});

test('the cap counts from the last key, and the pointer leaving before it releases at once', () => {
  const { timers, hold, releases } = setup();
  hold.begin('keys', ['a']);
  timers.advance(200);
  hold.pointerEnter();
  hold.extend();
  timers.advance(HOLD);
  assert.equal(hold.isHeld, true, 'past base, the pointer keeps it');
  timers.advance(300);
  hold.pointerLeave();
  assert.deepEqual(releases, [{ ids: ['a'], reason: 'keys', at: 200 + HOLD + 300 }]);
  assert.equal(hold.isHeld, false);
  assert.equal(timers.pending, 0);
});

test('the pointer alone holds until it leaves, and leaving releases at once', () => {
  const { timers, hold, releases } = setup();
  hold.pointerEnter(['a']);
  timers.advance(CAP * 2);
  assert.equal(hold.isHeld, true);
  hold.pointerLeave();
  assert.equal(hold.isHeld, false);
  assert.equal(releases[0]?.at, CAP * 2);

  hold.begin('keys', ['c']);
  timers.advance(100);
  hold.pointerLeave();
  assert.equal(releases.length, 2);
  assert.equal(releases[1]?.at, CAP * 2 + 100);
});

test('only pointerLeave forgets the pointer: Esc releases, and the resting pointer holds again with no pins', () => {
  const { timers, hold, releases } = setup();
  hold.pointerEnter();
  hold.begin('keys', ['a']);
  hold.release();
  assert.deepEqual(releases, [{ ids: ['a'], reason: 'pointer', at: 0 }]);
  assert.equal(hold.isHeld, true);
  assert.deepEqual(hold.heldIds, []);
  timers.advance(CAP * 3);
  assert.equal(hold.isHeld, true);
  hold.pointerLeave();
  assert.equal(hold.isHeld, false);
  hold.release();
  assert.equal(releases.length, 2, 'releasing an idle gate is a no-op');
});

test('hiding the window releases the hold', () => {
  const { timers, hold, releases } = setup();
  hold.begin('keys', ['a']);
  timers.advance(100);
  timers.setHidden(true);
  assert.equal(hold.isHeld, false);
  assert.equal(releases.length, 1);
  timers.setHidden(false);
  timers.advance(HOLD);
  assert.equal(releases.length, 1);
  assert.equal(timers.pending, 0);
});

test('hiding forgets the pointer; its next pointermove re-asserts the hold', () => {
  const { timers, hold, releases } = setup();
  hold.pointerEnter(['a']);
  timers.setHidden(true);
  assert.equal(hold.isHeld, false);
  assert.equal(releases.length, 1);
  timers.setHidden(false);
  assert.equal(hold.isHeld, false);
  hold.pointerEnter();
  hold.pointerEnter();
  assert.equal(hold.isHeld, true);
  timers.advance(CAP * 2);
  assert.equal(hold.isHeld, true);
  assert.equal(releases.length, 1);
});

test('subscribers hear every change so useSyncExternalStore stays exact', () => {
  const { timers, hold } = setup();
  let changes = 0;
  hold.subscribe(() => changes++);
  const version = hold.version;
  hold.begin('keys', ['a']);
  hold.extend(['a']);
  hold.extend(['b']);
  timers.advance(HOLD);
  assert.equal(changes, 3);
  assert.equal(hold.version, version + 3);
});

test('dispose stops listening for hides and cancels the timer', () => {
  const { timers, hold, releases } = setup();
  hold.begin('keys', ['a']);
  hold.dispose();
  assert.equal(timers.pending, 0);
  timers.setHidden(true);
  timers.advance(CAP);
  assert.equal(releases.length, 0);
});

test("the data layer's hold(scope) is this gate: one per scope, hides release it, close disposes it", async () => {
  const h = createHarness();
  try {
    await h.settle();
    const gate = h.layer.hold('home');
    assert.equal(h.layer.hold('home'), gate);
    assert.notEqual(h.layer.hold('later'), gate);
    gate.pointerEnter(['t1']);
    assert.equal(gate.isHeld, true);
    h.timers.setHidden(true);
    assert.equal(gate.isHeld, false, 'a hide releases and forgets the pointer');
    h.timers.setHidden(false);
    gate.begin('keys', ['t2']);
  } finally {
    h.close();
  }
  const gate = h.layer.hold('home');
  const before = gate.version;
  h.timers.setHidden(true);
  assert.equal(gate.version, before, 'a closed layer no longer hears hides');
});

/** What the rules say should happen, kept as deadlines rather than timers. */
interface Model {
  held: boolean;
  reason: HoldReason | null;
  ids: Id[];
  pointer: boolean;
  lastKey: number | null;
  releases: { ids: readonly Id[]; reason: HoldReason; at: number }[];
}

function modelRelease(m: Model, at: number) {
  if (!m.held) return;
  m.releases.push({ ids: m.ids, reason: m.reason ?? 'keys', at });
  m.held = false;
  m.reason = null;
  m.ids = [];
  m.lastKey = null;
  if (m.pointer) modelBegin(m, 'pointer', [], at);
}

function modelBegin(m: Model, why: HoldReason, ids: readonly Id[], at: number) {
  if (!m.held) {
    m.held = true;
    m.reason = why;
    m.lastKey = null;
  }
  if (why === 'pointer') m.pointer = true;
  else m.lastKey = at;
  for (const id of ids) if (!m.ids.includes(id)) m.ids.push(id);
}

/** Step the model's clock to `to`: base after the last key releases unless the pointer rests; the cap releases then. */
function modelAdvance(m: Model, to: number) {
  if (!m.held || m.lastKey === null) return;
  if (!m.pointer && m.lastKey + HOLD <= to) modelRelease(m, m.lastKey + HOLD);
  else if (m.pointer && m.lastKey + CAP <= to) modelRelease(m, m.lastKey + CAP);
}

test('fuzz: keys, pointer moves, hides and Esc follow the rules; nothing is stuck after the pointer leaves', () => {
  const pool = ['t1', 't2', 't3', 't4', 't5', 't6'];
  for (let seed = 1; seed <= RUNS; seed++) {
    const random = seeded(seed);
    const { timers, hold, releases } = setup();
    let changes = 0;
    hold.subscribe(() => changes++);
    let physical = false;
    let hidden = false;
    const m: Model = {
      held: false,
      reason: null,
      ids: [],
      pointer: false,
      lastKey: null,
      releases: [],
    };
    const pick = () => pool.filter(() => random() < 0.3);
    for (let step = 0; step < 60; step++) {
      const to = timers.now() + Math.floor(random() * 700);
      timers.set(to);
      modelAdvance(m, to);
      const at = timers.now();
      const roll = random();
      if (roll < 0.06) {
        hidden = !hidden;
        timers.setHidden(hidden);
        if (hidden) {
          m.pointer = false;
          modelRelease(m, at);
        }
      } else if (roll < 0.2) {
        physical = !physical;
        if (!hidden) {
          if (physical) {
            const ids = random() < 0.3 ? pick() : [];
            hold.pointerEnter(ids);
            modelBegin(m, 'pointer', ids, at);
          } else {
            hold.pointerLeave();
            m.pointer = false;
            modelRelease(m, at);
          }
        }
      } else if (roll < 0.3) {
        // A pointermove: re-asserts a resting pointer (after a hide, too); idempotent otherwise.
        if (!hidden && physical) {
          hold.pointerEnter();
          modelBegin(m, 'pointer', [], at);
        }
      } else if (roll < 0.34) {
        if (!hidden) {
          hold.release();
          modelRelease(m, at);
        }
      } else if (!hidden) {
        const ids = pick();
        if (random() < 0.5) hold.begin('keys', ids);
        else hold.extend(ids);
        modelBegin(m, 'keys', ids, at);
      }
      const where = `seed ${seed} step ${step} at ${at}`;
      assert.equal(hold.isHeld, m.held, `${where}: isHeld`);
      assert.equal(hold.reason, m.reason, `${where}: reason`);
      assert.deepEqual(hold.heldIds, m.ids, `${where}: heldIds`);
      assert.equal(releases.length, m.releases.length, `${where}: release count`);
      assert.deepEqual(releases.at(-1), m.releases.at(-1), `${where}: last release`);
      if (m.held && m.lastKey !== null) {
        assert.ok(at - m.lastKey < CAP, `${where}: a key hold outlived the cap`);
        if (!m.pointer)
          assert.ok(at - m.lastKey < HOLD, `${where}: held past base with no pointer`);
      }
      if (hold.isHeld && m.lastKey === null)
        assert.equal(timers.pending, 0, `${where}: pointer hold has a timer`);
    }
    if (hidden) timers.setHidden(false);
    hold.pointerLeave();
    timers.advance(CAP * 2);
    assert.equal(hold.isHeld, false, `seed ${seed}: still held`);
    assert.equal(timers.pending, 0, `seed ${seed}: timer left`);
    assert.equal(hold.version, changes, `seed ${seed}: a change went unheard`);
    for (let i = 1; i < releases.length; i++) {
      const a = releases[i - 1];
      const b = releases[i];
      assert.ok(a && b && a.at <= b.at, `seed ${seed}: releases out of order`);
    }
  }
});
