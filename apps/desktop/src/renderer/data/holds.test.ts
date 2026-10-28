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
import type { Id, ThreadRow } from './contract-shapes';
import { createHarness } from './harness';
import { createHoldGate, HOLD_CAP_MS, HOLD_RELEASE_MS } from './holds';
import type { HoldController, HoldReason } from './index';
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

test('a pointer still on the list after the last key: the cap releases once, and the pointer keeps holding its row until it leaves', () => {
  const { timers, hold, releases } = setup();
  hold.pointerEnter(['a']);
  hold.extend(['b']);
  assert.equal(hold.reason, 'keys', 'a key joined: a key hold waiting on the pointer');
  timers.advance(CAP - 1);
  assert.equal(hold.isHeld, true);
  timers.advance(1);
  assert.deepEqual(releases, [{ ids: ['a', 'b'], reason: 'keys', at: CAP }]);
  assert.equal(hold.isHeld, true, 'the resting pointer still holds');
  assert.equal(hold.reason, 'pointer');
  assert.deepEqual(hold.heldIds, ['a'], 'no key pins: only the row under the pointer');
  timers.advance(CAP * 4);
  assert.equal(hold.isHeld, true);
  assert.equal(releases.length, 1);
  assert.equal(timers.pending, 0, 'a pointer-only hold has no timer');

  // Another key under the resting pointer: the cap closes it once more.
  hold.extend(['c']);
  timers.advance(CAP);
  assert.equal(releases.length, 2);
  assert.deepEqual(releases[1]?.ids, ['a', 'c']);
  assert.deepEqual(hold.heldIds, ['a']);
  hold.pointerLeave();
  assert.equal(hold.isHeld, false);
  assert.equal(releases.length, 3);
  assert.deepEqual(releases[2], { ids: ['a'], reason: 'pointer', at: CAP * 6 });
});

test('the cap goes straight from the burst to the pointer hold: the window is never let go in between', () => {
  const { timers, hold } = setup();
  const seen: (readonly Id[])[] = [];
  hold.subscribe(() => seen.push(hold.heldIds));
  hold.pointerEnter(['p']);
  hold.extend(['k']);
  timers.advance(CAP);
  assert.deepEqual(seen, [['p'], ['p', 'k'], ['p']]);
  assert.ok(
    seen.every(ids => ids.length > 0),
    'heldIds never empty while the pointer rests',
  );
});

test('the cap counts from the last key, and the pointer leaving after base releases at once', () => {
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

test("the pointer alone holds until it leaves; leaving inside a key's 450 ms does not cut the key hold short", () => {
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
  assert.equal(hold.isHeld, true, 'the key still holds');
  assert.equal(releases.length, 1);
  timers.advance(HOLD - 101);
  assert.equal(hold.isHeld, true);
  timers.advance(1);
  assert.equal(releases.length, 2);
  assert.equal(releases[1]?.at, CAP * 2 + HOLD);
});

test('the pointer leaving partway through a burst: the burst still closes once, 450 ms after its last key', () => {
  const { timers, hold, releases } = setup();
  hold.pointerEnter(['p']);
  for (let i = 0; i < 20; i++) {
    hold.extend([`x${i}`]);
    if (i === 10) {
      timers.advance(50);
      hold.pointerLeave();
      timers.advance(50);
    } else timers.advance(100);
  }
  timers.advance(2000);
  assert.deepEqual(
    releases.map(r => r.at),
    [1900 + HOLD],
  );
  assert.equal(releases[0]?.reason, 'keys');
  assert.equal(hold.isHeld, false);
});

test('only pointerLeave forgets the pointer: Esc closes, and the resting pointer holds its row again', () => {
  const { timers, hold, releases } = setup();
  hold.pointerEnter(['p']);
  hold.begin('keys', ['a']);
  hold.release();
  assert.deepEqual(releases, [{ ids: ['p', 'a'], reason: 'keys', at: 0 }]);
  assert.equal(hold.isHeld, true);
  assert.equal(hold.reason, 'pointer');
  assert.deepEqual(hold.heldIds, ['p']);
  assert.equal(timers.pending, 0);
  timers.advance(CAP * 3);
  assert.equal(hold.isHeld, true);
  hold.pointerLeave();
  assert.equal(hold.isHeld, false);
  hold.release();
  assert.equal(releases.length, 2, 'releasing an idle gate is a no-op');
});

test('the HoldController surface alone: release() ends a pointer hold that begin() started', () => {
  const { timers, hold, releases } = setup();
  const controller: HoldController = hold;
  controller.begin('pointer', ['a']);
  assert.equal(controller.isHeld, true);
  controller.release();
  assert.equal(controller.isHeld, false);
  controller.release();
  timers.advance(60_000);
  assert.equal(controller.isHeld, false);
  assert.equal(releases.length, 1);

  // Keys over that pointer wait for it until the cap, then the pointer holds its row until release().
  controller.begin('pointer', ['a']);
  controller.extend(['b']);
  timers.advance(HOLD);
  assert.equal(controller.isHeld, true);
  timers.advance(CAP - HOLD);
  assert.equal(releases.length, 2);
  assert.deepEqual(releases[1]?.ids, ['a', 'b']);
  assert.equal(controller.isHeld, true);
  assert.deepEqual(controller.heldIds, ['a']);
  controller.release();
  assert.equal(controller.isHeld, false);
  assert.equal(releases.length, 3);
  assert.equal(timers.pending, 0);
});

test('a key burst over a resting pointer releases with reason keys', () => {
  const { timers, hold, releases } = setup();
  hold.pointerEnter(['p']);
  assert.equal(hold.reason, 'pointer');
  hold.extend(['a']);
  timers.advance(CAP);
  assert.deepEqual(
    releases.map(r => r.reason),
    ['keys'],
  );
  hold.pointerLeave();
  assert.deepEqual(
    releases.map(r => r.reason),
    ['keys', 'pointer'],
  );
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
  hold.pointerEnter(['b']);
  hold.pointerEnter();
  assert.equal(hold.isHeld, true);
  assert.deepEqual(
    hold.heldIds,
    ['b'],
    'the row under the pointer now, not the one before the hide',
  );
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

const HOME = { kind: 'home' } as const;

async function heldHome() {
  const h = createHarness();
  const w = h.layer.windows.acquire(HOME);
  await h.settle();
  const gate = h.layer.hold('home');
  // What useHold plus useView do: heldIds go to the window as holdIds.
  gate.subscribe(() => w.setHold(1, gate.heldIds));
  const ids = () => [...w.snapshot().ids];
  const first = ids();
  const accountId = (w.snapshot().rows.get(first[0]!) as ThreadRow).accountId;
  let n = 0;
  const mail = async () => {
    n++;
    const { threadId } = await h.control.deliverMail({
      accountId,
      fromName: `Arrival ${n}`,
      from: `arrival${n}@field.example`,
      subject: `Arrival ${n}`,
      body: 'New mail during a hold.',
      lane: 'do',
    });
    await h.control.advanceClock({ ms: 300 });
    await h.settle();
    return threadId;
  };
  return { h, w, gate, ids, first, mail };
}

test('new mail never moves the rows under a pointer resting past the cap', async () => {
  const { h, w, gate, ids, first, mail } = await heldHome();
  try {
    gate.pointerEnter([first[1]!]);
    gate.extend([first[0]!]);
    h.timers.advance(CAP);
    await h.settle();
    assert.equal(gate.isHeld, true);
    assert.equal(w.held, true, 'the pointer-only hold still freezes the window');
    const resting = ids();
    const arrived = await mail();
    assert.deepEqual(ids(), resting, 'the arrival waits');
    gate.pointerLeave();
    await h.settle();
    assert.equal(w.held, false);
    assert.ok(ids().includes(arrived), 'the pointer left: the arrival lands');
  } finally {
    h.close();
  }
});

test('new mail never moves the rows under a pointer resting after Esc', async () => {
  const { h, w, gate, ids, first, mail } = await heldHome();
  try {
    gate.pointerEnter([first[2]!]);
    gate.extend([first[0]!, first[1]!]);
    gate.release();
    await h.settle();
    assert.equal(w.held, true);
    const resting = ids();
    const arrived = await mail();
    assert.deepEqual(ids(), resting);
    h.timers.advance(CAP * 3);
    await h.settle();
    assert.deepEqual(ids(), resting, 'a pointer-only hold has no deadline');
    h.timers.setHidden(true);
    await h.settle();
    assert.ok(ids().includes(arrived), 'a hide lets it land');
  } finally {
    h.close();
  }
});

type Rig = ReturnType<typeof setup>;

interface FuzzStats {
  bursts: number;
  capCloses: number;
  leavesInsideBase: number;
}

const POOL = ['t1', 't2', 't3', 't4', 't5', 't6'];

/** What the fuzz believes the gate was told, and the checks that compare the gate with it. */
class HoldFuzz {
  changes = 0;
  physical = false;
  hidden = false;
  // The pointer as the gate was told: entered and not since forgotten (leave or hide).
  pointer = false;
  pointerRow: Id | null = null;
  // Every row the pointer named since the gate last forgot it.
  pointerRows = new Set<Id>();
  // The open burst: its last key, and the ids its keys pinned.
  keyAt: number | null = null;
  keyIds = new Set<Id>();
  burstCloses = 0;
  seen = 0;
  // Whether this step's action may close what is held, and whether something was held before it.
  mayClose = false;
  wasHeld = false;

  constructor(
    readonly seed: number,
    readonly random: () => number,
    readonly rig: Rig,
    readonly stats: FuzzStats,
  ) {
    rig.hold.subscribe(() => this.changes++);
  }

  fresh() {
    return this.rig.releases.slice(this.seen);
  }

  endBurst(where: string, closes: number) {
    assert.equal(closes, 1, `${where}: a burst closed ${closes} times`);
    this.keyAt = null;
    this.keyIds = new Set();
    this.burstCloses = 0;
  }

  forgetPointer() {
    this.pointer = false;
    this.pointerRow = null;
    this.pointerRows = new Set();
  }

  /** Time alone closes only an open burst, once: base after its last key, or the cap with the pointer resting. */
  checkTimed(where: string, to: number) {
    const timed = this.fresh();
    this.seen = this.rig.releases.length;
    if (this.keyAt === null) {
      assert.equal(timed.length, 0, `${where}: closed with no burst open`);
      return;
    }
    const due: number = this.keyAt + (this.pointer ? CAP : HOLD);
    if (due > to) {
      assert.equal(timed.length, 0, `${where}: closed early`);
      return;
    }
    assert.equal(timed.length, 1, `${where}: closes due at ${due}`);
    assert.equal(timed[0]?.at, due, `${where}: closed at the wrong time`);
    assert.equal(timed[0]?.reason, 'keys');
    for (const id of this.keyIds)
      assert.ok(timed[0]?.ids.includes(id), `${where}: ${id} not closed`);
    if (this.pointer) this.stats.capCloses++;
    this.endBurst(where, this.burstCloses + 1);
  }

  toggleHidden(where: string) {
    this.hidden = !this.hidden;
    this.rig.timers.setHidden(this.hidden);
    if (!this.hidden) return;
    this.forgetPointer();
    this.mayClose = true;
    if (this.keyAt !== null) this.endBurst(where, this.burstCloses + (this.wasHeld ? 1 : 0));
  }

  togglePhysical(where: string, at: number) {
    this.physical = !this.physical;
    if (this.hidden) return;
    if (this.physical) {
      const row = POOL[Math.floor(this.random() * POOL.length)]!;
      this.rig.hold.pointerEnter([row]);
      this.pointer = true;
      this.pointerRow = row;
      this.pointerRows.add(row);
      return;
    }
    this.rig.hold.pointerLeave();
    this.forgetPointer();
    if (this.keyAt !== null && at - this.keyAt < HOLD) {
      // Inside a key's 450 ms the pointer leaving changes nothing now.
      this.stats.leavesInsideBase++;
    } else {
      this.mayClose = true;
      if (this.keyAt !== null) this.endBurst(where, this.burstCloses + 1);
    }
  }

  /** A pointermove re-asserts a resting pointer (after a hide it names the row under it again). */
  pointerMove() {
    if (this.hidden || !this.physical) return;
    if (!this.pointer) {
      this.pointerRow = POOL[Math.floor(this.random() * POOL.length)]!;
      this.pointerRows.add(this.pointerRow);
      this.rig.hold.pointerEnter([this.pointerRow]);
    } else this.rig.hold.pointerEnter();
    this.pointer = true;
  }

  escape(where: string) {
    if (this.hidden) return;
    this.rig.hold.release();
    this.mayClose = true;
    if (this.keyAt !== null) this.endBurst(where, this.burstCloses + 1);
  }

  keys(at: number) {
    if (this.hidden) return;
    const ids = POOL.filter(() => this.random() < 0.3);
    if (this.keyAt === null) this.stats.bursts++;
    if (this.random() < 0.5) this.rig.hold.begin('keys', ids);
    else this.rig.hold.extend(ids);
    this.keyAt = at;
    for (const id of ids) this.keyIds.add(id);
  }

  /** One random action; the roll decides which. */
  act(where: string, at: number) {
    const roll = this.random();
    if (roll < 0.06) this.toggleHidden(where);
    else if (roll < 0.2) this.togglePhysical(where, at);
    else if (roll < 0.3) this.pointerMove();
    else if (roll < 0.34) this.escape(where);
    else this.keys(at);
  }

  /** What must hold now. */
  checkState(where: string, at: number) {
    const { hold, timers } = this.rig;
    const keysHold: boolean = this.keyAt !== null && at - this.keyAt < (this.pointer ? CAP : HOLD);
    assert.equal(hold.isHeld, this.pointer || keysHold, `${where}: isHeld`);
    if (keysHold) {
      assert.equal(hold.reason, 'keys', `${where}: reason`);
      for (const id of this.keyIds)
        assert.ok(hold.heldIds.includes(id), `${where}: ${id} unpinned`);
    } else if (this.pointer) {
      assert.equal(hold.reason, 'pointer', `${where}: reason`);
      assert.equal(timers.pending, 0, `${where}: a pointer-only hold has a timer`);
      if (this.pointerRow !== null)
        assert.ok(
          hold.heldIds.includes(this.pointerRow),
          `${where}: the row under the pointer moves`,
        );
      for (const id of hold.heldIds)
        assert.ok(this.pointerRows.has(id), `${where}: a key pin ${id} outlived its close`);
    } else {
      assert.equal(hold.reason, null);
      assert.deepEqual(hold.heldIds, []);
      assert.equal(timers.pending, 0, `${where}: timer left`);
    }
  }

  step(step: number) {
    const { timers, hold } = this.rig;
    const from = timers.now();
    const to = from + Math.floor(this.random() * 700);
    timers.set(to);
    const where = `seed ${this.seed} step ${step} at ${to}`;
    this.checkTimed(where, to);

    const at = timers.now();
    this.wasHeld = hold.isHeld;
    this.mayClose = false;
    this.act(where, at);
    const acted = this.fresh();
    this.seen = this.rig.releases.length;
    if (this.mayClose && this.wasHeld)
      assert.equal(acted.length, 1, `${where}: Esc, a hide or a leave closes what is held`);
    else assert.equal(acted.length, 0, `${where}: closed without a cause`);
    this.checkState(where, at);
  }

  finish() {
    const { timers, hold } = this.rig;
    if (this.hidden) timers.setHidden(false);
    hold.pointerLeave();
    timers.advance(CAP * 2);
    assert.equal(hold.isHeld, false, `seed ${this.seed}: still held`);
    assert.equal(timers.pending, 0, `seed ${this.seed}: timer left`);
    assert.equal(hold.version, this.changes, `seed ${this.seed}: a change went unheard`);
  }
}

/**
 * The fuzz checks the rule text, not a copy of the gate: after every step, from what happened (keys, the pointer the
 * gate was told about, hides, Esc) and when, it derives whether the list must be held, what must be pinned, and
 * which releases may have happened, and it counts closes per burst.
 */
test('fuzz: keys, pointer moves, hides and Esc follow the rules; one close per burst', () => {
  const stats: FuzzStats = { bursts: 0, capCloses: 0, leavesInsideBase: 0 };
  for (let seed = 1; seed <= RUNS; seed++) {
    const fuzz = new HoldFuzz(seed, seeded(seed), setup(), stats);
    for (let step = 0; step < 60; step++) fuzz.step(step);
    fuzz.finish();
  }
  assert.ok(stats.bursts > RUNS, 'the fuzz made bursts');
  assert.ok(stats.capCloses > 0, 'the fuzz reached the cap under a resting pointer');
  assert.ok(stats.leavesInsideBase > 0, 'the fuzz left inside a key hold');
});
