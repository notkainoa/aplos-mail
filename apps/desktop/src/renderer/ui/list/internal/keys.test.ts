// keycapFor: the first tap key a button shows (DESIGN §8). For Done and Later that is the triage arrow,
// which also follows the owner's swipe-direction preference.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAppRegistry, DEFAULT_KEY_PREFS } from '../../../commands';
import { keycapFor, tooltipText } from './keys';

test('keycapFor prefers the triage arrow: Done is → and Later is ←', () => {
  assert.equal(keycapFor('mail.done'), '→');
  assert.equal(keycapFor('mail.later'), '←');
});

test('the cap follows the swipe direction when the owner flips it', () => {
  const swapped = createAppRegistry({ ...DEFAULT_KEY_PREFS, swapTriageArrows: true });
  assert.equal(keycapFor('mail.done', swapped), '←');
  assert.equal(keycapFor('mail.later', swapped), '→');
});

test('other commands keep their first tap key, and the tooltip names it', () => {
  assert.equal(keycapFor('mail.suggested'), 'Space');
  assert.equal(keycapFor('mail.bookmark'), 'B');
  assert.equal(tooltipText('Done', 'mail.done'), 'Done · →');
  assert.equal(tooltipText('Later', 'mail.later'), 'Later · ←');
});

test('a remapped chord wins, and a remap that collides is reported and refused', () => {
  const free = createAppRegistry({ ...DEFAULT_KEY_PREFS, keymap: { 'mail.done': ['y'] } });
  assert.equal(keycapFor('mail.done', free), 'Y');
  const clashing = createAppRegistry({
    ...DEFAULT_KEY_PREFS,
    keymap: { 'mail.done': ['j'], 'mail.bookmark': ['k'] },
  });
  const issues = clashing.keymapIssues.filter(i => i.reason === 'conflict');
  assert.deepEqual(
    issues.map(i => i.commandId),
    ['mail.done', 'mail.bookmark'],
    'J is list.down and K is list.up: both remaps are refused and reported',
  );
  assert.equal(keycapFor('mail.done', clashing), '→', 'the refused remap keeps the default keys');
});
