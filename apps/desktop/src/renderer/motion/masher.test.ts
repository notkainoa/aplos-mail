// The button masher (plan 30 U4): random J, K, arrows, E, L and Z at 0-400 ms
// gaps, with window hides, theme switches, new rows and the pointer entering
// and leaving the list mid-flight. While a hold lasts, every row the hold
// anchored is drawn exactly where it was, and after every press the cursor is
// headed for the focused row's drawn top (layout plus pin). Two seconds after the last key
// nothing may be stuck: no ghost, no animation, no will-change, no pin, no
// pending frame or timer, and the cursor sits on the model's focused row.
// Every animation used a generated duration and easing on transform or opacity.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHoldGate } from '../data/holds';
import { easings, motions } from '../ui/generated/motion';
import { createCursorLayer } from './cursor';
import { FakeEnv, seeded, type FakeElement } from './fakes';
import { createCloser } from './flip';
import { createGhostLayer, MAX_GHOSTS } from './ghost';
import { createRapidTracker } from './rapid';
import { createScheduler } from './scheduler';
import { createThemeFreeze } from './themeFreeze';
import { createTriageMotion } from './triage';

const ROW = 40;
const KEYS = ['j', 'k', 'ArrowDown', 'ArrowUp', 'e', 'l', 'z'] as const;
const DOWN = new Set<string>(['j', 'ArrowDown']);
const MOVES = new Set<string>(['j', 'k', 'ArrowDown', 'ArrowUp']);

const generatedDurations = new Set<number>(
  Object.values(motions).flatMap(m => [
    ...Object.values(m.durations),
    ...Object.values(m.rapid),
    ...Object.values(m.reduced),
  ]),
);
const generatedEasings = new Set<string>([easings.linear.css]);
for (const m of Object.values(motions) as readonly { curve: string | null; curveOut?: string }[]) {
  if (m.curve) generatedEasings.add(m.curve);
  if (m.curveOut) generatedEasings.add(m.curveOut);
}

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
  const cursorEl = fake.element();
  const cursor = createCursorLayer(cursorEl.el, scheduler);
  const triage = createTriageMotion({
    scheduler,
    ghosts,
    hold,
    rapid: createRapidTracker(),
    closer,
    cursor,
  });
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
  let focus = rows[0] ?? '';
  const removed: { id: string; index: number }[] = [];
  let lastKeyAt = -Infinity;
  let maxActive = 0;
  let pointerInside = false;
  let heldChecks = 0;
  // What the screen showed when the current hold first changed the list.
  let anchored: Map<string, number> | null = null;
  hold.onRelease(() => {
    anchored = null;
  });

  const change = (after: string[]) => {
    if (hold.isHeld && !anchored) anchored = new Map(rows.map((id, i) => [id, i * ROW]));
    const before = rows;
    rows = after;
    return { before, after };
  };
  const focusAt = () => Math.max(0, rows.indexOf(focus));
  const drawnTop = (id: string) => {
    const pin = /^translateY\(([-\d.e]+)px\)$/.exec(elements.get(id)?.style.transform ?? '');
    return rows.indexOf(id) * ROW + (pin ? Number(pin[1]) : 0);
  };
  let cursorHeldChecks = 0;

  for (let press = 0; press < presses; press++) {
    fake.advance(Math.floor(random() * 401));
    const roll = random();
    if (roll < 0.04) {
      fake.setHidden(!fake.hidden);
      // A resting pointer re-asserts itself on its next pointermove after a hide.
      if (!fake.hidden && pointerInside) hold.pointerEnter();
    } else if (roll < 0.06) freeze.switchTheme(() => {});
    else if (roll < 0.09) {
      const id = `t${serial++}`;
      triage.relayout(change([...rows, mount(id, rows.length)]));
    } else if (roll < 0.14) {
      if (pointerInside) hold.pointerLeave();
      else hold.pointerEnter();
      pointerInside = !pointerInside;
    }
    if (fake.hidden) continue;

    const key = KEYS[Math.floor(random() * KEYS.length)] ?? 'j';
    const repeat = fake.now - lastKeyAt < 35;
    lastKeyAt = fake.now;
    if (MOVES.has(key)) {
      const at = Math.max(0, Math.min(rows.length - 1, focusAt() + (DOWN.has(key) ? 1 : -1)));
      focus = rows[at] ?? focus;
      triage.focus(rows, focus, { cause: repeat ? 'repeat' : 'key' });
    } else if (key === 'e' || key === 'l') {
      const at = focusAt();
      const id = rows[at];
      if (id === undefined) continue;
      const element = elements.get(id) ?? null;
      const after = rows.filter(r => r !== id);
      // The hold starts inside commit(); the screen it keeps is the one before this key.
      if (!anchored) anchored = new Map(rows.map((r, i) => [r, i * ROW]));
      const delta = change(after);
      removed.push({ id, index: at });
      elements.delete(id);
      focus = rows[Math.min(at, rows.length - 1)] ?? '';
      triage.commit({
        kind: key === 'e' ? 'done' : 'later',
        surface: random() < 0.5 ? 'letter' : 'row',
        element: element?.el ?? null,
        holdIds: rows.slice(Math.max(0, at - 2), at + 3),
        rows: delta,
        decorate: clone => ({ chip: clone.querySelector('[data-chip]') as HTMLElement }),
        focus: focus === '' ? undefined : focus,
      });
    } else {
      const last = removed.pop();
      if (!last) continue;
      const index = Math.min(last.index, rows.length);
      triage.relayout(
        change([...rows.slice(0, index), mount(last.id, index), ...rows.slice(index)]),
      );
      focus = last.id;
      triage.focus(rows, focus);
    }

    maxActive = Math.max(maxActive, ghosts.active.length);
    assert.ok(ghosts.active.length <= MAX_GHOSTS, `seed ${seed}: too many ghosts`);
    assert.equal(host.children.length, ghosts.active.length, `seed ${seed}: stray clone`);
    assert.equal(new Set(ghosts.active.map(g => g.clone)).size, ghosts.active.length);
    if (rows.includes(focus)) {
      assert.equal(
        cursor.target[1],
        drawnTop(focus),
        `seed ${seed} press ${press}: cursor off the focused row's drawn top`,
      );
      if (hold.isHeld) cursorHeldChecks += 1;
    }
    if (hold.isHeld && anchored) {
      rows.forEach(id => {
        const top = anchored?.get(id);
        if (top === undefined) return;
        assert.equal(drawnTop(id), top, `seed ${seed} press ${press}: ${id} moved during the hold`);
        heldChecks += 1;
      });
    }
  }

  if (fake.hidden) fake.setHidden(false);
  if (pointerInside) hold.pointerLeave();
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
    cursor,
    everyElement,
    cursorEl,
    elements,
    maxActive,
    closes,
    heldChecks,
    cursorHeldChecks,
    cursorY: focusAt() * ROW,
  };
}

test('button masher: nothing stuck or duplicated two seconds after the last key', () => {
  let capHits = 0;
  let closes = 0;
  let heldChecks = 0;
  let cursorHeldChecks = 0;
  for (let seed = 1; seed <= 120; seed++) {
    const r = mash(seed, 60);
    if (r.maxActive === MAX_GHOSTS) capHits += 1;
    closes += r.closes;
    heldChecks += r.heldChecks;
    cursorHeldChecks += r.cursorHeldChecks;
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
    assert.equal(r.cursor.position[1], r.cursorY, `seed ${seed}: cursor off the focused row`);
    assert.equal(r.cursorEl.style.transform, `translate(0px, ${r.cursorY}px)`);
    assert.equal(
      r.fake.document.documentElement.hasAttribute('data-theme-switching'),
      false,
      `seed ${seed}: theme still frozen`,
    );
    for (const animation of r.fake.animations) {
      assert.ok(
        generatedDurations.has(Number(animation.options.duration)),
        `seed ${seed}: duration ${String(animation.options.duration)} is not generated`,
      );
      assert.ok(
        generatedEasings.has(String(animation.options.easing)),
        `seed ${seed}: easing ${String(animation.options.easing)} is not generated`,
      );
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
  assert.ok(heldChecks > 0, 'the fuzz checked rows during holds');
  assert.ok(cursorHeldChecks > 0, 'the fuzz checked the cursor during holds');
});
