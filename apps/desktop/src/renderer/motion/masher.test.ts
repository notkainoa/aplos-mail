// The button masher (plan 30 U4): random J, K, E, L and Z at 0-400 ms gaps,
// with window hides, theme switches and new rows mid-flight. Two seconds after
// the last key nothing may be stuck: no ghost, no animation, no will-change,
// no pin, no pending frame or timer.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCursorLayer } from './cursor';
import { FakeEnv, seeded, type FakeElement } from './fakes';
import { createCloser } from './flip';
import { createGhostLayer, MAX_GHOSTS } from './ghost';
import { createHoldGate } from './holdGate';
import { createRapidTracker } from './rapid';
import { createScheduler } from './scheduler';
import { createThemeFreeze } from './themeFreeze';
import { createTriageMotion } from './triage';

const ROW = 40;
const KEYS = ['j', 'k', 'e', 'l', 'z'] as const;

function mash(seed: number, presses: number) {
  const random = seeded(seed);
  const fake = new FakeEnv({ reduced: random() < 0.2 });
  const scheduler = createScheduler(fake.env);
  const host = fake.element();
  const list = fake.element();
  const ghosts = createGhostLayer({ scheduler, host: host.el });
  const hold = createHoldGate(scheduler);
  const elements = new Map<string, FakeElement>();
  const everyElement: FakeElement[] = [];
  const closer = createCloser<string>({
    heightOf: () => ROW,
    elementOf: id => elements.get(id)?.el ?? null,
  });
  const triage = createTriageMotion({
    scheduler,
    ghosts,
    hold,
    rapid: createRapidTracker(),
    closer,
  });
  const cursorEl = fake.element();
  const cursor = createCursorLayer(cursorEl.el, scheduler);
  const freeze = createThemeFreeze(fake.document.documentElement.el, scheduler);

  let serial = 0;
  const mount = (id: string, index: number) => {
    const el = fake.element({ left: 0, top: index * ROW, width: 600, height: ROW }, list);
    el.setAttribute('data-row', id);
    const chip = fake.element({}, el);
    chip.setAttribute('data-chip', '');
    elements.set(id, el);
    everyElement.push(el, chip);
    return id;
  };
  let rows = Array.from({ length: 24 }, (_, i) => mount(`t${serial++}`, i));
  const removed: { id: string; index: number }[] = [];
  let at = 0;
  let lastKeyAt = -Infinity;
  let maxActive = 0;

  for (let press = 0; press < presses; press++) {
    fake.advance(Math.floor(random() * 401));
    const roll = random();
    if (roll < 0.04) fake.setHidden(!fake.hidden);
    else if (roll < 0.06) freeze.switchTheme(() => {});
    else if (roll < 0.09) rows = [...rows, mount(`t${serial++}`, rows.length)];
    if (fake.hidden) continue;

    const key = KEYS[Math.floor(random() * KEYS.length)] ?? 'j';
    const repeat = fake.now - lastKeyAt < 35;
    lastKeyAt = fake.now;
    if (key === 'j' || key === 'k') {
      at = Math.max(0, Math.min(rows.length - 1, at + (key === 'j' ? 1 : -1)));
      cursor.move({ y: at * ROW, cause: repeat ? 'repeat' : 'key' });
    } else if (key === 'e' || key === 'l') {
      const id = rows[at];
      if (id === undefined) continue;
      const before = rows;
      rows = rows.filter(r => r !== id);
      removed.push({ id, index: at });
      const element = elements.get(id) ?? null;
      elements.delete(id);
      triage.commit({
        kind: key === 'e' ? 'done' : 'later',
        surface: random() < 0.5 ? 'letter' : 'row',
        element: element?.el ?? null,
        holdIds: rows.slice(Math.max(0, at - 2), at + 3),
        rows: { before, after: rows },
        decorate: clone => ({ chip: clone.querySelector('[data-chip]') as HTMLElement }),
      });
      at = Math.min(at, Math.max(0, rows.length - 1));
      cursor.move({ y: at * ROW, cause: 'key' });
    } else {
      const last = removed.pop();
      if (!last) continue;
      const index = Math.min(last.index, rows.length);
      rows = [...rows.slice(0, index), mount(last.id, index), ...rows.slice(index)];
      at = index;
      cursor.move({ y: at * ROW, cause: 'key' });
    }

    maxActive = Math.max(maxActive, ghosts.active.length);
    assert.ok(ghosts.active.length <= MAX_GHOSTS, `seed ${seed}: too many ghosts`);
    assert.equal(host.children.length, ghosts.active.length, `seed ${seed}: stray clone`);
    assert.equal(new Set(ghosts.active.map(g => g.clone)).size, ghosts.active.length);
  }

  if (fake.hidden) fake.setHidden(false);
  fake.advance(2000);
  const closes = fake.animations.filter(a =>
    String(a.keyframes[0]?.transform).startsWith('translateY('),
  ).length;
  return {
    fake,
    scheduler,
    host,
    ghosts,
    hold,
    closer,
    everyElement,
    cursorEl,
    elements,
    maxActive,
    closes,
  };
}

test('button masher: nothing stuck or duplicated two seconds after the last key', () => {
  let capHits = 0;
  let closes = 0;
  for (let seed = 1; seed <= 120; seed++) {
    const r = mash(seed, 60);
    if (r.maxActive === MAX_GHOSTS) capHits += 1;
    closes += r.closes;
    assert.equal(r.ghosts.active.length, 0, `seed ${seed}: ghost left`);
    assert.equal(r.host.children.length, 0, `seed ${seed}: clone left`);
    assert.equal(r.fake.running().length, 0, `seed ${seed}: animation left`);
    assert.equal(r.hold.isHeld, false, `seed ${seed}: still held`);
    assert.equal(r.closer.pinned.size, 0, `seed ${seed}: row still pinned`);
    assert.equal(r.scheduler.pending, 0, `seed ${seed}: frame or timer pending`);
    for (const el of [...r.everyElement, r.cursorEl, ...r.fake.document.body.descendants()]) {
      assert.equal(el.style.willChange, '', `seed ${seed}: will-change left`);
    }
    for (const el of r.elements.values()) {
      assert.equal(el.style.transform, '', `seed ${seed}: row not at its layout position`);
    }
    for (const animation of r.fake.animations) {
      for (const frame of animation.keyframes) {
        for (const key of Object.keys(frame)) {
          assert.ok(
            ['transform', 'opacity', 'offset'].includes(key),
            `seed ${seed}: animated ${key}`,
          );
        }
      }
    }
    assert.ok(r.fake.animations.length > 0);
  }
  assert.ok(capHits > 0, 'the fuzz reached the ghost cap');
  assert.ok(closes > 0, 'the fuzz ran close');
});
