import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMenuModel,
  createPause,
  formatClock,
  MENU_BAR_TITLE,
  PAUSE_MS,
} from '../../src/host/menu-bar';

/** Sparkle, star, wand and magic-sparkle code points: none may appear anywhere in the menu-bar item. */
const sparkle = /[✦-✩★☆✳✴❇✨\u{1F4AB}\u{1FA84}\u{1F31F}\u{1F320}\u{2B50}]/u;

const items = (model: ReturnType<typeof buildMenuModel>) =>
  model.flatMap(entry => (entry.type === 'item' ? [entry] : []));

test('the menu has exactly the four entries, the status line disabled, and no sparkle glyph', () => {
  const model = buildMenuModel({ busy: false }, undefined);
  assert.deepEqual(
    items(model).map(item => [item.id, item.label, item.enabled]),
    [
      ['status', 'Caught up', false],
      ['open', 'Open Aplos', true],
      ['pause', 'Pause sync for 1 hour', true],
      ['quit', 'Quit Aplos completely', true],
    ],
  );
  for (const text of [MENU_BAR_TITLE, ...items(model).map(item => item.label)])
    assert.doesNotMatch(text, sparkle);
});

test('the status line follows the engine, and a pause turns the toggle into Resume sync', () => {
  const label = (sync: Parameters<typeof buildMenuModel>[0], until?: number) =>
    items(buildMenuModel(sync, until)).map(item => item.label);
  assert.equal(label({ busy: true })[0], 'Syncing…');
  assert.equal(label({ busy: false, error: 'raw provider text' })[0], 'Sync needs attention');
  assert.equal(label(undefined)[0], 'Starting…');
  const until = new Date(2026, 9, 30, 14, 5).getTime();
  assert.deepEqual(label({ busy: false }, until).slice(0, 3), [
    'Paused until 14:05',
    'Open Aplos',
    'Resume sync',
  ]);
  assert.equal(formatClock(until), '14:05');
});

test('a pause lasts an hour and Resume ends it early', () => {
  let now = 1_000;
  const pause = createPause(() => now);
  assert.equal(pause.active(), false);
  pause.start();
  assert.equal(pause.until(), 1_000 + PAUSE_MS);
  now += PAUSE_MS - 1;
  assert.equal(pause.active(), true);
  now += 1;
  assert.equal(pause.active(), false);
  pause.start();
  pause.resume();
  assert.equal(pause.active(), false);
});
