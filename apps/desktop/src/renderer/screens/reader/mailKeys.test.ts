/**
 * A sealed letter's relayed keys reach the reader's commands exactly as typed keys do: the key `sealedMailKey` hands
 * `onKey` is the one `relayToShell` turns into a window keydown, resolved here by the app registry in the reader's
 * stack. Caps Lock J, Shift+J and j all arrive as the letter j with no shift and run "Next email".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { context, keydown, wiredRegistry } from '../../commands/testing';
import { KEY_LAYER_ATTRIBUTE } from '../../mailframe';
import { sealedMailKey, type SealedKeyGate } from '../../mailframe/sealedKeys';
import type { MailFrameKey } from '../../mailframe';
import { FindBar } from './FindBar';

const READER = context(['global', 'list', 'reader']);
const frame = {};
const open: SealedKeyGate = {
  frame: () => frame,
  shown: () => true,
  focused: () => frame,
  layerAbove: () => false,
};

/** The keydown `relayToShell` dispatches for a relayed key. */
function relayed(key: MailFrameKey) {
  return keydown(key.key, { shiftKey: key.shift, altKey: key.alt });
}

function commandOf(payload: object): string | undefined {
  const key = sealedMailKey({ type: 'mail-key', payload }, open);
  assert.ok(key, JSON.stringify(payload));
  return wiredRegistry().resolve(relayed(key), READER)?.commandId;
}

test('j, Caps Lock J and Shift+J from a sealed letter all run Next email; k and K Previous email', () => {
  assert.equal(commandOf({ key: 'j' }), 'reader.nextThread');
  assert.equal(commandOf({ key: 'J' }), 'reader.nextThread');
  assert.equal(commandOf({ key: 'J', shift: false }), 'reader.nextThread');
  assert.equal(commandOf({ key: 'J', shift: true }), 'reader.nextThread');
  assert.equal(commandOf({ key: 'k' }), 'reader.previousThread');
  assert.equal(commandOf({ key: 'K' }), 'reader.previousThread');
});

test('the catalog: a typed Caps Lock J is j; a typed Shift+J is bound to nothing in the reader', () => {
  const registry = wiredRegistry();
  assert.equal(registry.resolve(keydown('J'), READER)?.commandId, 'reader.nextThread');
  assert.equal(registry.resolve(keydown('J', { shiftKey: true }), READER), null);
});

test('Esc from a sealed letter with only the reader open is Go back', () => {
  assert.equal(commandOf({ key: 'Escape' }), 'nav.back');
});

test('the open find bar marks itself as a layer above the reader', () => {
  const html = renderToStaticMarkup(
    createElement(FindBar, { query: '', onChange: () => {}, onClose: () => {}, focusKey: 0 }),
  );
  assert.match(html, new RegExp(`${KEY_LAYER_ATTRIBUTE}="find"`));
});

test('arrows and paging keys from a sealed letter are not routed, though typed on the page they step messages', () => {
  for (const key of ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'])
    assert.equal(sealedMailKey({ type: 'mail-key', payload: { key } }, open), null, key);
  assert.equal(
    wiredRegistry().resolve(keydown('ArrowDown'), READER)?.commandId,
    'reader.nextMessage',
  );
});
