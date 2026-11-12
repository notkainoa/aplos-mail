import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import type { ReturnPoint } from '../../shell/store-return';
import { useIdCursor } from './useIdCursor';

const ORDER = ['a', 'b', 'c', 'd'];

function keyAfterReturn(point: ReturnPoint | null, ids: readonly string[]): string | null {
  let seen: string | null = null;
  renderToString(
    createElement(() => {
      seen = useIdCursor(ids, point).key;
      return null;
    }),
  );
  return seen;
}

const point = (cursorId: string): ReturnPoint => ({ cursorId, order: ORDER, scrollTop: 300 });

test('the cursor starts on the row the reader opened', () => {
  assert.equal(keyAfterReturn(point('c'), ORDER), 'c');
});

test('the opened row was archived while the reader was open: the one that took its place', () => {
  assert.equal(keyAfterReturn(point('b'), ['a', 'c', 'd']), 'c');
  assert.equal(keyAfterReturn(point('d'), ['a', 'b', 'c']), 'c');
});

test('rows still loading: the cursor waits for them instead of falling back to the first row', () => {
  assert.equal(keyAfterReturn(point('c'), []), 'c');
});

test('no saved place: the first row, as before', () => {
  assert.equal(keyAfterReturn(null, ORDER), 'a');
});
