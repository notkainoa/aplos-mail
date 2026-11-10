/**
 * The sender's avatar square in the card header (owner sketch 2026-11-10): the sender's initial, drawn by CSS from a data
 * attribute, hidden from assistive tech, never an image.
 * Run: cd apps/desktop && npx tsx --test src/renderer/screens/reader/senderMark.test.tsx
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Message } from '../../data';
import { SenderMark } from './SenderMark';

const ME = new Set(['alex@studio.example']);
const render = (from: Message['from']) =>
  renderToStaticMarkup(createElement(SenderMark, { message: { from } as Message, me: ME }));

test('the mark is the sender’s initial, aria-hidden, with no image', () => {
  const html = render({ name: 'nick bushak', address: 'nick@boxes.example' });
  assert.match(html, /class="aplos-sender-mark" aria-hidden="true" data-mark="N"/);
  assert.doesNotMatch(html, /<img|<svg/);
  assert.match(render({ name: '', address: 'zed@x.example' }), /data-mark="Z"/);
  assert.match(render(undefined), /data-mark="\?"/);
});
