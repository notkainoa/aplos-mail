import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  chordFromEvent,
  chordId,
  focusKindOf,
  formatAlternatives,
  formatBinding,
  formatChord,
  holdKeyOf,
  parseChord,
} from './keys';
import type { KeyInput } from './types';

function key(k: string, mods: Partial<KeyInput> = {}): KeyInput {
  return { key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods };
}

test('parseChord normalizes spec strings', () => {
  assert.equal(chordId(parseChord('meta+k')), 'meta+k');
  assert.equal(chordId(parseChord('shift+r')), 'shift+r');
  assert.equal(chordId(parseChord('meta+alt+l')), 'alt+meta+l');
  assert.equal(chordId(parseChord('alt+ArrowDown')), 'alt+ArrowDown');
  assert.equal(chordId(parseChord('Return')), 'Enter');
  assert.equal(chordId(parseChord('?')), '?');
  assert.equal(chordId(parseChord('+')), '+');
  assert.throws(() => parseChord('mod+k'), /Unknown modifier/);
  assert.throws(() => parseChord('shift+/'), /shifted symbol/);
  assert.throws(() => parseChord('shift+1'), /shifted symbol/);
  assert.equal(
    chordId(parseChord('ctrl+shift+1')),
    'ctrl+shift+1',
    'under ⌃ the digit keeps shift',
  );
  assert.throws(() => parseChord('meta+Banana'), /Unknown key/);
});

test('chordFromEvent ignores Caps Lock and reads shift from shiftKey', () => {
  assert.equal(chordId(chordFromEvent(key('E'))!), 'e', 'Caps Lock on, no shift');
  assert.equal(chordId(chordFromEvent(key('A', { shiftKey: true }))!), 'shift+a');
  assert.equal(
    chordId(chordFromEvent(key('a', { shiftKey: true }))!),
    'shift+a',
    'Caps Lock plus shift',
  );
});

test('chordFromEvent keeps shifted symbols as the symbol', () => {
  assert.equal(chordId(chordFromEvent(key('?', { shiftKey: true, code: 'Slash' }))!), '?');
  assert.equal(chordId(chordFromEvent(key('#', { shiftKey: true, code: 'Digit3' }))!), '#');
  assert.equal(chordId(chordFromEvent(key('Tab', { shiftKey: true }))!), 'shift+Tab');
});

test('chordFromEvent falls back to the physical key for Option and non-Latin layouts', () => {
  assert.equal(
    chordId(chordFromEvent(key('¬', { metaKey: true, altKey: true, code: 'KeyL' }))!),
    'alt+meta+l',
  );
  assert.equal(chordId(chordFromEvent(key('Dead', { altKey: true, code: 'KeyE' }))!), 'alt+e');
  assert.equal(chordId(chordFromEvent(key('о', { code: 'KeyJ' }))!), 'j');
  assert.equal(chordId(chordFromEvent(key('&', { ctrlKey: true, code: 'Digit1' }))!), 'ctrl+1');
});

test('the digit row falls back to the physical digit only under ⌘ or ⌃, keeping shift', () => {
  assert.equal(
    chordId(chordFromEvent(key('!', { ctrlKey: true, shiftKey: true, code: 'Digit1' }))!),
    'ctrl+shift+1',
  );
  assert.equal(chordId(chordFromEvent(key('§', { shiftKey: true, code: 'Digit3' }))!), '§');
  assert.equal(chordId(chordFromEvent(key('é', { code: 'Digit2' }))!), 'é');
  assert.equal(chordId(chordFromEvent(key('&', { code: 'Digit1' }))!), '&');
  assert.equal(chordId(chordFromEvent(key('1', { shiftKey: true, code: 'Digit1' }))!), '1');
});

test('holdKeyOf names the physical key, whatever modifiers are down', () => {
  assert.equal(holdKeyOf(key('r', { code: 'KeyR' })), 'r');
  assert.equal(holdKeyOf(key('R', { code: 'KeyR', shiftKey: true })), 'r');
  assert.equal(holdKeyOf(key('®', { code: 'KeyR', altKey: true })), 'r');
  assert.equal(holdKeyOf(key(' ', { code: 'Space' })), 'Space');
  assert.equal(holdKeyOf(key('A', { shiftKey: true })), 'a');
});

test('chordFromEvent returns null for composition and lone modifiers', () => {
  assert.equal(chordFromEvent(key('a', { isComposing: true })), null);
  assert.equal(chordFromEvent(key('Process')), null);
  assert.equal(chordFromEvent(key('Shift', { shiftKey: true })), null);
  assert.equal(chordFromEvent(key('CapsLock')), null);
  assert.equal(chordFromEvent(key('Meta', { metaKey: true })), null);
});

test('formatChord draws macOS keycaps', () => {
  const cases: Array<[string, string]> = [
    ['meta+k', '⌘K'],
    ['ctrl+1', '⌃1'],
    ['shift+a', '⇧A'],
    ['alt+ArrowDown', '⌥↓'],
    // DESIGN §8 and the mockups draw ⌘ first.
    ['meta+alt+l', '⌘⌥L'],
    ['meta+alt+r', '⌘⌥R'],
    ['meta+shift+Enter', '⌘⇧Return'],
    ['meta+shift+c', '⌘⇧C'],
    ['meta+shift+a', '⌘⇧A'],
    ['ctrl+shift+1', '⌃⇧1'],
    ['Space', 'Space'],
    ['Enter', 'Return'],
    ['Escape', 'Esc'],
    ['Backspace', '⌫'],
    ['meta+/', '⌘/'],
    ['#', '#'],
  ];
  for (const [spec, shown] of cases) assert.equal(formatChord(parseChord(spec)), shown, spec);
});

test('alternatives join with "or", holds say Hold, digit runs read as a range', () => {
  const tap = (s: string) => ({ chord: parseChord(s), phase: 'tap' as const });
  assert.equal(formatAlternatives([tap('j'), tap('ArrowDown')]), '↓ or J');
  assert.equal(
    formatAlternatives([tap('e'), tap('ArrowRight')]),
    '→ or E',
    'arrow first, then the letter',
  );
  assert.equal(formatAlternatives([tap('l'), tap('ArrowLeft')]), '← or L');
  assert.equal(formatBinding({ chord: parseChord('r'), phase: 'hold' }), 'Hold R');
  assert.equal(formatAlternatives(['1', '2', '3', '4', '5'].map(tap)), '1–5');
  assert.equal(formatAlternatives([tap('1'), tap('3'), tap('4')]), '1 or 3 or 4');
});

test('focusKindOf tells text fields from controls', () => {
  assert.equal(focusKindOf({ tagName: 'INPUT', type: 'search' }), 'text');
  assert.equal(focusKindOf({ tagName: 'INPUT', type: 'checkbox' }), 'control');
  assert.equal(focusKindOf({ tagName: 'TEXTAREA' }), 'text');
  assert.equal(focusKindOf({ tagName: 'DIV', isContentEditable: true }), 'text');
  assert.equal(focusKindOf({ tagName: 'BUTTON' }), 'control');
  assert.equal(focusKindOf({ tagName: 'DIV', getAttribute: () => 'listbox' }), 'none');
  assert.equal(focusKindOf(null), 'none');
});
