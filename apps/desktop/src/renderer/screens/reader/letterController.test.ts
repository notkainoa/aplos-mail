/**
 * The no-blank-sheet double buffer as the reader runs it: a store with a 1.5 s timer over the pure model, driven by
 * manual timers. The previous letter stays until the next one reports ready; the 12 px line shows only after 1.5 s of
 * waiting on one letter; a letter that reports before it is asked for is not lost. Includes a 500-move fuzz with
 * body latency between 0 and 2.5 s that asserts the paper is never empty once a letter has been shown.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createManualTimers } from '../../data/scheduler';
import { createLetterController } from './letterController';

function world() {
  const timers = createManualTimers(0);
  const controller = createLetterController(timers);
  return { timers, controller };
}

test('the first letter is asked for: nothing is shown and no line yet', () => {
  const { controller } = world();
  controller.want('a');
  assert.deepEqual(controller.snapshot().letter, null);
  assert.equal(controller.snapshot().loadingLine, false);
});

test('with a slow body the previous letter stays and the line shows only after 1.5 s', () => {
  const { controller, timers } = world();
  controller.want('a');
  controller.ready('a');
  assert.equal(controller.snapshot().letter, 'a');

  controller.want('b');
  assert.equal(controller.snapshot().letter, 'a', 'J changes the ask, not the paper');
  timers.advance(1499);
  assert.equal(controller.snapshot().loadingLine, false, 'not before 1.5 s');
  assert.equal(controller.snapshot().letter, 'a');
  timers.advance(1);
  assert.equal(controller.snapshot().loadingLine, true, 'at 1.5 s');
  assert.equal(controller.snapshot().letter, 'a', 'and the previous letter is still on paper');

  controller.ready('b');
  assert.equal(controller.snapshot().letter, 'b');
  assert.equal(controller.snapshot().loadingLine, false);
});

test('moving on restarts nothing: the deadline belongs to the letter asked for', () => {
  const { controller, timers } = world();
  controller.want('a');
  controller.ready('a');
  controller.want('b');
  timers.advance(1000);
  controller.want('c');
  timers.advance(1000);
  assert.equal(controller.snapshot().loadingLine, false, 'c has waited 1 s');
  timers.advance(500);
  assert.equal(controller.snapshot().loadingLine, true);
});

test('a letter that reports before it is asked for (a child effect runs first) is not lost', () => {
  const { controller } = world();
  controller.want('a');
  controller.ready('a');
  controller.ready('b');
  controller.want('b');
  assert.equal(controller.snapshot().letter, 'b', 'shown the moment it is asked for');
  assert.deepEqual(controller.snapshot().held, ['b'], 'and the letter that left is dropped');
});

test('asking for the letter already on paper changes nothing and a stale report is dropped', () => {
  const { controller } = world();
  controller.want('a');
  controller.ready('a');
  controller.want('b');
  controller.ready('b');
  controller.want('c');
  assert.deepEqual(controller.snapshot().held, ['b'], 'only the letter on paper stays buffered');
  controller.ready('a');
  controller.want('c');
  assert.equal(controller.snapshot().letter, 'b');
});

test('subscribers hear about a change, once', () => {
  const { controller, timers } = world();
  let heard = 0;
  controller.subscribe(() => heard++);
  controller.want('a');
  controller.ready('a');
  const base = heard;
  controller.want('b');
  controller.want('b');
  assert.equal(heard, base, 'the ask alone changes nothing visible');
  timers.advance(1500);
  assert.equal(heard, base + 1, 'the line turned on');
});

test('probe: A on paper, J, B lands, K never shows A while A is unmounted and unloaded', () => {
  const { controller } = world();
  controller.want('a');
  controller.ready('a');
  controller.want('b');
  controller.ready('b');
  assert.equal(controller.snapshot().letter, 'b');
  assert.deepEqual(
    controller.snapshot().held,
    ['b'],
    'a is unmounted now, so it is no longer held',
  );
  controller.want('a');
  assert.equal(
    controller.snapshot().letter,
    'b',
    'K keeps b on paper until a reports from a fresh mount',
  );
  controller.ready('a');
  assert.equal(controller.snapshot().letter, 'a');
});

test('a landing drops every held letter that is neither on paper nor asked for', () => {
  const { controller } = world();
  controller.want('a');
  controller.ready('a');
  controller.ready('b');
  controller.want('c');
  assert.equal(controller.snapshot().letter, 'a');
  controller.ready('c');
  assert.deepEqual(controller.snapshot().held, ['c']);
});

/**
 * 500 J and K moves with 0 to 2.5 s of body latency. A letter is mounted only while it is on paper or asked for and
 * loses its body when it unmounts, so the model keeps the set of loaded bodies and asserts that the letter on paper is
 * always one of them: never empty, never a fresh mount with no body.
 */
test('fuzz: 500 J and K moves never leave the paper empty or on a letter with no loaded body', () => {
  const { controller, timers } = world();
  let seed = 7;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const ids = Array.from({ length: 12 }, (_, i) => `t${i}`);
  controller.want(ids[0]!);
  controller.ready(ids[0]!);
  let at = 0;
  let asked = ids[0]!;
  const loaded = new Set<string>([ids[0]!]);
  const pending: { id: string; due: number }[] = [];
  const mounted = () => new Set([controller.snapshot().letter, asked]);
  const unmountStale = () => {
    const keep = mounted();
    for (const id of [...loaded]) if (!keep.has(id)) loaded.delete(id);
  };
  let sawLine = false;
  for (let move = 0; move < 500; move++) {
    at = Math.max(0, Math.min(ids.length - 1, at + (random() < 0.6 ? 1 : -1)));
    const id = ids[at]!;
    asked = id;
    controller.want(id);
    unmountStale();
    pending.push({ id, due: timers.now() + Math.floor(random() * 2500) });
    timers.advance(Math.floor(random() * (random() < 0.7 ? 300 : 2000)));
    for (const entry of pending.filter(p => p.due <= timers.now())) {
      if (!mounted().has(entry.id)) continue;
      loaded.add(entry.id);
      controller.ready(entry.id);
      unmountStale();
    }
    for (let i = pending.length - 1; i >= 0; i--)
      if (pending[i]!.due <= timers.now()) pending.splice(i, 1);
    const snap = controller.snapshot();
    assert.notEqual(snap.letter, null, `move ${move}: the paper is never empty`);
    assert.ok(loaded.has(snap.letter!), `move ${move}: ${snap.letter} on paper has a loaded body`);
    if (snap.loadingLine) sawLine = true;
    if (snap.loadingLine)
      assert.notEqual(snap.letter, id, 'the line means the asked-for letter is not on paper');
  }
  assert.ok(sawLine, 'slow bodies did show the line');
});
