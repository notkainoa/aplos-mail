// keycapFor: the first tap key a button shows (DESIGN §8). For Done and Later that is the triage arrow,
// which also follows the owner's swipe-direction preference.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAppRegistry, DEFAULT_KEY_PREFS } from '../../../commands';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CommandKeysProvider } from '../../buttons-keys/keyHints';
import type { ContextName } from '../../../commands';
import { keycapFor, tooltipText, useKeycapFor, useTooltipText } from './keys';

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

/** Renders `useKeycapFor` and `useTooltipText` under a provider over `registry` and `stack`, as the shell mounts it. */
function caps(registry: ReturnType<typeof createAppRegistry>, stack: readonly ContextName[]) {
  const Probe = (): ReactElement => {
    const tip = useTooltipText();
    const done = useKeycapFor('mail.done');
    return createElement(
      'span',
      null,
      `${done}|${tip('Done', 'mail.done')}|${tip('Esc', undefined, 'Esc')}`,
    );
  };
  const provider = createElement(CommandKeysProvider, {
    describe: (id: string, from?: readonly ContextName[]) => registry.describeKeys(id, from),
    stack,
    children: createElement(Probe),
  });
  return renderToStaticMarkup(provider).replace(/<[^>]*>/g, '');
}

test('the provider path shows the key that works in the stack: E in a plain list, not the Home-only arrow', () => {
  const registry = createAppRegistry();
  assert.equal(caps(registry, ['global', 'list']), 'E|Done · E|Esc · Esc');
  assert.notEqual(caps(registry, ['global', 'list', 'home']).split('|')[0], 'E');
});

test('the provider path follows the swipe swap and remaps', () => {
  const swapped = createAppRegistry({ ...DEFAULT_KEY_PREFS, swapTriageArrows: true });
  assert.equal(caps(swapped, ['global', 'list', 'home']).split('|')[0], '←');
  assert.match(caps(swapped, ['global', 'list', 'home']), /Done · ←/);
  const remapped = createAppRegistry({ ...DEFAULT_KEY_PREFS, keymap: { 'mail.done': ['y'] } });
  assert.equal(caps(remapped, ['global', 'list']), 'Y|Done · Y|Esc · Esc');
});

test('a command the stack turns off has no cap or tooltip key (the reader opened from Done)', () => {
  const registry = createAppRegistry();
  assert.equal(caps(registry, ['global', 'list', 'done', 'reader']), '|Done|Esc · Esc');
});
