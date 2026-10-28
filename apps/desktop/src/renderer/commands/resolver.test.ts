import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHoldTracker } from './hold';
import { createKeyQueue } from './keyQueue';
import { parseChord } from './keys';
import { resolve } from './resolver';
import { buildStack } from './stacks';
import { context, keydown, wiredRegistry } from './testing';
import {
  DEFAULT_KEY_PREFS,
  type Binding,
  type ContextName,
  type FocusKind,
  type KeyInput,
} from './types';

import { ASK, CALENDAR, HOME, INLINE_REPLY, READER, TABLE } from './resolver.table';
for (const row of TABLE) {
  test(`resolve: ${row.name}`, () => {
    const prefs = { ...DEFAULT_KEY_PREFS, ...row.prefs };
    const registry = wiredRegistry(prefs);
    const result = registry.resolve(
      row.event,
      context(row.stack, { focus: row.focus, conditions: row.conditions, prefs }),
    );
    assert.equal(result?.commandId ?? null, row.expect);
    if (row.phase) assert.equal(result?.phase, row.phase);
    if (row.expect && row.phase === 'tap') assert.equal(result?.holdCommandId, row.hold);
  });
}

test('resolve without isEnabled treats guarded bindings as unmet', () => {
  const registry = wiredRegistry();
  const result = resolve(keydown('m'), CALENDAR, registry.bindings(), DEFAULT_KEY_PREFS);
  assert.equal(result?.commandId, 'calendar.monthView');
});

test('resolve on raw bindings: a modal context ends the walk', () => {
  const binding = (context: ContextName): Binding => ({
    commandId: `x.${context}`,
    chord: parseChord('e'),
    context,
    phase: 'tap',
    inTextField: false,
    repeat: false,
    followsSwipe: false,
  });
  const bindings = [binding('list')];
  assert.equal(
    resolve(keydown('e'), ['global', 'list'], bindings, DEFAULT_KEY_PREFS)?.commandId,
    'x.list',
  );
  assert.equal(
    resolve(keydown('e'), ['global', 'list', 'dialog'], bindings, DEFAULT_KEY_PREFS),
    null,
  );
});

test('buildStack restores the shapes DESIGN §8 assumes', () => {
  assert.deepEqual(buildStack(['global', 'reader']), ['global', 'list', 'reader']);
  assert.deepEqual(buildStack(['reader']), ['global', 'list', 'reader']);
  assert.deepEqual(buildStack(['global', 'oneByOne', 'reader']), [
    'global',
    'list',
    'reader',
    'oneByOne',
  ]);
  assert.deepEqual(buildStack(['global', 'palette', 'home']), [
    'global',
    'list',
    'home',
    'palette',
  ]);
  assert.deepEqual(buildStack(['global', 'list', 'done', 'reader']), [
    'global',
    'list',
    'done',
    'reader',
  ]);
  assert.deepEqual(buildStack(['onboarding', 'global']), ['onboarding']);
  assert.deepEqual(buildStack(['drill']), ['onboarding', 'firstSync', 'drill']);
  assert.deepEqual(
    buildStack(['firstSync', 'list']),
    ['onboarding', 'firstSync'],
    'the onboarding window keeps only its own contexts',
  );
  assert.deepEqual(
    buildStack(['global', 'list', 'search']),
    ['global', 'search', 'list'],
    'Search is always outside its results',
  );
  assert.deepEqual(buildStack(['global', 'sheet', 'settings']), ['global', 'settings', 'sheet']);
  assert.deepEqual(buildStack(['drill', 'dialog']), ['onboarding', 'firstSync', 'drill', 'dialog']);
});

test('hold tracker: a tap under the threshold stays a tap', () => {
  const tracker = createHoldTracker(250);
  tracker.down(keydown('r'), 'mail.dictateReply', 1000);
  assert.equal(tracker.deadline, 1250);
  assert.equal(tracker.tick(1100), null);
  const release = tracker.up(keydown('r'), 1180);
  assert.deepEqual(release, {
    key: 'r',
    commandId: 'mail.dictateReply',
    phase: 'tap',
    upgraded: false,
    heldMs: 180,
    ended: 'up',
  });
  assert.equal(tracker.armed, false);
});

test('hold tracker: ended says how the hold stopped, whatever the duration', () => {
  const make = () => {
    const tracker = createHoldTracker(250);
    tracker.down(keydown('r'), 'mail.dictateReply', 0);
    tracker.tick(300);
    return tracker;
  };
  const up = make().up(keydown('r'), 2000);
  const cancel = make().cancel(2000);
  const interrupt = make().interrupt(2000);
  const down = make().down(keydown('s'), 'mail.other', 2000);
  assert.deepEqual(
    [up, cancel, interrupt, down].map(r => r?.ended),
    ['up', 'cancel', 'interrupt', 'down'],
  );
  for (const r of [up, cancel, interrupt, down]) {
    assert.equal(r?.phase, 'hold');
    assert.equal(r?.upgraded, true);
  }
});

test('hold tracker: crossing the threshold upgrades once, keyup releases', () => {
  const tracker = createHoldTracker(250);
  tracker.down(keydown('r'), 'mail.dictateReply', 0);
  assert.equal(
    tracker.down(keydown('r', { repeat: true }), 'mail.dictateReply', 40),
    null,
    'auto-repeat is ignored',
  );
  assert.deepEqual(tracker.tick(250), {
    key: 'r',
    commandId: 'mail.dictateReply',
    heldMs: 250,
    removeTyped: false,
  });
  assert.equal(tracker.tick(300), null, 'the upgrade fires once');
  assert.equal(tracker.deadline, null);
  const release = tracker.up(keydown('r'), 900);
  assert.equal(release?.phase, 'hold');
  assert.equal(release?.upgraded, true);
});

test('hold tracker: keyup timing decides when the timer was late', () => {
  const tracker = createHoldTracker(250);
  tracker.down(keydown('a'), 'ask.dictate', 0);
  const release = tracker.up(keydown('a'), 250);
  assert.equal(release?.phase, 'hold');
  assert.equal(release?.upgraded, false, 'no tick fired, so nothing is running');
});

test('hold tracker: another key ends the hold before it upgrades', () => {
  const tracker = createHoldTracker(250);
  tracker.down(keydown('r'), 'mail.dictateReply', 0);
  const ended = tracker.interrupt(100);
  assert.equal(ended?.phase, 'tap');
  assert.equal(tracker.tick(400), null);
  assert.equal(tracker.up(keydown('r'), 500), null);
});

test('hold tracker: a modifier pressed mid-hold still ends the hold on keyup', () => {
  const tracker = createHoldTracker(250);
  tracker.down(keydown('r', { code: 'KeyR' }), 'mail.dictateReply', 0);
  assert.ok(tracker.tick(300));
  const release = tracker.up(keydown('R', { code: 'KeyR', shiftKey: true }), 900);
  assert.equal(release?.upgraded, true);
  assert.equal(tracker.armed, false);
  tracker.down(keydown('a'), 'ask.dictate', 1000);
  assert.equal(
    tracker.up(keydown('a', { metaKey: true, altKey: true }), 1400)?.phase,
    'hold',
    'no code: the unmodified key decides',
  );
});

/** Resolves a keydown, then arms the tracker the way Resolution's doc tells the shell to. */
function armFrom(row: {
  stack: ContextName[];
  event: KeyInput;
  focus?: FocusKind;
  conditions?: Record<string, boolean>;
}) {
  const registry = wiredRegistry();
  const ctx = context(row.stack, { focus: row.focus, conditions: row.conditions });
  const result = registry.resolve(row.event, ctx);
  assert.ok(result);
  const tracker = createHoldTracker(250);
  const holdId = result.phase === 'tap' ? result.holdCommandId : result.commandId;
  assert.ok(holdId);
  tracker.down(row.event, holdId, 0, { typed: result.phase === 'hold' && row.focus === 'text' });
  return { registry, ctx, tracker, result };
}

test('auto-repeats of an armed hold are swallowed: R, A and Space never type into the new field', () => {
  const cases = [
    { stack: READER, event: keydown('r', { code: 'KeyR' }), then: INLINE_REPLY },
    { stack: HOME, event: keydown('a', { code: 'KeyA' }), then: ASK },
    { stack: ASK, event: keydown('a', { code: 'KeyA' }), focus: 'text' as const, then: ASK },
    {
      stack: INLINE_REPLY,
      event: keydown(' ', { code: 'Space' }),
      focus: 'text' as const,
      conditions: { emptyBody: true },
      then: INLINE_REPLY,
    },
  ];
  for (const c of cases) {
    const { tracker } = armFrom(c);
    const repeat = { ...c.event, repeat: true };
    assert.equal(tracker.swallows(repeat), true, `${c.event.key} repeat is swallowed`);
    assert.equal(tracker.swallows(keydown('j', { code: 'KeyJ' })), false, 'other keys are not');
    tracker.up(c.event, 600);
    assert.equal(tracker.swallows(repeat), false, 'nothing is swallowed once released');
  }
});

test('a hold in a field reports that the typed character must be removed', () => {
  const { tracker, result } = armFrom({
    stack: INLINE_REPLY,
    event: keydown(' ', { code: 'Space' }),
    focus: 'text',
    conditions: { emptyBody: true },
  });
  assert.equal(result.phase, 'hold');
  assert.equal(tracker.tick(250)?.removeTyped, true);
  const tap = armFrom({ stack: READER, event: keydown('r', { code: 'KeyR' }) });
  assert.equal(tap.tracker.tick(250)?.removeTyped, false, 'R ran on keydown and typed nothing');
});

test('key queue buffers during a transition and drains in order', () => {
  const queue = createKeyQueue<string>();
  assert.equal(queue.offer('j'), false, 'idle: dispatch now');
  queue.begin();
  queue.begin();
  assert.equal(queue.offer('e'), true);
  assert.equal(queue.offer('e'), true);
  queue.end();
  assert.deepEqual(queue.drain(), [], 'still inside the outer transition');
  queue.end();
  assert.equal(queue.offer('j'), true, 'queues behind waiting keys so nothing overtakes');
  assert.deepEqual(queue.drain(), ['e', 'e', 'j']);
  assert.equal(queue.offer('k'), false);
});

test('key queue dispatches rather than drops past its limit', () => {
  const queue = createKeyQueue<number>(2);
  queue.begin();
  assert.equal(queue.offer(1), true);
  assert.equal(queue.offer(2), true);
  assert.equal(queue.offer(3), false);
});
